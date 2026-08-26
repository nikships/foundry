/**
 * The restore channels are arg-check + delegate, as `src/main/ipc/AGENTS.md`
 * requires. These tests pin that: the choreography lives in
 * `engine/restore.ts`, so what the router owes is a project lookup, a rejected
 * argument answered with a refusal rather than a throw, and a result that
 * survives structured clone.
 */

import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../src/shared/ipc-contract.js';
import type {
  PhaseCheckpointRow,
  RestorableCheckpointList,
  RestoreResult,
  RestoreRunInput,
  RunRow,
} from '../../../src/shared/types.js';
import { register } from '../../../src/main/ipc/runs.js';
import type { Handle } from '../../../src/main/ipc/shared.js';

type Handler = (...args: never[]) => unknown;

const RUN_ID = 'run_restore';
const CHECKPOINT_ID = 'cp_1';

function runRow(over: Partial<RunRow> = {}): RunRow {
  return {
    runId: RUN_ID,
    projectId: 'proj_1',
    pipelineId: 'p',
    pipelineName: 'p',
    request: 'do the thing',
    status: 'rejected',
    engineer: 'test',
    worktreePath: null,
    branch: 'foundry/run_restore',
    baseRef: 'main',
    branchPointSha: null,
    outcomeDetail: null,
    prNumber: null,
    prUrl: null,
    issueNumber: null,
    issueUrl: null,
    merged: false,
    archived: false,
    mode: 'pi',
    orchestrated: false,
    amendments: 0,
    startedAt: '2026-08-25T00:00:00.000Z',
    endedAt: '2026-08-25T00:01:00.000Z',
    totalTokens: 0,
    ...over,
  };
}

function checkpointRow(): PhaseCheckpointRow {
  return {
    checkpointId: CHECKPOINT_ID,
    runId: RUN_ID,
    phaseId: 'ph_1',
    phaseName: 'build',
    phaseKind: 'agent',
    generation: 1,
    headSha: 'a'.repeat(40),
    model: 'provider/model',
    agent: 'builder',
    agentSessionId: 's1',
    leafMessageId: null,
    fileCount: 1,
    untrackedCount: 0,
    bytesStored: 12,
    truncated: false,
    exactRestorePossible: true,
    payloadPath: 'checkpoints/build-ph_1-1.json',
    changeId: 7,
    createdAt: '2026-08-25T00:00:30.000Z',
  };
}

/**
 * A router over a tracer that has the run but no worktree on disk, which is
 * the one refusal a stub can reach honestly without creating a git repo. The
 * restore behaviour itself is covered against real repos in the engine suite.
 */
function harness(opts: { projectFound?: boolean; run?: RunRow | null } = {}) {
  const tracer = {
    run: vi.fn((): RunRow | null => (opts.run === undefined ? runRow() : opts.run)),
    phaseCheckpoints: vi.fn((): PhaseCheckpointRow[] => [checkpointRow()]),
    phaseCheckpoint: vi.fn(() => null),
    event: vi.fn(() => 'evt_1'),
    agentSessions: vi.fn(() => []),
    clearAgentSessionId: vi.fn(() => null),
  };
  const handlers = new Map<string, Handler>();
  const handle: Handle = (channel, fn) => handlers.set(channel, fn);
  const project = { id: 'proj_1', path: '/tmp/nowhere' };
  register(
    {
      projects: { get: vi.fn(() => (opts.projectFound === false ? undefined : project)) },
      registry: { tracerFor: vi.fn(() => tracer), isLive: vi.fn(() => false) },
      broadcast: vi.fn(),
    } as never,
    handle,
  );

  const list = handlers.get(IPC.runsRestorableCheckpoints) as (
    projectId: string,
    runId: string,
  ) => Promise<RestorableCheckpointList>;
  const restore = handlers.get(IPC.runsRestoreCheckpoint) as (
    projectId: string,
    input: RestoreRunInput,
  ) => Promise<RestoreResult>;
  return { handlers, tracer, list, restore };
}

describe('the restore IPC channels', () => {
  it('registers both channels on the runs router', () => {
    const { handlers } = harness();
    expect(handlers.has(IPC.runsRestorableCheckpoints)).toBe(true);
    expect(handlers.has(IPC.runsRestoreCheckpoint)).toBe(true);
  });

  it('delegates the list to the engine and returns a cloneable answer', async () => {
    const { list, tracer } = harness();
    const listed = await list('proj_1', RUN_ID);

    expect(tracer.phaseCheckpoints).toHaveBeenCalledWith(RUN_ID);
    expect(listed.runId).toBe(RUN_ID);
    expect(listed.checkpoints.map((c) => c.checkpointId)).toEqual([CHECKPOINT_ID]);
    expect(() => structuredClone(listed)).not.toThrow();
  });

  it('answers an unknown project with a refusal rather than a throw', async () => {
    const { list, restore } = harness({ projectFound: false });

    await expect(list('nope', RUN_ID)).resolves.toMatchObject({
      refusal: 'run_not_found',
      checkpoints: [],
    });
    await expect(restore('nope', { runId: RUN_ID, checkpointId: CHECKPOINT_ID })).resolves.toEqual({
      ok: false,
      refusal: 'run_not_found',
      detail: 'this run is no longer in the trace',
    });
  });

  it('rejects a call with no target before it reaches the engine', async () => {
    const { restore, tracer } = harness();

    const result = await restore('proj_1', { runId: RUN_ID, checkpointId: '' });
    expect(result).toEqual({
      ok: false,
      refusal: 'checkpoint_not_found',
      detail: 'that checkpoint is not one this run recorded',
    });
    expect(tracer.run).not.toHaveBeenCalled();
  });

  it('delegates a well-formed restore and returns the engine’s refusal verbatim', async () => {
    const { restore, tracer } = harness();

    const result = await restore('proj_1', { runId: RUN_ID, checkpointId: CHECKPOINT_ID });
    // The stub run has no worktree, so the engine refuses for that reason; the
    // router neither invents a reason nor rewords one.
    expect(result).toEqual({
      ok: false,
      refusal: 'worktree_missing',
      detail: 'this run’s worktree is gone, so there is nowhere to restore into',
    });
    expect(tracer.run).toHaveBeenCalledWith(RUN_ID);
    expect(tracer.event).not.toHaveBeenCalled();
    expect(() => structuredClone(result)).not.toThrow();
  });

  it('refuses a run the trace no longer holds', async () => {
    const { restore, list } = harness({ run: null });
    await expect(
      restore('proj_1', { runId: RUN_ID, checkpointId: CHECKPOINT_ID }),
    ).resolves.toMatchObject({ refusal: 'run_not_found' });
    await expect(list('proj_1', RUN_ID)).resolves.toMatchObject({ refusal: 'run_not_found' });
  });

  it('round trips a restore input across structured clone', () => {
    const input: RestoreRunInput = {
      runId: RUN_ID,
      checkpointId: CHECKPOINT_ID,
      acceptPartial: true,
    };
    expect(structuredClone(input)).toEqual(input);
  });
});
