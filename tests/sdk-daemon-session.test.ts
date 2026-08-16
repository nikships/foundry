/**
 * DaemonSession behind TransportSession: scripted daemon connection seam
 * (no real daemon, no API key). Pins V6 routing, daemon replacement semantics
 * (resume successor by newSessionId — opposite of subprocess retire), interrupt
 * survival, context stats via breakdown, autonomy re-assert, and notification
 * parity with the subprocess SdkSession surface.
 */

import { tempDir } from './tmp.js';
import { describe, expect, it } from 'vitest';
import {
  AutonomyLevel,
  ToolConfirmationOutcome,
  type AskUserRequestParams,
  type DroidResultMessage,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import { EventFolder } from '../src/main/droid/events.js';
import { evaluate, type PolicyContext } from '../src/main/droid/permissions.js';
import type { DroidNotification } from '../src/main/droid/protocol.js';
import {
  DaemonSession,
  failClosedAskUserHandler,
  failClosedPermissionHandler,
} from '../src/main/droid/sdk/daemon-session.js';
import type { TransportSession } from '../src/main/droid/sdk/transport.js';
import { ScriptedSessions, resultSuccess, usage } from './scripted-daemon.js';
import type { PermissionAsk, PermissionDecision } from '../src/main/droid/turn.js';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import type { PipelineDef } from '../src/shared/types.js';

function policyFor(worktree: string, writes: string[] | null = ['**/*']): PolicyContext {
  return {
    worktree,
    writes,
    protectedPaths: ['.git', '.foundry'],
  };
}

type ToolUseEntry = RequestPermissionRequestParams['toolUses'][number];

function toolUse(partial: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  details: Record<string, unknown>;
  confirmationType: string;
}): ToolUseEntry {
  return {
    toolUse: {
      type: 'tool_use',
      id: partial.id,
      name: partial.name,
      input: partial.input,
    },
    details: partial.details,
    confirmationType: partial.confirmationType,
  } as ToolUseEntry;
}

function session(
  overrides: {
    cwd?: string;
    model?: string;
    onPermission?: (ask: PermissionAsk) => PermissionDecision | Promise<PermissionDecision>;
    onNotification?: (n: DroidNotification) => void;
    facade?: ScriptedSessions;
  } = {},
): {
  sdk: DaemonSession;
  facade: ScriptedSessions;
  notifications: DroidNotification[];
  decisions: PermissionAsk[];
} {
  const facade = overrides.facade ?? new ScriptedSessions();
  const notifications: DroidNotification[] = [];
  const decisions: PermissionAsk[] = [];
  const onPermission =
    overrides.onPermission ??
    ((ask: PermissionAsk) => {
      decisions.push(ask);
      return evaluate(ask, policyFor(overrides.cwd ?? '/tmp/work-a')).decision;
    });
  const sdk = new DaemonSession({
    cwd: overrides.cwd ?? '/tmp/work-a',
    model: overrides.model ?? 'fake-allowed',
    reasoningEffort: 'high',
    sessions: facade,
    onPermission,
    onNotification: (n) => {
      notifications.push(n);
      overrides.onNotification?.(n);
    },
  });
  return { sdk, facade, notifications, decisions };
}

describe('TransportSession surface', () => {
  it('is implemented by DaemonSession', () => {
    // Compile-time + runtime shape check: the agent-facing methods exist.
    const methods: (keyof TransportSession)[] = [
      'start',
      'send',
      'applySettings',
      'contextStats',
      'contextBreakdown',
      'compact',
      'getRewindInfo',
      'rewind',
      'listTools',
      'interrupt',
      'close',
      'kill',
      'spawnArgs',
    ];
    for (const name of methods) {
      expect(typeof DaemonSession.prototype[name]).toBe('function');
    }
  });
});

describe('autonomy (spike V1)', () => {
  it('hardcodes autonomyLevel high on every create', async () => {
    const { sdk, facade } = session();
    await sdk.start();
    expect(facade.creates).toHaveLength(1);
    expect(facade.creates[0]!.autonomyLevel).toBe(AutonomyLevel.High);
    // machineId is required on daemon create (SDK forces local; we still pass default).
    expect(facade.creates[0]!.machineId).toBe('default');
  });

  it('re-asserts autonomyLevel high after resume', async () => {
    const { sdk, facade } = session();
    await sdk.start();
    const id = sdk.id!;
    await sdk.close();
    // Resume path: start(existingId) must updateSettings with high.
    const resumed = session({ facade });
    await resumed.sdk.start(id);
    const autonomyUpdates = resumed.facade.updateCalls.filter(
      (c) => c.params.autonomyLevel === AutonomyLevel.High || c.params.autonomyLevel === 'high',
    );
    expect(autonomyUpdates.length).toBeGreaterThan(0);
    expect(resumed.sdk.id).toBe(id);
  });
});

describe('permission routing (spike V6 / VAL-DAEMON-005)', () => {
  it("routes concurrent asks to each session's own policy context", async () => {
    const facade = new ScriptedSessions();
    const asksA: PermissionAsk[] = [];
    const asksB: PermissionAsk[] = [];

    // Hold A open so both are concurrent (V6 evidence pattern).
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const sessionA = new DaemonSession({
      cwd: '/tmp/work-a',
      model: 'fake-allowed',
      reasoningEffort: 'high',
      sessions: facade,
      onPermission: async (ask) => {
        asksA.push(ask);
        await gate;
        return evaluate(ask, policyFor('/tmp/work-a', ['src/**'])).decision;
      },
    });
    const sessionB = new DaemonSession({
      cwd: '/tmp/work-b',
      model: 'fake-allowed',
      reasoningEffort: 'high',
      sessions: facade,
      onPermission: (ask) => {
        asksB.push(ask);
        return evaluate(ask, policyFor('/tmp/work-b', ['src/**'])).decision;
      },
    });

    await sessionA.start();
    await sessionB.start();
    const handleA = facade.handle(sessionA.id!)!;
    const handleB = facade.handle(sessionB.id!)!;

    const writeInA: RequestPermissionRequestParams = {
      toolUses: [
        toolUse({
          id: 't1',
          name: 'Edit',
          input: { file_path: '/tmp/work-a/src/a.ts' },
          details: { filePath: '/tmp/work-a/src/a.ts' },
          confirmationType: 'edit',
        }),
      ],
      options: [
        { label: 'Once', value: ToolConfirmationOutcome.ProceedOnce },
        { label: 'Cancel', value: ToolConfirmationOutcome.Cancel },
      ],
      associatedSessionIds: [sessionA.id!],
    };

    const writeOutsideB: RequestPermissionRequestParams = {
      toolUses: [
        toolUse({
          id: 't2',
          name: 'Edit',
          input: { file_path: '/etc/passwd' },
          details: { filePath: '/etc/passwd' },
          confirmationType: 'edit',
        }),
      ],
      options: [
        { label: 'Once', value: ToolConfirmationOutcome.ProceedOnce },
        { label: 'Cancel', value: ToolConfirmationOutcome.Cancel },
      ],
      associatedSessionIds: [sessionB.id!],
    };

    const pendingA = handleA.askPermission(writeInA);
    // B resolves while A is still in flight.
    const resultB = await handleB.askPermission(writeOutsideB);
    releaseA();
    const resultA = await pendingA;

    expect(asksA).toHaveLength(1);
    expect(asksB).toHaveLength(1);
    // A: in-boundary write → proceed; B: out-of-worktree → cancel. Must not cross.
    expect(resultA).toBe(ToolConfirmationOutcome.ProceedOnce);
    expect(resultB).toEqual({
      selectedOption: ToolConfirmationOutcome.Cancel,
      comment: expect.stringMatching(/worktree|outside|deny|denied/i),
    });
    // Per-session handlers received only their own asks (no cross-delivery).
    expect(asksA[0]!.params).toMatchObject({ file_path: '/tmp/work-a/src/a.ts' });
    expect(asksB[0]!.params).toMatchObject({ file_path: '/etc/passwd' });
    // Connection safety-net never fired for attached sessions.
    expect(facade.connectionPermissionCalls).toBe(0);

    await sessionA.close();
    await sessionB.close();
  });

  it('connection safety-net fails closed on unmatched or missing session ids', () => {
    const denied = failClosedPermissionHandler({
      toolUses: [],
      options: [{ label: 'Once', value: ToolConfirmationOutcome.ProceedOnce }],
      // missing associatedSessionIds
    });
    expect(denied).toEqual({
      selectedOption: ToolConfirmationOutcome.Cancel,
      comment: expect.stringMatching(/safety-net|no session|missing/i),
    });
  });

  it('reuses proceedOption so an unoffered selection is never returned bare', async () => {
    const { sdk, facade } = session({
      onPermission: () => ({ outcome: 'allow' }),
    });
    await sdk.start();
    const handle = facade.handle(sdk.id!)!;
    // Ask only offers proceed_always + cancel — proceed_once is NOT offered.
    const result = await handle.askPermission({
      toolUses: [
        toolUse({
          id: 't',
          name: 'Execute',
          input: { command: 'echo hi' },
          details: { command: 'echo hi' },
          confirmationType: 'exec',
        }),
      ],
      options: [
        { label: 'Always', value: ToolConfirmationOutcome.ProceedAlways },
        { label: 'Cancel', value: ToolConfirmationOutcome.Cancel },
      ],
      associatedSessionIds: [sdk.id!],
    });
    // Must pick an offered proceed, never bare ProceedOnce (SDK would cancel it).
    expect(result).toBe(ToolConfirmationOutcome.ProceedAlways);
    await sdk.close();
  });
});

describe('turns (VAL-DAEMON-004 parity pieces)', () => {
  it('prefers committed create_message text and populates usage + reason', async () => {
    const { sdk, facade, notifications } = session();
    await sdk.start();
    const handle = facade.handle(sdk.id!)!;
    handle.turnScript = (h) => {
      h.notify({
        type: 'create_message',
        message: {
          id: 'u1',
          role: 'user',
          content: [{ type: 'text', text: 'prompt' }],
        },
      } as DroidNotification);
      h.notify({
        type: 'assistant_text_delta',
        textDelta: 'delta-wrong',
      } as DroidNotification);
      h.notify({
        type: 'create_message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'text', text: 'committed-right' }],
        },
      } as DroidNotification);
      h.notify({
        type: 'agent_turn_completed',
        reason: 'completed',
        turnId: 't',
        tokenUsage: usage({ inputTokens: 42 }),
      } as DroidNotification);
      // result.text deliberately empty — committed create_message text must win.
      return resultSuccess(h.id, '', usage({ inputTokens: 42 }));
    };
    const result = await sdk.send('prompt', 5_000);
    expect(result.text).toBe('committed-right');
    expect(result.usage?.inputTokens).toBe(42);
    expect(result.reason).toBe('completed');
    expect(result.interrupted).toBe(false);
    const kinds = new Set(notifications.map((n) => n.type));
    expect(kinds.has('create_message')).toBe(true);
    expect(kinds.has('agent_turn_completed')).toBe(true);
    await sdk.close();
  });

  it('feeds EventFolder the same notification vocabulary as subprocess', async () => {
    const support = tempDir('foundry-daemon-sess-');
    const tracer = new Tracer(
      openDb(projectDbPath(support, 'proj')),
      projectRunsDir(support, 'proj'),
    );
    const pipeline: PipelineDef = {
      id: 'test',
      name: 'test',
      description: 't',
      acceptance: { kind: 'all_phases_pass' },
      phases: [],
    };
    const runId = 'run_daemon_session';
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
    const { sdk, facade } = session({ onNotification: (n) => folder.absorb(n) });
    await sdk.start();
    const handle = facade.handle(sdk.id!)!;
    handle.turnScript = (h) => {
      const callId = 'call_d1';
      h.notify({
        type: 'tool_call',
        toolUse: { type: 'tool_use', id: callId, name: 'Execute', input: { command: 'echo hi' } },
      } as DroidNotification);
      h.notify({
        type: 'tool_result',
        toolUseId: callId,
        messageId: 'm',
        content: 'hi',
        isError: false,
      } as DroidNotification);
      h.notify({
        type: 'create_message',
        message: {
          id: 'a',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      } as DroidNotification);
      h.notify({
        type: 'agent_turn_completed',
        reason: 'completed',
        turnId: 't',
        tokenUsage: usage(),
      } as DroidNotification);
      return resultSuccess(h.id, 'done');
    };
    await sdk.send('run', 5_000);
    const events = tracer.eventsAfter(runId, 0);
    const types = new Set(events.map((e) => e.type));
    // tool_call folding is the load-bearing parity with subprocess EventFolder.
    expect(types.has('tool_call')).toBe(true);
    const calls = events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('bash: echo hi');
    expect(calls[0]!.endedAt).not.toBeNull();
    await sdk.close();
  });

  it('times out with the exact legacy message', async () => {
    const { sdk, facade } = session();
    await sdk.start();
    const handle = facade.handle(sdk.id!)!;
    handle.turnScript = () =>
      new Promise(() => {
        /* never resolves */
      });
    await expect(sdk.send('hang', 30)).rejects.toThrow('turn timed out after 30ms');
    await sdk.close();
  });
});

describe('interrupt (VAL-DAEMON-006)', () => {
  it('aborts the in-flight turn and leaves the session alive for the next', async () => {
    const { sdk, facade } = session();
    await sdk.start();
    const handle = facade.handle(sdk.id!)!;
    let resolveTurn!: (r: DroidResultMessage) => void;
    handle.turnScript = () =>
      new Promise<DroidResultMessage>((resolve) => {
        resolveTurn = resolve;
      });

    const inFlight = sdk.send('long', 5_000);
    // Let stream start.
    await new Promise((r) => setTimeout(r, 5));
    await sdk.interrupt();
    expect(handle.interruptCalls).toBe(1);
    resolveTurn(handle.interruptedResult());
    const result = await inFlight;
    expect(result.interrupted).toBe(true);
    expect(result.reason).toBe('cancelled');
    expect(sdk.alive).toBe(true);

    handle.turnScript = (h, prompt) => h.defaultTurn(prompt);
    const after = await sdk.send('still usable', 5_000);
    expect(after.text).toContain('still usable');
    expect(sdk.id).toBe(handle.id);
    await sdk.close();
  });
});

describe('compact/rewind successor resume (VAL-DAEMON-014)', () => {
  it('compacts by resuming newSessionId, swaps, and never streams the source again', async () => {
    const { sdk, facade } = session();
    await sdk.start();
    const sourceId = sdk.id!;
    expect(await sdk.compact()).toEqual({ removedCount: 7 });

    // Successor resumed on the same connection.
    expect(facade.resumes.some((r) => r.sessionId === 'daemon-session-compacted')).toBe(true);
    expect(sdk.id).toBe('daemon-session-compacted');
    expect(sdk.alive).toBe(true);

    // Source handle must not receive further streams.
    const after = await sdk.send('post-compact', 5_000);
    expect(after.text).toContain('post-compact');
    expect(
      facade.streamLog.every((e) => e.sessionId !== sourceId || e.prompt !== 'post-compact'),
    ).toBe(true);
    expect(facade.streamLog.some((e) => e.sessionId === 'daemon-session-compacted')).toBe(true);

    // Autonomy re-asserted on the successor (load carries no settings).
    const successorUpdates = facade.updateCalls.filter(
      (c) => c.sessionId === 'daemon-session-compacted',
    );
    expect(
      successorUpdates.some(
        (c) => c.params.autonomyLevel === AutonomyLevel.High || c.params.autonomyLevel === 'high',
      ),
    ).toBe(true);
    await sdk.close();
  });

  it('rewinds by resuming newSessionId and swaps the handle', async () => {
    const { sdk, facade } = session();
    await sdk.start();
    // Plant a user message id via a turn.
    await sdk.send('anchor', 5_000);
    expect(sdk.lastUserMessageId).toBeTruthy();

    const sourceId = sdk.id!;
    const outcome = await sdk.rewind({
      messageId: sdk.lastUserMessageId!,
      filesToRestore: [{ filePath: 'watched.txt', contentHash: 'abc', size: 12 }],
      filesToDelete: [{ filePath: 'scratch.txt' }],
      forkTitle: 'foundry:test:correction',
    });
    expect(outcome).toEqual({
      restoredCount: 2,
      deletedCount: 1,
      failedRestoreCount: 0,
      failedDeleteCount: 0,
    });
    expect(sdk.id).toBe('daemon-session-rewound');
    expect(facade.resumes.some((r) => r.sessionId === 'daemon-session-rewound')).toBe(true);

    await sdk.send('after-rewind', 5_000);
    expect(facade.streamLog.some((e) => e.sessionId === 'daemon-session-rewound')).toBe(true);
    expect(
      facade.streamLog.filter((e) => e.sessionId === sourceId && e.prompt === 'after-rewind'),
    ).toHaveLength(0);
    await sdk.close();
  });
});

describe('context stats (VAL-DAEMON-004 d)', () => {
  it('derives contextStats from sessions.getContextBreakdown and wires breakdown', async () => {
    const { sdk, facade } = session();
    await sdk.start();
    const stats = await sdk.contextStats();
    expect(stats).toEqual({
      used: 40_000,
      remaining: 160_000,
      limit: 200_000,
      accuracy: 'breakdown',
    });
    const breakdown = await sdk.contextBreakdown();
    expect(breakdown).toMatchObject({
      usedTokens: 40_000,
      contextBudget: 200_000,
      categories: [{ name: 'System prompt', tokens: 1200 }],
    });
    // Sanity: facade was consulted (not a hardcoded constant in the wrapper alone).
    facade.breakdown.usedTokens = 99;
    facade.breakdown.freeTokens = 1;
    facade.breakdown.contextBudget = 100;
    expect(await sdk.contextStats()).toMatchObject({ used: 99, remaining: 1, limit: 100 });
    await sdk.close();
  });
});

describe('resume after daemon restart (VAL-DAEMON-011)', () => {
  it('resumes a persisted session id after live handles are wiped', async () => {
    const facade = new ScriptedSessions();
    const first = session({ facade });
    await first.sdk.start();
    const id = first.sdk.id!;
    facade.noteMessage(id, 'hello from before restart');
    await first.sdk.send('remember this', 5_000);
    facade.noteMessage(id, 'remember this');
    await first.sdk.close();

    facade.restartDaemon();
    expect(facade.handle(id)).toBeUndefined();

    const second = session({ facade });
    await second.sdk.start(id);
    expect(second.sdk.id).toBe(id);
    expect(facade.resumes.some((r) => r.sessionId === id)).toBe(true);
    const messages = await facade.getMessages(id);
    expect(messages.length).toBeGreaterThan(0);
    const turn = await second.sdk.send('after restart', 5_000);
    expect(turn.text).toContain('after restart');
    await second.sdk.close();
  });
});

describe('kill / close', () => {
  it('kill is interrupt+close best-effort with no per-session pid', async () => {
    const { sdk, facade } = session();
    await sdk.start();
    expect(sdk.pid).toBeUndefined();
    expect(sdk.spawnArgs()).toEqual([]);
    const handle = facade.handle(sdk.id!)!;
    sdk.kill();
    // Allow the async close path to settle.
    await new Promise((r) => setTimeout(r, 10));
    expect(handle.interruptCalls + handle.closeCalls + handle.detachCalls).toBeGreaterThan(0);
    expect(sdk.alive).toBe(false);
  });
});

describe('connection safety-net helper export', () => {
  it('exports a fail-closed connection permission handler', () => {
    const perm = failClosedPermissionHandler({
      toolUses: [],
      options: [],
      associatedSessionIds: ['ghost'],
    });
    expect(perm).toMatchObject({
      selectedOption: ToolConfirmationOutcome.Cancel,
    });
    const ask = failClosedAskUserHandler({
      toolCallId: 'x',
      questions: [],
    } as AskUserRequestParams);
    expect(ask).toEqual({ cancelled: true, answers: [] });
  });
});
