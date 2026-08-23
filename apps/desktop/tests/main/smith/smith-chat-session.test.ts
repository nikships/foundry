/**
 * SmithChatSession over the scripted transport: one persistent conversation
 * per project, opened lazily, persisted across restarts, wiped by New chat,
 * and reopened as a successor session on a model switch. The production
 * policy answers the scripted asks, so what Smith may touch is asserted here
 * rather than assumed.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { ScriptedAgent, type ScriptedAsk } from '../../helpers/scripted-transport.js';
import { defineTool } from '../../../src/main/pi/tool-definition.js';
import { ModelNotChosen } from '../../../src/main/pi/transport.js';
import {
  SmithChatSession,
  type SmithChatSessionDeps,
  type SmithToolFactory,
  type SmithTransportRequest,
} from '../../../src/main/smith/chat-session.js';
import type { AgentDef, ReasoningEffort } from '../../../src/shared/types.js';
import type { SmithChatState } from '../../../src/shared/ipc-contract.js';

/** The scripted transport's request shape wants an AgentDef; Smith has none. */
const smithAsAgent: AgentDef = {
  name: 'smith',
  purpose: 'entity-smith chat',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: '',
  userPrompt: '',
  writes: null,
  envelope: 'generic',
  color: '#f60',
};

interface Harness {
  session: SmithChatSession;
  scripted: ScriptedAgent;
  /** Every model the session asked its transport factory for, in order. */
  modelsRequested: string[];
  /** Every reasoning effort it asked for, in the same order. */
  effortsRequested: ReasoningEffort[];
  stateDir: string;
  projectPath: string;
  remake(over?: Partial<SmithChatSessionDeps>): SmithChatSession;
}

function harness(opts: {
  turns?: string[];
  asks?: ScriptedAsk[][];
  stallOnTurns?: number[];
  smithModel?: () => string;
  smithReasoningEffort?: () => ReasoningEffort;
  toolFactories?: SmithToolFactory[];
  scripted?: ScriptedAgent;
}): Harness {
  const projectPath = tempDir('smith-chat-project-');
  const stateDir = tempDir('smith-chat-state-');
  const scripted =
    opts.scripted ??
    new ScriptedAgent(opts.turns ?? ['ok'], [], opts.asks ?? [], {
      ...(opts.stallOnTurns ? { stallOnTurns: opts.stallOnTurns } : {}),
    });
  const modelsRequested: string[] = [];
  const effortsRequested: ReasoningEffort[] = [];

  const deps = (over: Partial<SmithChatSessionDeps> = {}): SmithChatSessionDeps => ({
    scope: { kind: 'project', projectId: 'proj_1', projectPath },
    stateDir,
    smithModel: opts.smithModel ?? (() => 'inherit'),
    ...(opts.smithReasoningEffort ? { smithReasoningEffort: opts.smithReasoningEffort } : {}),
    ...(opts.toolFactories ? { toolFactories: opts.toolFactories } : {}),
    transport: (req: SmithTransportRequest) => {
      modelsRequested.push(req.model);
      effortsRequested.push(req.reasoningEffort);
      return scripted.transport({
        agent: { ...smithAsAgent, reasoningEffort: req.reasoningEffort },
        cwd: req.cwd,
        runId: 'smith-chat',
        onPermission: (ask) => req.onPermission(ask),
        onEvent: req.onEvent,
        onModelWarning: req.onModelWarning,
        phaseId: () => null,
      });
    },
    ...over,
  });

  return {
    session: new SmithChatSession(deps()),
    scripted,
    modelsRequested,
    effortsRequested,
    stateDir,
    projectPath,
    remake: (over) => new SmithChatSession(deps(over)),
  };
}

/** Chat rows carry text; artifact rows do not. Tests reading text mean chat rows. */
function rowText(entry: { kind: string; text?: string } | undefined): string {
  return entry && entry.kind !== 'artifact' && typeof entry.text === 'string' ? entry.text : '';
}

describe('lifecycle', () => {
  it('opens lazily on the first message and reuses the session after', async () => {
    const h = harness({ turns: ['first answer', 'second answer'] });
    expect(h.scripted.sessionOpens).toBe(0);

    const first = await h.session.send('hello');
    expect(first.text).toBe('first answer');
    expect(h.scripted.sessionOpens).toBe(1);

    const second = await h.session.send('again');
    expect(second.text).toBe('second answer');
    // Multi-turn with tool state: the same session answers, nothing reopens.
    expect(h.scripted.sessionOpens).toBe(1);
    expect(h.scripted.turnRequests.map((t) => t.sessionId)).toEqual(['s1', 's1']);
  });

  it('refuses to overlap turns rather than interleaving two prompts', async () => {
    const h = harness({ stallOnTurns: [0] });
    const parked = h.session.send('long question');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(h.session.send('impatient second')).rejects.toThrow(/already running/);
    await h.session.cancel();
    await parked;
  });

  it('cancel ends the turn in flight and keeps the session for the next one', async () => {
    const h = harness({ stallOnTurns: [0], turns: ['', 'after cancel'] });
    const parked = h.session.send('never answered');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.session.cancel();
    const result = await parked;
    expect(result.interrupted).toBe(true);

    const next = await h.session.send('carry on');
    expect(next.text).toBe('after cancel');
    // Interrupt is not disposal: the same session carries the conversation on.
    expect(h.scripted.sessionOpens).toBe(1);
  });

  it('fails the send loudly when the session cannot open', async () => {
    const scripted = new ScriptedAgent(['ok'], [], [], { unavailable: 'no provider signed in' });
    const h = harness({ scripted });
    await expect(h.session.send('hello')).rejects.toThrow(
      /smith chat session start failed: no provider signed in/,
    );
    expect(h.session.snapshot().error).toMatch(/no provider signed in/);
  });

  it('cancel during a lazy open skips the paid turn', async () => {
    const scripted = new ScriptedAgent(['should not run'], [], [], { handshakeDelayMs: 80 });
    const h = harness({ scripted });
    const parked = h.session.send('hello');
    await new Promise((resolve) => setTimeout(resolve, 15));
    await h.session.cancel();
    const result = await parked;
    expect(result.interrupted).toBe(true);
    expect(h.scripted.turnRequests).toHaveLength(0);
  });

  it('cancel is a no-op when no turn is running', async () => {
    const h = harness({});
    await expect(h.session.cancel()).resolves.toBeUndefined();
    await expect(h.session.dispose()).resolves.toBeUndefined();
  });
});

describe('persistence', () => {
  it('persists the session id so a relaunch resumes the same conversation', async () => {
    const h = harness({});
    await h.session.send('hello');
    expect(h.session.currentSessionId).toBe('s1');

    const state = JSON.parse(readFileSync(join(h.stateDir, 'chat-state.json'), 'utf8')) as {
      sessionId: string;
    };
    expect(state.sessionId).toBe('s1');

    // A fresh SmithChatSession (an app relaunch) resumes rather than restarting.
    await h.session.dispose();
    const relaunched = h.remake();
    await relaunched.send('back again');
    expect(relaunched.currentSessionId).toBe('s1');
  });

  it('starts a fresh chat when there is no pointer on disk', async () => {
    const h = harness({});
    expect(existsSync(join(h.stateDir, 'chat-state.json'))).toBe(false);
    expect(h.session.currentSessionId).toBeNull();
  });

  it('treats a corrupt pointer as a fresh chat, not a failure', async () => {
    const h = harness({});
    writeFileSync(join(h.stateDir, 'chat-state.json'), 'not-json{');
    const relaunched = h.remake();
    expect(relaunched.currentSessionId).toBeNull();
    expect(relaunched.snapshot().transcript).toEqual([]);
  });
});

describe('new chat', () => {
  it('disposes the live session and opens a brand-new one', async () => {
    const h = harness({ turns: ['one', 'two'] });
    await h.session.send('hello');
    expect(h.session.currentSessionId).toBe('s1');

    await h.session.newChat();
    expect(h.session.currentSessionId).toBeNull();

    await h.session.send('fresh start');
    // A new session id: the wiped transcript cannot leak into the new chat.
    expect(h.session.currentSessionId).toBe('s2');
    expect(h.scripted.sessionOpens).toBe(2);
  });

  it('clears the persisted pointer, so a relaunch does not resurrect the old chat', async () => {
    const h = harness({});
    await h.session.send('hello');
    await h.session.newChat();
    const state = JSON.parse(readFileSync(join(h.stateDir, 'chat-state.json'), 'utf8')) as {
      sessionId: string | null;
    };
    expect(state.sessionId).toBeNull();
  });
});

describe('model selection', () => {
  it('resolves the model from the global smithModel setting at open', async () => {
    const h = harness({ smithModel: () => 'anthropic/claude-sonnet-4' });
    await h.session.send('hello');
    expect(h.modelsRequested).toEqual(['anthropic/claude-sonnet-4']);
  });

  it('reads the setting per open, so a settings change applies without a restart', async () => {
    let setting = 'provider/first';
    const h = harness({ smithModel: () => setting });
    await h.session.send('hello');
    setting = 'provider/second';
    await h.session.newChat();
    await h.session.send('hello again');
    expect(h.modelsRequested).toEqual(['provider/first', 'provider/second']);
  });

  it('switches mid-conversation via a successor session over the same history', async () => {
    const h = harness({ smithModel: () => 'provider/original', turns: ['one', 'two'] });
    await h.session.send('hello');
    expect(h.session.currentSessionId).toBe('s1');

    await h.session.setModel('provider/switched');
    expect(h.session.model).toBe('provider/switched');

    await h.session.send('continue');
    // The switch reopened a session — model is stated at create and never
    // drifts — but on the SAME session id, so the transcript carries forward.
    expect(h.scripted.sessionOpens).toBe(2);
    expect(h.session.currentSessionId).toBe('s1');
    expect(h.modelsRequested).toEqual(['provider/original', 'provider/switched']);
  });

  it('persists the switch, outliving both the session and the app', async () => {
    const h = harness({ smithModel: () => 'provider/setting' });
    await h.session.send('hello');
    await h.session.setModel('provider/switched');
    await h.session.dispose();

    const relaunched = h.remake();
    expect(relaunched.model).toBe('provider/switched');
  });

  it('treats a switch to the current model as a no-op', async () => {
    const h = harness({ smithModel: () => 'provider/same', turns: ['one', 'two'] });
    await h.session.send('hello');
    await h.session.setModel('provider/same');
    await h.session.send('still here');
    // No successor opened: nothing changed, so nothing was torn down.
    expect(h.scripted.sessionOpens).toBe(1);
  });
});

describe('reasoning effort', () => {
  it('resolves the effort from the global setting at open', async () => {
    const h = harness({ smithReasoningEffort: () => 'high' });
    await h.session.send('hello');
    expect(h.effortsRequested).toEqual(['high']);
    expect(h.session.snapshot().reasoningEffort).toBe('high');
  });

  it('defaults to medium when no setting is supplied', async () => {
    const h = harness({});
    await h.session.send('hello');
    expect(h.effortsRequested).toEqual(['medium']);
  });

  it('reads the setting per open, so a settings change applies without a restart', async () => {
    let setting: ReasoningEffort = 'low';
    const h = harness({ smithReasoningEffort: () => setting });
    await h.session.send('hello');
    setting = 'high';
    await h.session.newChat();
    await h.session.send('hello again');
    expect(h.effortsRequested).toEqual(['low', 'high']);
  });

  it('switches mid-conversation via a successor session over the same history', async () => {
    const h = harness({ smithReasoningEffort: () => 'low', turns: ['one', 'two'] });
    await h.session.send('hello');
    expect(h.session.currentSessionId).toBe('s1');

    await h.session.setReasoningEffort('high');
    expect(h.session.reasoningEffort).toBe('high');

    await h.session.send('continue');
    // The thinking level is stated at create, so a switch reopens — but on the
    // same session id, so the conversation carries forward.
    expect(h.scripted.sessionOpens).toBe(2);
    expect(h.session.currentSessionId).toBe('s1');
    expect(h.effortsRequested).toEqual(['low', 'high']);
  });

  it('lets the turn in flight finish rather than aborting the answer', async () => {
    const h = harness({
      smithReasoningEffort: () => 'low',
      turns: ['the long answer', 'after'],
      stallOnTurns: [0],
    });
    const parked = h.session.send('long question');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await h.session.setReasoningEffort('high');
    // The running turn was opened at 'low' and is not reopened under it.
    expect(h.effortsRequested).toEqual(['low']);

    // Ending the stall the way a finished turn does, not the way a cancel
    // does: the switch must not have closed the transport under it.
    h.scripted.finishStall();
    const result = await parked;
    expect(result.interrupted).toBe(false);
    expect(result.text).toBe('the long answer');

    await h.session.send('next');
    expect(h.effortsRequested).toEqual(['low', 'high']);
  });

  it('clears the override on New chat, so a fresh chat opens at the setting', async () => {
    const h = harness({ smithReasoningEffort: () => 'low' });
    await h.session.setReasoningEffort('max');
    expect(h.session.reasoningEffort).toBe('max');

    await h.session.newChat();
    expect(h.session.reasoningEffort).toBe('low');
    const state = JSON.parse(readFileSync(join(h.stateDir, 'chat-state.json'), 'utf8')) as {
      reasoningEffortOverride: string | null;
    };
    expect(state.reasoningEffortOverride).toBeNull();
  });

  it('persists the switch, outliving both the session and the app', async () => {
    const h = harness({ smithReasoningEffort: () => 'low' });
    await h.session.send('hello');
    await h.session.setReasoningEffort('max');
    await h.session.dispose();

    const relaunched = h.remake();
    expect(relaunched.reasoningEffort).toBe('max');
  });

  it('keeps the header choice to this chat rather than editing the install default', async () => {
    const h = harness({ smithReasoningEffort: () => 'low' });
    await h.session.setReasoningEffort('max');
    expect(h.session.reasoningEffort).toBe('max');

    // A second chat in the same install still opens at the setting: the
    // override lives in this conversation's pointer, not in Settings → Smith.
    const other = harness({ smithReasoningEffort: () => 'low' });
    expect(other.session.reasoningEffort).toBe('low');
  });

  it('treats a switch to the current effort as a no-op', async () => {
    const h = harness({ smithReasoningEffort: () => 'high', turns: ['one', 'two'] });
    await h.session.send('hello');
    await h.session.setReasoningEffort('high');
    await h.session.send('still here');
    expect(h.scripted.sessionOpens).toBe(1);
  });

  it('repairs a stored effort outside the known levels back to the setting', async () => {
    const h = harness({ smithReasoningEffort: () => 'low' });
    writeFileSync(
      join(h.stateDir, 'chat-state.json'),
      JSON.stringify({
        sessionId: null,
        modelOverride: null,
        reasoningEffortOverride: 'ludicrous',
        transcript: [],
      }),
    );
    expect(h.remake().reasoningEffort).toBe('low');
  });

  it('reports the level the model actually ran at, not the one asked for', async () => {
    // The scripted model offers off–high; `max` is clamped to its default.
    const h = harness({ smithReasoningEffort: () => 'max' });
    await h.session.send('hello');
    const snapshot = h.session.snapshot();
    expect(snapshot.reasoningEffort).toBe('max');
    expect(snapshot.activeReasoningEffort).toBe('medium');
  });

  it('reports the requested level before a session exists to clamp it', () => {
    const h = harness({ smithReasoningEffort: () => 'max' });
    expect(h.session.snapshot().activeReasoningEffort).toBe('max');
  });
});

describe('screen context', () => {
  it('rides each turn as standing context, never inside the user message', async () => {
    const h = harness({});
    await h.session.send('why did this fail?', {
      screen: { route: 'runs', entity: { kind: 'run', id: 'run_42' } },
    });
    const turn = h.scripted.turnRequests[0]!;
    expect(turn.text).toBe('why did this fail?');
    expect(turn.systemPrompt).toContain('runs — run run_42');
    expect(turn.text).not.toContain('run_42');
  });

  it('sends no standing context when the caller supplied none', async () => {
    const h = harness({});
    await h.session.send('hello');
    expect(h.scripted.turnRequests[0]!.systemPrompt).toBeUndefined();
  });
});

describe('renderer snapshots', () => {
  it('folds operator and Smith rows into a cloned transcript', async () => {
    const h = harness({ turns: ['Here is the answer.'] });
    await h.session.send('What happened?');

    const snapshot = h.session.snapshot();
    expect(snapshot).toMatchObject({
      projectId: 'proj_1',
      running: false,
      error: null,
    });
    expect(snapshot.transcript.map((entry) => [entry.source, entry.kind, rowText(entry)])).toEqual([
      ['operator', 'text', 'What happened?'],
      ['smith', 'text', 'Here is the answer.'],
    ]);

    const first = snapshot.transcript[0]!;
    if (first.kind !== 'artifact') first.text = 'mutated renderer copy';
    expect(rowText(h.session.snapshot().transcript[0])).toBe('What happened?');
    expect(() => structuredClone(h.session.snapshot())).not.toThrow();
  });

  it('reports a running turn immediately and persists transcript snapshots', async () => {
    const h = harness({ turns: ['', 'after'], stallOnTurns: [0] });
    const parked = h.session.send('Long task');
    expect(h.session.snapshot()).toMatchObject({ running: true, error: null });
    expect(h.session.snapshot().transcript[0]).toMatchObject({
      source: 'operator',
      text: 'Long task',
    });

    await h.session.cancel();
    await parked;
    await h.session.dispose();
    const relaunched = h.remake();
    expect(relaunched.snapshot().transcript[0]).toMatchObject({
      source: 'operator',
      text: 'Long task',
    });
  });

  it('places readiness progress on its own transcript seam', () => {
    const h = harness({});
    h.session.absorbReadinessProgress({
      type: 'phase',
      phase: 'remediating',
      detail: 'Creating an isolated branch',
    });
    h.session.absorbReadinessProgress({
      type: 'entry',
      entry: { id: 'ready-1', kind: 'tool', text: 'npm test', at: 2 },
    });
    h.session.absorbReadinessProgress({
      type: 'entry_update',
      entry: { id: 'ready-1', kind: 'tool', text: 'npm test', at: 2, done: true },
    });

    expect(h.session.snapshot().transcript).toEqual([
      expect.objectContaining({ source: 'readiness', kind: 'note' }),
      { id: 'ready-1', source: 'readiness', kind: 'tool', text: 'npm test', at: 2, done: true },
    ]);
  });

  it('ignores a readiness update whose row was never absorbed', () => {
    const h = harness({});
    h.session.absorbReadinessProgress({
      type: 'entry_update',
      entry: { id: 'ghost', kind: 'tool', text: 'nope', at: 1 },
    });
    expect(h.session.snapshot().transcript).toEqual([]);
  });

  it('pushes cloned snapshots through onChange and records a model warning', async () => {
    const changes: SmithChatState[] = [];
    const warnings: string[] = [];
    const h = harness({});
    const session = h.remake({
      onChange: (state) => changes.push(state),
      onModelWarning: (warning) => warnings.push(warning),
      transport: (req: SmithTransportRequest) => {
        const inner = h.scripted.transport({
          agent: smithAsAgent,
          cwd: req.cwd,
          runId: 'smith-chat',
          onPermission: (ask) => req.onPermission(ask),
          onEvent: req.onEvent,
          onModelWarning: req.onModelWarning,
          phaseId: () => null,
        });
        const start = inner.start.bind(inner);
        inner.start = async (existing) => {
          await start(existing);
          req.onModelWarning('fell back to inherit');
        };
        return inner;
      },
    });
    await session.send('hello');
    expect(changes.length).toBeGreaterThan(0);
    expect(rowText(changes.at(-1)?.transcript[0])).toBe('hello');
    expect(warnings).toEqual(['fell back to inherit']);
    expect(session.snapshot().transcript.some((row) => rowText(row).includes('fell back'))).toBe(
      true,
    );
  });

  it('surfaces the pick-a-model refusal as itself, not as a session crash', async () => {
    const h = harness({});
    const session = h.remake({
      transport: (req: SmithTransportRequest) => {
        const inner = h.scripted.transport({
          agent: smithAsAgent,
          cwd: req.cwd,
          runId: 'smith-chat',
          onPermission: (ask) => req.onPermission(ask),
          onEvent: req.onEvent,
          onModelWarning: req.onModelWarning,
          phaseId: () => null,
        });
        inner.start = () =>
          Promise.reject(new ModelNotChosen('unset', 'No model is selected. Choose one.'));
        return inner;
      },
    });

    await expect(session.send('hello')).rejects.toBeInstanceOf(ModelNotChosen);
    // Wrapped in "smith chat session start failed: …" the actionable sentence
    // would be buried in noise the operator can do nothing with.
    expect(session.snapshot().error).toBe('No model is selected. Choose one.');
  });
});

describe('artifact rows', () => {
  const artifact = {
    id: 'art-1',
    kind: 'agent_design' as const,
    version: 1,
    createdAt: 42,
    warnings: [],
    agent: {
      name: 'planner',
      purpose: 'Plan.',
      model: 'inherit',
      reasoningEffort: 'medium' as const,
      systemPrompt: 's',
      userPrompt: 'u',
      writes: [] as string[],
      envelope: 'plan',
      color: '#5ad2dd',
    },
  };

  it('appends an artifact row, persists it, and restores it on relaunch', async () => {
    const h = harness({});
    h.session.absorbArtifact(artifact);
    expect(h.session.snapshot().transcript).toEqual([
      { id: 'art-1', kind: 'artifact', source: 'smith', artifact, at: 42 },
    ]);
    expect(() => structuredClone(h.session.snapshot())).not.toThrow();

    // Persisted immediately — no turn needs to settle for the card to survive.
    const relaunched = h.remake();
    const restored = relaunched.snapshot().transcript[0]!;
    expect(restored.kind).toBe('artifact');
    if (restored.kind !== 'artifact') throw new Error('expected artifact row');
    expect(restored.artifact).toEqual(artifact);
  });

  it('restores an unsupported artifact version as a readable note, keeping the chat', async () => {
    const h = harness({ turns: ['ok'] });
    await h.session.send('hello');
    h.session.absorbArtifact({ ...artifact, version: 99 });
    await h.session.dispose();

    const relaunched = h.remake();
    const rows = relaunched.snapshot().transcript;
    // The conversation around the bad card survives.
    expect(rows.map((row) => row.kind)).toEqual(['text', 'text', 'note']);
    expect(rowText(rows[2])).toMatch(/could not be restored/);
  });

  it('restores an action receipt intact, with nothing that could re-run it', async () => {
    const h = harness({});
    const receiptArtifact = {
      id: 'rec-1',
      kind: 'action_receipt' as const,
      version: 1,
      createdAt: 99,
      warnings: [],
      receipt: {
        operation: 'merge',
        title: 'merge run',
        target: 'run_7',
        consequences: 'merge the selected run.',
        risk: 'git' as const,
        outcome: 'failed' as const,
        durationMs: 240,
        failure: 'the base moved',
        args: { runId: 'run_7' },
      },
    };
    h.session.absorbArtifact(receiptArtifact);

    const relaunched = h.remake();
    const restored = relaunched.snapshot().transcript[0]!;
    if (restored.kind !== 'artifact') throw new Error('expected artifact row');
    expect(restored.artifact).toEqual(receiptArtifact);
    // A restored receipt is data: the failure survives, and nothing in it is
    // callable, so reading the chat after a relaunch cannot repeat the action.
    for (const value of Object.values(restored.artifact)) {
      expect(typeof value).not.toBe('function');
    }
  });

  it('keeps a new answer from growing into an artifact card', async () => {
    const h = harness({ turns: ['first', 'second'] });
    await h.session.send('one');
    h.session.absorbArtifact(artifact);
    await h.session.send('two');
    const kinds = h.session.snapshot().transcript.map((row) => [row.kind, row.source]);
    expect(kinds).toEqual([
      ['text', 'operator'],
      ['text', 'smith'],
      ['artifact', 'smith'],
      ['text', 'operator'],
      ['text', 'smith'],
    ]);
    expect(rowText(h.session.snapshot().transcript[4])).toBe('second');
  });
});

describe('pluggable tools', () => {
  const listTool = defineTool({
    name: 'smith_list',
    label: 'List entities',
    description: 'list',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () =>
      Promise.resolve({ content: [{ type: 'text' as const, text: '[]' }], details: undefined }),
  });

  it('hands each factory the session scope and registers what it returns', async () => {
    const scopes: Array<{ projectId?: string; cwd: string; scope: unknown }> = [];
    const factory: SmithToolFactory = (ctx) => {
      scopes.push(ctx);
      return [listTool];
    };
    const h = harness({
      toolFactories: [factory],
      asks: [[{ tool: 'smith_list', input: {} }]],
    });
    await h.session.send('what agents exist?');
    expect(scopes).toEqual([
      {
        projectId: 'proj_1',
        cwd: h.projectPath,
        scope: { kind: 'project', projectId: 'proj_1', projectPath: h.projectPath },
      },
    ]);
    // A registered tool's call is allowed by name; the gate on entity writes
    // is the proposal queue inside the tool, not this policy.
    expect(h.scripted.askReplies).toEqual([{ tool: 'smith_list', decision: { outcome: 'allow' } }]);
  });

  it('denies a tool no factory registered — unknown tools fail closed', async () => {
    const h = harness({ asks: [[{ tool: 'mystery_tool', input: {} }]] });
    await h.session.send('try something odd');
    expect(h.scripted.askReplies[0]!.decision.outcome).toBe('deny');
  });
});

describe('the interactive policy', () => {
  it('allows writes anywhere inside the project checkout — git is the undo', async () => {
    const h = harness({
      asks: [
        [{ tool: 'write', input: { path: 'src/anything.ts' }, writeIfAllowed: 'src/anything.ts' }],
      ],
    });
    await h.session.send('edit the code');
    expect(h.scripted.askReplies[0]!.decision.outcome).toBe('allow');
    expect(existsSync(join(h.projectPath, 'src/anything.ts'))).toBe(true);
  });

  it('denies a write outside the checkout, where nothing would revert it', async () => {
    const outside = tempDir('smith-chat-outside-');
    const h = harness({
      asks: [
        [
          {
            tool: 'write',
            input: { path: join(outside, 'escape.txt') },
            // Only written when the policy allows: a leaked deny shows on disk.
            writeIfAllowed: join(outside, 'escape.txt'),
          },
        ],
      ],
    });
    await h.session.send('write somewhere else');
    expect(h.scripted.askReplies[0]!.decision.outcome).toBe('deny');
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
  });

  it('lets commands run — the operator is present and git is the undo', async () => {
    const h = harness({ asks: [[{ tool: 'bash', input: { command: 'ls' } }]] });
    await h.session.send('look around');
    expect(h.scripted.askReplies[0]!.decision.outcome).toBe('allow');
  });
});
