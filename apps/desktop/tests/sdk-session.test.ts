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
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
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
  private messageHandler: ((message: string) => void) | null = null;
  private readonly errorHandlers: ((error: Error) => void)[] = [];
  private connected = true;
  private turns = 0;

  get isConnected(): boolean {
    return this.connected;
  }

  async send(message: string): Promise<void> {
    if (!this.connected) throw new Error('Process not connected');
    const frame = JSON.parse(message) as Record<string, unknown>;
    this.sent.push(frame);
    if (frame.type === 'request') this.handle(frame);
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

  private handle(frame: Record<string, unknown>): void {
    const id = String(frame.id);
    const method = String(frame.method);
    const params = (frame.params ?? {}) as Record<string, unknown>;

    switch (method) {
      case 'droid.initialize_session': {
        for (const n of this.initNotifications) this.notify(n);
        this.reply(id, {
          sessionId: this.sessionId,
          session: { messages: [] },
          settings: this.settings,
          availableModels: MODELS,
        });
        return;
      }
      case 'droid.load_session': {
        this.sessionId = String(params.sessionId ?? this.sessionId);
        for (const n of this.initNotifications) this.notify(n);
        this.reply(id, {
          session: { messages: [] },
          settings: this.settings,
          availableModels: MODELS,
          ...(this.cwd ? { cwd: this.cwd } : {}),
        });
        return;
      }
      case 'droid.update_session_settings': {
        if (typeof params.modelId === 'string') this.settings.modelId = params.modelId;
        this.notify({ type: 'settings_updated', requestId: id, settings: this.settings });
        this.reply(id, {});
        return;
      }
      case 'droid.add_user_message': {
        this.turns++;
        this.reply(id, {});
        this.turnScript({
          turnId: String(params.messageId),
          prompt: String(params.text ?? ''),
          transport: this,
        });
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

const open: SdkSession[] = [];

function session(overrides: Partial<ConstructorParameters<typeof SdkSession>[0]> = {}): {
  sdk: SdkSession;
  transport: ScriptedTransport;
  notifications: DroidNotification[];
  exits: (number | null)[];
} {
  const transport = new ScriptedTransport();
  const notifications: DroidNotification[] = [];
  const exits: (number | null)[] = [];
  const sdk = new SdkSession({
    droidPath: '/nonexistent/droid',
    cwd: '/tmp',
    model: 'fake-allowed',
    reasoningEffort: 'medium',
    transport,
    onNotification: (n) => notifications.push(n),
    onExit: (code) => exits.push(code),
    ...overrides,
  });
  open.push(sdk);
  return { sdk, transport, notifications, exits };
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
    // sniffing transport these ~5 frames never reach stream.jsonl.
    expect(notifications.filter((n) => n.type === 'settings_updated')).toHaveLength(1);
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
