/**
 * SdkSession against a scripted in-memory transport: no child process, no API
 * key, no model. The transport speaks the same frames the real CLI does, so
 * these tests pin the protocol behaviour the SDK sits on top of — including the
 * parts the SDK gets wrong for us (pre-subscription notifications, error turns
 * that look like completed ones).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessExitError, type StringFramedDroidClientTransport } from '@factory/droid-sdk/node';
import { SdkSession } from '../src/main/droid/sdk/session.js';
import { SniffingTransport } from '../src/main/droid/sdk/sniffing-transport.js';
import { EventFolder, toUsageBreakdown } from '../src/main/droid/events.js';
import { evaluate, type PolicyContext } from '../src/main/droid/permissions.js';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import type { PermissionAsk } from '../src/main/droid/client.js';
import type { DroidNotification, TokenUsage } from '../src/main/droid/protocol.js';
import type { PipelineDef } from '../src/shared/types.js';

const ENVELOPE = {
  jsonrpc: '2.0',
  factoryApiVersion: '1.0.0',
  factoryProtocolVersion: '1.151.0',
} as const;

const EFFORTS = ['off', 'low', 'medium', 'high'];
const MODELS = [
  {
    id: 'gpt-fake-default',
    displayName: 'Fake Default',
    shortDisplayName: 'Default',
    modelProvider: 'openai',
    supportedReasoningEfforts: EFFORTS,
    defaultReasoningEffort: 'high',
    isCustom: false,
  },
  {
    id: 'fake-allowed',
    displayName: 'Fake Allowed',
    shortDisplayName: 'Allowed',
    modelProvider: 'anthropic',
    supportedReasoningEfforts: EFFORTS,
    defaultReasoningEffort: 'medium',
    isCustom: false,
  },
];

/** Tool ids as `ToolInfo.id` — the llmId, which is what the complement uses. */
const BUILTIN_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'Edit', 'Create', 'Execute', 'ToolSearch'];

/** The 400 the CLI answers a turn with when the session's model is unknown. */
const INVALID_MODEL_400 =
  '400 {"detail":"Invalid model ID in request body","status":400,"title":"Bad Request"}';

function usage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 1000,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 900,
    thinkingTokens: 10,
    factoryCredits: 42,
    ...overrides,
  };
}

interface Turn {
  /** The client's own turn id; `agent_turn_completed` must echo it back. */
  turnId: string;
  prompt: string;
  transport: ScriptedTransport;
}

type TurnScript = (turn: Turn) => void;

/**
 * A `StringFramedDroidClientTransport` that answers frames from a script
 * instead of a child process (SDK research §7 — the documented test seam).
 */
class ScriptedTransport implements StringFramedDroidClientTransport {
  /** Every frame the client wrote, so the wire itself can be asserted. */
  readonly sent: Record<string, unknown>[] = [];
  sessionId = 'fake-session-1';
  settings: Record<string, unknown> = {
    modelId: 'gpt-fake-default',
    reasoningEffort: 'high',
    autonomyLevel: 'high',
  };
  cwd: string | undefined;
  /** Notifications the CLI emits before `createSession()` resolves. */
  initNotifications: DroidNotification[] = [
    { type: 'settings_updated', settings: { autonomyLevel: 'high' } },
    { type: 'droid_working_state_changed', newState: 'idle' },
  ];
  turnScript: TurnScript = completesWith('{"status":"success"}');
  /** Every tool this session knows about, by `ToolInfo.id`. */
  tools: string[] = [...BUILTIN_TOOLS];
  /** droid's own model list for this session, sniffed off the init response. */
  models: typeof MODELS = MODELS;
  /** Model ids a turn will actually run on; anything else 400s at turn time. */
  runnableModels = new Set(MODELS.map((m) => m.id));
  private disabled: string[] = [];
  private messageHandler: ((message: string) => void) | null = null;
  private readonly errorHandlers: ((error: Error) => void)[] = [];
  private readonly serverRequests = new Map<string, (result: unknown) => void>();
  private connected = true;
  private turns = 0;
  private nextServerId = 1;

  get isConnected(): boolean {
    return this.connected;
  }

  async send(message: string): Promise<void> {
    if (!this.connected) throw new Error('Process not connected');
    const frame = JSON.parse(message) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === 'request') this.handle(frame);
    if (frame.type === 'response') {
      const settle = this.serverRequests.get(String(frame.id));
      if (settle) {
        this.serverRequests.delete(String(frame.id));
        settle(frame.result);
      }
    }
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  framesFor(method: string): Record<string, unknown>[] {
    return this.sent.filter((f) => f.method === method);
  }

  paramsFor(method: string): Record<string, unknown>[] {
    return this.framesFor(method).map((f) => (f.params ?? {}) as Record<string, unknown>);
  }

  emit(frame: Record<string, unknown>): void {
    this.messageHandler?.(JSON.stringify(frame));
  }

  notify(notification: DroidNotification): void {
    this.emit({
      ...ENVELOPE,
      type: 'notification',
      method: 'droid.session_notification',
      params: { sessionId: this.sessionId, notification },
    });
  }

  /** Process death: the sticky error the SDK's ProcessTransport would raise. */
  die(exitCode: number): void {
    this.connected = false;
    const error = new ProcessExitError(
      `Droid process exited unexpectedly (exit code ${exitCode})`,
      {
        exitCode,
      },
    );
    for (const handler of [...this.errorHandlers]) handler(error);
  }

  reply(id: string, result: unknown): void {
    this.emit({ ...ENVELOPE, type: 'response', id, result });
  }

  /**
   * A server-initiated request (permission / ask_user), resolved with whatever
   * the client answers — the wire shape the policy adapter has to produce.
   */
  ask(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `srv-${this.nextServerId++}`;
    return new Promise((resolve) => {
      this.serverRequests.set(id, (result) => resolve((result ?? {}) as Record<string, unknown>));
      this.emit({ ...ENVELOPE, type: 'request', id, method, params });
    });
  }

  /** What `listTools()` would report right now, complement applied. */
  get allowedTools(): string[] {
    // ToolSearch ignores disabledToolIds in the real CLI (spike V2).
    return this.tools.filter((id) => id === 'ToolSearch' || !this.disabled.includes(id));
  }

  get disabledToolIds(): string[] {
    return [...this.disabled];
  }

  private handle(frame: Record<string, unknown>): void {
    const id = String(frame.id);
    const method = String(frame.method);
    const params = (frame.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'droid.initialize_session': {
        if (typeof params.modelId === 'string') this.settings.modelId = params.modelId;
        for (const n of this.initNotifications) this.notify(n);
        this.reply(id, {
          sessionId: this.sessionId,
          session: { messages: [] },
          settings: this.settings,
          availableModels: this.models,
        });
        return;
      }
      case 'droid.load_session': {
        this.sessionId = String(params.sessionId ?? this.sessionId);
        for (const n of this.initNotifications) this.notify(n);
        this.reply(id, {
          session: { messages: [] },
          settings: this.settings,
          availableModels: this.models,
          ...(this.cwd ? { cwd: this.cwd } : {}),
        });
        return;
      }
      case 'droid.update_session_settings': {
        // The CLI accepts an unknown modelId and echoes it back; only a turn
        // finds out. Same for tool ids that do not exist.
        if (typeof params.modelId === 'string') this.settings.modelId = params.modelId;
        if (params.modelId === undefined && 'modelId' in params) delete this.settings.modelId;
        if (typeof params.reasoningEffort === 'string') {
          this.settings.reasoningEffort = params.reasoningEffort;
        }
        if (Array.isArray(params.disabledToolIds)) {
          this.disabled = params.disabledToolIds as string[];
          this.settings.disabledToolIds = [...this.disabled];
        }
        this.notify({ type: 'settings_updated', requestId: id, settings: this.settings });
        this.reply(id, {});
        return;
      }
      case 'droid.list_tools': {
        this.reply(id, {
          tools: this.tools.map((toolId) => ({
            id: toolId,
            llmId: toolId,
            displayName: toolId,
            description: `${toolId} tool`,
            category: 'other',
            defaultAllowed: true,
            currentlyAllowed: this.allowedTools.includes(toolId),
          })),
        });
        return;
      }
      case 'droid.add_user_message': {
        this.turns++;
        this.reply(id, {});
        const turn = {
          turnId: String(params.messageId),
          prompt: String(params.text ?? ''),
          transport: this,
        };
        const model = this.settings.modelId;
        if (typeof model === 'string' && !this.runnableModels.has(model)) {
          rejectsModel(turn);
          return;
        }
        this.turnScript(turn);
        return;
      }
      case 'droid.get_context_stats': {
        this.reply(id, {
          used: 1234,
          remaining: 98_766,
          limit: 100_000,
          accuracy: 'estimated',
          updatedAt: '2026-08-09T00:00:00.000Z',
        });
        return;
      }
      case 'droid.get_context_breakdown': {
        this.reply(id, {
          modelId: 'fake-allowed',
          modelDisplayName: 'Fake Allowed',
          contextBudget: 250_000,
          usedTokens: 14_400,
          freeTokens: 235_600,
          categories: [{ name: 'System prompt', tokens: 1133, colorKey: 'systemPrompt' }],
          skills: [],
          mcpServers: [],
          droids: [],
        });
        return;
      }
      case 'droid.never_answered':
        return;
      default:
        this.reply(id, {});
    }
  }

  get turnCount(): number {
    return this.turns;
  }
}

/** Committed assistant text that deliberately differs from the delta stream. */
function completesWith(text: string, reason = 'completed'): TurnScript {
  return ({ turnId, transport }) => {
    const messageId = `msg-${turnId.slice(0, 6)}`;
    transport.notify({
      type: 'assistant_text_delta',
      messageId,
      blockIndex: 0,
      textDelta: 'thinking out loud…',
    });
    transport.notify({ type: 'assistant_text_complete', messageId, blockIndex: 0 });
    transport.notify({
      type: 'create_message',
      message: {
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text }],
        createdAt: 1,
        updatedAt: 1,
      },
    });
    transport.notify({
      type: 'session_token_usage_changed',
      sessionId: transport.sessionId,
      tokenUsage: usage(),
    });
    transport.notify({
      type: 'agent_turn_completed',
      reason,
      turnId,
      tokenUsage: usage(),
      cumulativeTokenUsage: usage(),
    });
  };
}

/**
 * The turn an unknown model produces: a NON-throwing terminal result carrying
 * the upstream 400, which is the only place the CLI ever rejects a model.
 */
const rejectsModel: TurnScript = ({ turnId, transport }) => {
  transport.notify({
    type: 'error',
    message: INVALID_MODEL_400,
    errorType: 'Error',
    timestamp: '2026-08-09T00:00:00.000Z',
  });
  transport.notify({ type: 'agent_turn_completed', reason: 'error', turnId, tokenUsage: usage() });
};

/** A turn that asks the client something and only finishes once answered. */
function asksThenCompletes(
  method: string,
  params: Record<string, unknown>,
  answers: Record<string, unknown>[],
): TurnScript {
  return (turn) => {
    void turn.transport.ask(method, params).then((answer) => {
      answers.push(answer);
      completesWith('{"status":"success"}')(turn);
    });
  };
}

function execAsk(command: string): Record<string, unknown> {
  return {
    toolUses: [
      {
        toolUse: { type: 'tool_use', id: 'call-perm-1', name: 'Execute', input: { command } },
        confirmationType: 'exec',
        details: { type: 'exec', fullCommand: command, command },
      },
    ],
    options: [
      { label: 'Yes', value: 'proceed_once' },
      { label: 'No', value: 'cancel' },
    ],
  };
}

function writeAsk(filePath: string): Record<string, unknown> {
  return {
    toolUses: [
      {
        toolUse: {
          type: 'tool_use',
          id: 'call-perm-2',
          name: 'Edit',
          input: { file_path: filePath },
        },
        confirmationType: 'edit',
        details: { type: 'edit', filePath, fileName: filePath.split('/').pop() ?? filePath },
      },
    ],
    options: [
      { label: 'Yes', value: 'proceed_once' },
      { label: 'No', value: 'cancel' },
    ],
  };
}

function questionsAsk(questions: Record<string, unknown>[]): Record<string, unknown> {
  return { toolCallId: 'call-ask-1', questions };
}

const POLICY: PolicyContext = {
  worktree: '/repo',
  writes: ['src/'],
  protectedPaths: [],
};

/** Exactly what `AgentSession.decide()` does, minus the tracing. */
function decide(ask: PermissionAsk) {
  const outcome = evaluate(ask, POLICY);
  return outcome.answers ? { ...outcome.decision, answers: outcome.answers } : outcome.decision;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The recompute is scheduled, not synchronous — poll for its effect. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(5);
  }
  throw new Error('condition never became true');
}

const open: SdkSession[] = [];

function session(overrides: Partial<ConstructorParameters<typeof SdkSession>[0]> = {}): {
  sdk: SdkSession;
  transport: ScriptedTransport;
  notifications: DroidNotification[];
  exits: (number | null)[];
  warnings: string[];
} {
  const transport = new ScriptedTransport();
  const notifications: DroidNotification[] = [];
  const exits: (number | null)[] = [];
  const warnings: string[] = [];
  const sdk = new SdkSession({
    droidPath: '/nonexistent/droid',
    cwd: '/tmp',
    model: 'fake-allowed',
    reasoningEffort: 'medium',
    transport,
    onPermission: decide,
    onNotification: (n) => notifications.push(n),
    onExit: (code) => exits.push(code),
    onModelWarning: (warning) => warnings.push(warning),
    // The real lag between mcp_status_changed and the tool showing up in
    // listTools() is ~1s; the tests drive the same code path faster.
    toolRefreshDelayMs: 1,
    ...overrides,
  });
  open.push(sdk);
  return { sdk, transport, notifications, exits, warnings };
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

describe('session lifecycle', () => {
  it('creates a session and learns its id', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    expect(sdk.id).toBe('fake-session-1');
    expect(sdk.alive).toBe(true);
    expect(transport.framesFor('droid.initialize_session')).toHaveLength(1);
    expect(transport.framesFor('droid.load_session')).toHaveLength(0);
  });

  it('resumes an existing session by id instead of creating one', async () => {
    const { sdk, transport } = session();
    await sdk.start('carried-over-session');
    expect(transport.framesFor('droid.initialize_session')).toHaveLength(0);
    const loaded = transport.paramsFor('droid.load_session');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.sessionId).toBe('carried-over-session');
    expect(sdk.id).toBe('carried-over-session');
    const result = await sdk.send('after resume', 5_000);
    expect(result.text).toBe('{"status":"success"}');
  });

  it('spawns at --auto high whatever the session is for', () => {
    const { sdk } = session();
    const args = sdk.spawnArgs();
    expect(args[args.indexOf('--auto') + 1]).toBe('high');
  });

  it('states autonomyLevel high explicitly on a fresh session', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    const init = transport.paramsFor('droid.initialize_session')[0]!;
    expect(init.autonomyLevel).toBe('high');
  });

  it('re-states autonomyLevel on a resumed session, which loads stored settings', async () => {
    const { sdk, transport } = session();
    await sdk.start('carried-over-session');
    // load_session accepts no settings, and omitting autonomyLevel means high
    // by accident rather than by decision — so it is always re-asserted.
    const applied = transport.paramsFor('droid.update_session_settings');
    expect(applied.length).toBeGreaterThan(0);
    for (const params of applied) expect(params.autonomyLevel).toBe('high');
  });

  it('refuses a resumed session whose persisted cwd is not the run worktree', async () => {
    const worktree = mkdtempSync(join(tmpdir(), 'foundry-sdk-worktree-'));
    const { sdk, transport } = session({ cwd: worktree });
    transport.cwd = '/somewhere/else';
    await expect(sdk.start('carried-over-session')).rejects.toThrow(/worktree/);
  });

  it('reports context occupancy for the lane bar', async () => {
    const { sdk } = session();
    await sdk.start();
    expect(await sdk.contextStats()).toMatchObject({ used: 1234, limit: 100_000 });
  });

  it('returns null context stats rather than throwing when the call fails', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    await transport.close();
    expect(await sdk.contextStats()).toBeNull();
  });
});

describe('turns', () => {
  it('returns the committed assistant text, not the delta stream', async () => {
    const { sdk } = session();
    await sdk.start();
    const result = await sdk.send('do the thing', 5_000);
    expect(result.text).toBe('{"status":"success"}');
    expect(result.text).not.toContain('thinking out loud');
    expect(result.reason).toBe('completed');
    expect(result.interrupted).toBe(false);
  });

  it('maps the SDK camelCase usage onto the breakdown the cost rows read', async () => {
    const { sdk } = session();
    await sdk.start();
    const result = await sdk.send('do the thing', 5_000);
    const breakdown = toUsageBreakdown(result.usage);
    expect(breakdown.reported).toBe(true);
    expect(breakdown.cacheReadTokens).toBe(900);
    expect(breakdown.inputTokens).toBe(1000);
    expect(breakdown.credits).toBe(42);
    // Absence is reported honestly rather than as a turn that cost nothing.
    expect(toUsageBreakdown(null).reported).toBe(false);
  });

  it('reuses one session across turns', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    await sdk.send('first', 5_000);
    await sdk.send('second', 5_000);
    expect(sdk.id).toBe('fake-session-1');
    expect(transport.turnCount).toBe(2);
  });

  it('fails the turn when the result reports an error instead of recording an empty one', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    transport.turnScript = ({ turnId, transport: t }) => {
      t.notify({
        type: 'error',
        message: '400 {"detail":"Invalid model ID in request body","status":400}',
        errorType: 'Error',
        timestamp: '2026-08-09T00:00:00.000Z',
      });
      t.notify({ type: 'agent_turn_completed', reason: 'error', turnId, tokenUsage: usage() });
    };
    await expect(sdk.send('bad model', 5_000)).rejects.toThrow(/Invalid model ID/);
  });

  it('surfaces a child that dies mid-turn as an error, not a hang', async () => {
    const { sdk, transport, exits } = session();
    await sdk.start();
    transport.turnScript = ({ transport: t }) => {
      t.notify({ type: 'droid_working_state_changed', newState: 'thinking' });
      setTimeout(() => t.die(7), 5);
    };
    await expect(sdk.send('this kills it', 5_000)).rejects.toThrow(/exit(ed)? code 7|exited/);
    expect(exits).toEqual([7]);
    expect(sdk.alive).toBe(false);
  });

  it('times out with the exact message the fallback logic keys on', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    transport.turnScript = () => {
      // Never completes: no agent_turn_completed for this turn.
    };
    await expect(sdk.send('never answered', 50)).rejects.toThrow('turn timed out after 50ms');
  });

  it('interrupt ends the turn and leaves the session usable', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    transport.turnScript = ({ turnId, transport: t }) => {
      setTimeout(() => {
        t.notify({
          type: 'agent_turn_completed',
          reason: 'cancelled',
          turnId,
          tokenUsage: usage(),
        });
      }, 5);
    };
    const inFlight = sdk.send('long running', 5_000);
    await sdk.interrupt();
    const result = await inFlight;
    expect(result.interrupted).toBe(true);
    expect(transport.framesFor('droid.interrupt_session').length).toBeGreaterThan(0);

    transport.turnScript = completesWith('{"status":"success"}');
    const after = await sdk.send('still usable', 5_000);
    expect(after.text).toBe('{"status":"success"}');
    expect(sdk.id).toBe('fake-session-1');
  });
});

describe('notifications', () => {
  it('forwards the unwrapped notification, not the JSON-RPC envelope', async () => {
    const { sdk, notifications } = session();
    await sdk.start();
    await sdk.send('do the thing', 5_000);
    expect(notifications.some((n) => n.type === 'agent_turn_completed')).toBe(true);
    for (const n of notifications) {
      expect(n).not.toHaveProperty('jsonrpc');
      expect(n).not.toHaveProperty('params');
      expect(typeof n.type).toBe('string');
    }
  });

  it('delivers the init-time notifications that fire before the session resolves', async () => {
    const { sdk, notifications } = session();
    await sdk.start();
    // The SDK can only subscribe after createSession() resolves; without the
    // sniffing transport these ~5 frames never reach stream.jsonl. They must
    // arrive first, and exactly once — later ones come from applying settings.
    expect(notifications.slice(0, 2).map((n) => n.type)).toEqual([
      'settings_updated',
      'droid_working_state_changed',
    ]);
    expect(notifications.filter((n) => n.type === 'droid_working_state_changed')).toHaveLength(1);
  });

  it('does not deliver a notification twice once the session subscribes', async () => {
    const { sdk, transport, notifications } = session();
    await sdk.start();
    transport.notify({ type: 'droid_working_state_changed', newState: 'thinking' });
    expect(notifications.filter((n) => n.type === 'droid_working_state_changed')).toHaveLength(2);
  });

  it('folds tool calls into one span per toolUseId with the final input', async () => {
    const support = mkdtempSync(join(tmpdir(), 'foundry-sdk-trace-'));
    const tracer = new Tracer(
      openDb(projectDbPath(support, 'proj')),
      projectRunsDir(support, 'proj'),
    );
    const pipeline: PipelineDef = {
      id: 'test',
      name: 'test',
      description: 'test pipeline',
      acceptance: { kind: 'all_phases_pass' },
      phases: [],
    };
    const runId = 'run_sdk_session_test';
    tracer.startRun({
      runId,
      projectId: 'proj',
      pipeline,
      request: 'do it',
      engineer: 'tester',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'rpc',
    });
    const phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'd',
    });
    const folder = new EventFolder({ tracer, runId, phaseId, agent: 'builder' });

    const { sdk, transport } = session({ onNotification: (n) => folder.absorb(n) });
    await sdk.start();
    transport.turnScript = ({ turnId, transport: t }) => {
      const callId = 'call_fake_1';
      t.notify({
        type: 'tool_call',
        toolUse: { type: 'tool_use', id: callId, name: 'Execute', input: {} },
      });
      t.notify({
        type: 'tool_call',
        toolUse: { type: 'tool_use', id: callId, name: 'Execute', input: { command: 'bun test' } },
      });
      t.notify({
        type: 'tool_execution_phase_changed',
        toolUseId: callId,
        toolName: 'Execute',
        phase: 'executing',
      });
      t.notify({
        type: 'tool_result',
        toolUseId: callId,
        messageId: 'm',
        content: 'ok',
        isError: false,
      });
      t.notify({ type: 'agent_turn_completed', reason: 'completed', turnId, tokenUsage: usage() });
    };
    await sdk.send('run the tests', 5_000);

    const calls = tracer.eventsAfter(runId, 0).filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('bash: bun test');
    expect(calls[0]!.payload.execPhase).toBe('executing');
    expect(calls[0]!.endedAt).not.toBeNull();
  });
});

describe('context breakdown', () => {
  it('injects its own request and keeps the session healthy afterwards', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    const breakdown = await sdk.contextBreakdown();
    expect(breakdown).toMatchObject({ usedTokens: 14_400, contextBudget: 250_000 });
    expect(breakdown?.categories[0]).toMatchObject({ name: 'System prompt', tokens: 1133 });
    // The SDK's client must never see a response id it did not issue.
    const injected = transport.framesFor('droid.get_context_breakdown');
    expect(injected).toHaveLength(1);
    const after = await sdk.send('still ok', 5_000);
    expect(after.text).toBe('{"status":"success"}');
  });

  it('returns null when the breakdown is unavailable', async () => {
    const { sdk } = session();
    expect(await sdk.contextBreakdown()).toBeNull();
  });

  it('swallows the injected response so the SDK client never sees a foreign id', async () => {
    const transport = new ScriptedTransport();
    const sniffer = new SniffingTransport(transport);
    const seen: string[] = [];
    sniffer.onMessage((message) => seen.push(message));

    const breakdown = await sniffer.request<{ usedTokens: number }>('droid.get_context_breakdown');
    expect(breakdown?.usedTokens).toBe(14_400);
    expect(seen).toHaveLength(0);

    // Frames that are not ours still reach the SDK's handler untouched.
    transport.notify({ type: 'droid_working_state_changed', newState: 'idle' });
    expect(seen).toHaveLength(1);
    await sniffer.close();
  });

  it('gives up on an injected request rather than hanging the caller', async () => {
    const transport = new ScriptedTransport();
    const sniffer = new SniffingTransport(transport);
    expect(await sniffer.request('droid.never_answered', {}, 20)).toBeNull();
    await sniffer.close();
  });
});

describe('permission asks', () => {
  it('answers an allowed ask with proceed_once and lets the turn finish', async () => {
    const answers: Record<string, unknown>[] = [];
    const { sdk, transport } = session({ cwd: '/repo' });
    await sdk.start();
    transport.turnScript = asksThenCompletes(
      'droid.request_permission',
      execAsk('git commit --allow-empty -m probe'),
      answers,
    );
    const result = await sdk.send('needs permission', 5_000);
    expect(answers).toEqual([{ selectedOption: 'proceed_once' }]);
    expect(result.text).toBe('{"status":"success"}');
  });

  it('answers a denied ask with cancel and the policy reason as the comment', async () => {
    const answers: Record<string, unknown>[] = [];
    const { sdk, transport } = session({ cwd: '/repo' });
    await sdk.start();
    transport.turnScript = asksThenCompletes(
      'droid.request_permission',
      writeAsk('/etc/hosts'),
      answers,
    );
    const result = await sdk.send('tries to escape', 5_000);
    expect(answers[0]!.selectedOption).toBe('cancel');
    expect(String(answers[0]!.comment)).toContain('outside the run worktree');
    // A denial ends the ask, not the turn.
    expect(result.text).toBe('{"status":"success"}');
  });

  it('denies a write outside the agent boundary but inside the worktree', async () => {
    const answers: Record<string, unknown>[] = [];
    const { sdk, transport } = session({ cwd: '/repo' });
    await sdk.start();
    transport.turnScript = asksThenCompletes(
      'droid.request_permission',
      writeAsk('/repo/infra/main.tf'),
      answers,
    );
    await sdk.send('writes out of bounds', 5_000);
    expect(answers[0]!.selectedOption).toBe('cancel');
    expect(String(answers[0]!.comment)).toContain('write boundary');
  });

  it('picks a proceed option the ask actually offers', async () => {
    const answers: Record<string, unknown>[] = [];
    const { sdk, transport } = session({ cwd: '/repo' });
    await sdk.start();
    const ask = execAsk('echo hi');
    // The SDK answers `cancel` in place of any selection the ask did not
    // offer, which would silently turn this allow into a deny.
    ask.options = [
      { label: 'Yes, always', value: 'proceed_always' },
      { label: 'No', value: 'cancel' },
    ];
    transport.turnScript = asksThenCompletes('droid.request_permission', ask, answers);
    await sdk.send('needs permission', 5_000);
    expect(answers).toEqual([{ selectedOption: 'proceed_always' }]);
  });
});

describe('ask_user', () => {
  it('answers every question with its first option and never cancels', async () => {
    const answers: Record<string, unknown>[] = [];
    const { sdk, transport } = session({ cwd: '/repo' });
    await sdk.start();
    transport.turnScript = asksThenCompletes(
      'droid.ask_user',
      questionsAsk([
        { index: 0, topic: 'db', question: 'which database?', options: ['postgres', 'mysql'] },
        { index: 1, topic: 'ci', question: 'which CI?', options: ['github', 'gitlab'] },
      ]),
      answers,
    );
    await sdk.send('needs an answer', 5_000);
    expect(answers[0]).toEqual({
      answers: [
        { index: 0, question: 'which database?', answer: 'postgres' },
        { index: 1, question: 'which CI?', answer: 'github' },
      ],
    });
    expect(answers[0]!.cancelled).toBeUndefined();
  });

  it('tells an option-less question to proceed rather than cancelling it', async () => {
    const answers: Record<string, unknown>[] = [];
    const { sdk, transport } = session({ cwd: '/repo' });
    await sdk.start();
    transport.turnScript = asksThenCompletes(
      'droid.ask_user',
      questionsAsk([{ index: 0, topic: 'x', question: 'how?', options: [] }]),
      answers,
    );
    await sdk.send('needs an answer', 5_000);
    expect(answers[0]).toEqual({
      answers: [
        {
          index: 0,
          question: 'how?',
          answer: 'Proceed with your best judgment; do not ask again.',
        },
      ],
    });
  });
});

describe('applySettings', () => {
  it('sends a reasoning effort the model supports', async () => {
    const { sdk, transport } = session({ reasoningEffort: 'low' });
    await sdk.start();
    const efforts = transport
      .paramsFor('droid.update_session_settings')
      .map((p) => p.reasoningEffort)
      .filter((e) => e !== undefined);
    expect(efforts).toContain('low');
  });

  it('drops an effort the model does not support instead of failing the session', async () => {
    const { sdk, transport } = session({ reasoningEffort: 'low' });
    // droid's own list, not Foundry's catalog, decides which efforts exist.
    transport.models = MODELS.map((m) =>
      m.id === 'fake-allowed' ? { ...m, supportedReasoningEfforts: ['high'] } : m,
    );
    await sdk.start();
    for (const params of transport.paramsFor('droid.update_session_settings')) {
      expect(params.reasoningEffort).toBeUndefined();
    }
    expect(transport.paramsFor('droid.initialize_session')[0]!.reasoningEffort).toBeUndefined();
  });

  it('warns before the first turn when the model is not in droid’s own list', async () => {
    const { sdk } = session({ model: 'well-formed-but-unknown' });
    await sdk.start();
    const applied = await sdk.applySettings();
    expect(applied.warning).toContain("not in this session's available models");
    expect(applied.model).toBe('well-formed-but-unknown');
    expect(sdk.alive).toBe(true);
  });

  it('reports no warning for a model droid knows', async () => {
    const { sdk } = session();
    await sdk.start();
    expect((await sdk.applySettings()).warning).toBeUndefined();
  });
});

describe('model substitution at turn time', () => {
  it('keeps the session, retries without the override, and reports the substitute', async () => {
    const { sdk, transport, warnings } = session({ model: 'forbidden-by-policy' });
    await sdk.start();
    // The bad model is accepted everywhere until a turn runs on it.
    expect(transport.paramsFor('droid.update_session_settings').map((p) => p.modelId)).toContain(
      'forbidden-by-policy',
    );
    expect(sdk.alive).toBe(true);

    // Pre-turn: the model is not in droid's list, which is knowable for free.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not in this session's available models");

    const result = await sdk.send('first turn', 5_000);
    expect(result.text).toBe('{"status":"success"}');
    expect(sdk.activeModel).toBe('gpt-fake-default');
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('forbidden-by-policy');
    expect(warnings[1]).toContain('gpt-fake-default');
    expect(transport.turnCount).toBe(2);

    // The substitution is remembered: the next turn does not pay for it again.
    const after = await sdk.send('second turn', 5_000);
    expect(after.text).toBe('{"status":"success"}');
    expect(transport.turnCount).toBe(3);
    expect(warnings).toHaveLength(2);
  });

  it('fails the turn when the substitute is refused too, rather than retrying forever', async () => {
    const { sdk, transport } = session({ model: 'forbidden-by-policy' });
    transport.runnableModels = new Set();
    await sdk.start();
    await expect(sdk.send('doomed', 5_000)).rejects.toThrow(/Invalid model ID/);
    expect(transport.turnCount).toBe(2);
  });

  it('does not substitute for an unrelated turn failure', async () => {
    const { sdk, transport, warnings } = session();
    await sdk.start();
    transport.turnScript = ({ turnId, transport: t }) => {
      t.notify({
        type: 'error',
        message: 'the tool exploded',
        errorType: 'Error',
        timestamp: '2026-08-09T00:00:00.000Z',
      });
      t.notify({ type: 'agent_turn_completed', reason: 'error', turnId, tokenUsage: usage() });
    };
    await expect(sdk.send('boom', 5_000)).rejects.toThrow('the tool exploded');
    expect(warnings).toHaveLength(0);
    expect(transport.turnCount).toBe(1);
  });
});

describe('tool allowlist', () => {
  it('disables the complement of the allowlist and proves it with a re-read', async () => {
    const { sdk, transport } = session({ restrictTools: ['Read', 'Grep'] });
    await sdk.start();
    expect(transport.disabledToolIds.sort()).toEqual(
      ['Create', 'Edit', 'Execute', 'Glob', 'LS', 'ToolSearch'].sort(),
    );
    // ToolSearch ignores disabledToolIds in the real CLI, so the effective set
    // is the allowlist plus ToolSearch — asserted from the re-read, which is
    // the only signal of what actually applied.
    const allowed = (await sdk.listTools()).filter((t) => t.allowed).map((t) => t.id);
    expect(allowed.sort()).toEqual(['Grep', 'Read', 'ToolSearch']);
  });

  it('merges explicitly disabled tools with the complement', async () => {
    const { sdk, transport } = session({
      restrictTools: ['Read', 'Grep', 'Execute'],
      disabledTools: ['Execute'],
    });
    await sdk.start();
    expect(transport.disabledToolIds).toContain('Execute');
    const allowed = (await sdk.listTools()).filter((t) => t.allowed).map((t) => t.id);
    expect(allowed.sort()).toEqual(['Grep', 'Read', 'ToolSearch']);
  });

  it('disables the listed tools when there is no allowlist at all', async () => {
    const { sdk, transport } = session({ disabledTools: ['Execute'] });
    await sdk.start();
    expect(transport.disabledToolIds).toEqual(['Execute']);
    const allowed = (await sdk.listTools()).filter((t) => t.allowed).map((t) => t.id);
    expect(allowed).not.toContain('Execute');
    expect(allowed).toContain('Edit');
  });

  it('re-complements a tool that appears after the MCP server connects', async () => {
    const { sdk, transport } = session({ restrictTools: ['Read', 'Grep'] });
    await sdk.start();

    // The CLI announces the server ~1s before its tools reach list_tools, so a
    // synchronous recompute would look at a stale list and let the tool escape.
    transport.notify({
      type: 'mcp_status_changed',
      servers: [{ name: 'late-mcp', status: 'connected' }],
      summary: { total: 1, connected: 1, connecting: 0, failed: 0, disabled: 0 },
    });
    transport.tools = [...BUILTIN_TOOLS, 'late-mcp___echo'];

    await waitFor(async () =>
      (await sdk.listTools()).some((t) => t.id === 'late-mcp___echo' && !t.allowed),
    );
    expect(transport.disabledToolIds).toContain('late-mcp___echo');
    const allowed = (await sdk.listTools()).filter((t) => t.allowed).map((t) => t.id);
    expect(allowed.sort()).toEqual(['Grep', 'Read', 'ToolSearch']);
  });

  it('re-complements on a settings_updated that reveals a new tool', async () => {
    const { sdk, transport } = session({ restrictTools: ['Read'] });
    await sdk.start();
    transport.tools = [...BUILTIN_TOOLS, 'other___tool'];
    transport.notify({ type: 'settings_updated', settings: transport.settings });

    await waitFor(async () =>
      (await sdk.listTools()).some((t) => t.id === 'other___tool' && !t.allowed),
    );
    expect(transport.disabledToolIds).toContain('other___tool');
  });

  it('does not re-apply settings when nothing about the tool set changed', async () => {
    const { sdk, transport } = session({ restrictTools: ['Read', 'Grep'] });
    await sdk.start();
    const applied = transport.framesFor('droid.update_session_settings').length;
    transport.notify({ type: 'settings_updated', settings: transport.settings });
    await delay(20);
    // A recompute that re-sends its own answer would loop forever.
    expect(transport.framesFor('droid.update_session_settings')).toHaveLength(applied);
  });

  it('leaves the session unrestricted when the roster asks for nothing', async () => {
    const { sdk, transport } = session();
    await sdk.start();
    expect(transport.disabledToolIds).toEqual([]);
    expect(transport.framesFor('droid.list_tools')).toHaveLength(0);
  });
});
