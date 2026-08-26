import { describe, expect, it } from 'vitest';
import type {
  RestorableCheckpoint,
  RestorableCheckpointList,
  RestoreRecord,
  RestoreResult,
  RunRow,
} from '@shared/types.js';
import { RESTORE_REFUSAL_COPY } from '@shared/types.js';
import {
  restoreAvailability,
  restoreConfirmation,
  restoreOptions,
  restoreOutcome,
  restoreRequest,
} from '@renderer/view-models/restore-view.js';

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    runId: 'r1',
    projectId: 'p1',
    pipelineId: 'pipe',
    pipelineName: 'Ship it',
    request: 'do the thing',
    status: 'failed',
    startedAt: '2026-08-25T10:00:00.000Z',
    endedAt: '2026-08-25T10:20:00.000Z',
    branch: 'foundry/r1',
    baseRef: 'main',
    worktreePath: '/tmp/wt/r1',
    merged: false,
    amendments: 0,
    totalTokens: 0,
    ...over,
  } as RunRow;
}

function checkpoint(over: Partial<RestorableCheckpoint> = {}): RestorableCheckpoint {
  return {
    checkpointId: 'c1',
    runId: 'r1',
    phaseId: 'implement',
    phaseName: 'Implement',
    phaseKind: 'agent',
    generation: 1,
    createdAt: '2026-08-25T10:05:00.000Z',
    headSha: 'abcdef1234567890',
    model: 'anthropic/claude',
    agent: 'Engineer',
    fileCount: 4,
    untrackedCount: 1,
    bytesStored: 2048,
    restorable: true,
    exactRestorePossible: true,
    omittedPaths: [],
    commitsSince: 0,
    commitsSinceShas: [],
    ...over,
  };
}

function list(over: Partial<RestorableCheckpointList> = {}): RestorableCheckpointList {
  return {
    runId: 'r1',
    refusal: null,
    detail: '',
    checkpoints: [checkpoint()],
    ...over,
  };
}

function record(over: Partial<RestoreRecord> = {}): RestoreRecord {
  return {
    checkpointId: 'c1',
    phaseId: 'implement',
    phaseName: 'Implement',
    generation: 2,
    previousHeadSha: 'ffffff0000',
    headSha: 'abcdef1234567890',
    droppedCommits: [],
    filesRestored: 4,
    filesRemoved: 1,
    omittedPaths: [],
    partial: false,
    freshSessionAgent: 'Engineer',
    previousSessionId: 's1',
    fromStatus: 'failed',
    ...over,
  };
}

describe('restoreAvailability', () => {
  it('enables Restore when the run is terminal and recorded checkpoints', () => {
    const availability = restoreAvailability({ run: run(), list: list() });
    expect(availability).toEqual({ offered: true, enabled: true, reason: '' });
  });

  it('disables Restore with the engine’s reason when the run recorded nothing', () => {
    const availability = restoreAvailability({
      run: run(),
      list: list({
        refusal: 'no_checkpoints',
        detail: RESTORE_REFUSAL_COPY.no_checkpoints,
        checkpoints: [],
      }),
    });
    expect(availability.offered).toBe(true);
    expect(availability.enabled).toBe(false);
    expect(availability.reason).toBe(RESTORE_REFUSAL_COPY.no_checkpoints);
  });

  it('disables with a reason for an empty list that carried no refusal', () => {
    const availability = restoreAvailability({ run: run(), list: list({ checkpoints: [] }) });
    expect(availability.enabled).toBe(false);
    expect(availability.reason).toBe(RESTORE_REFUSAL_COPY.no_checkpoints);
  });

  it('is not offered for a running or merged run, or one with no worktree', () => {
    expect(restoreAvailability({ run: run({ status: 'running' }), list: list() }).offered).toBe(
      false,
    );
    expect(restoreAvailability({ run: run({ merged: true }), list: list() }).offered).toBe(false);
    expect(restoreAvailability({ run: run({ worktreePath: null }), list: list() }).offered).toBe(
      false,
    );
    expect(restoreAvailability({ run: null, list: list() }).offered).toBe(false);
  });

  it('quotes a run-level refusal rather than paraphrasing it', () => {
    const availability = restoreAvailability({
      run: run({ status: 'accepted' }),
      list: list({ refusal: 'run_not_terminal', detail: RESTORE_REFUSAL_COPY.run_not_terminal }),
    });
    expect(availability.reason).toBe(RESTORE_REFUSAL_COPY.run_not_terminal);
  });

  it('disables while the query is in flight, on an error, and while the worktree is busy', () => {
    expect(restoreAvailability({ run: run(), list: null, loading: true }).reason).toMatch(
      /Looking for recorded checkpoints/,
    );
    expect(restoreAvailability({ run: run(), list: null, error: 'boom' }).reason).toBe('boom');
    expect(restoreAvailability({ run: run(), list: null }).enabled).toBe(false);
    expect(restoreAvailability({ run: run(), list: list(), busy: true }).enabled).toBe(false);
  });
});

describe('restoreOptions', () => {
  it('labels every checkpoint with phase, attempt, time, sha and scope', () => {
    const options = restoreOptions(
      list({
        checkpoints: [
          checkpoint(),
          checkpoint({ checkpointId: 'c2', phaseName: 'Implement', generation: 2 }),
          checkpoint({ checkpointId: 'c3', phaseName: 'Review', phaseId: 'review', generation: 1 }),
        ],
      }),
    );
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.label)).toEqual([
      'Implement · attempt 1',
      'Implement · attempt 2',
      'Review · attempt 1',
    ]);
    expect(options[0].sha).toBe('abcdef12');
    expect(options[0].scope).toBe('4 files, 1 untracked');
    expect(options[0].attribution).toBe('Engineer · anthropic/claude');
    expect(options[0].createdAt).toBe('2026-08-25T10:05:00.000Z');
  });

  it('marks exact and partial checkpoints distinctly', () => {
    const options = restoreOptions(
      list({
        checkpoints: [
          checkpoint(),
          checkpoint({
            checkpointId: 'c2',
            exactRestorePossible: false,
            blocker: 'partial_not_accepted',
            omittedPaths: ['src/big.bin', 'docs/huge.md'],
          }),
        ],
      }),
    );
    expect(options[0].exact).toBe(true);
    expect(options[0].exactnessLabel).toBe('Exact');
    expect(options[1].exact).toBe(false);
    expect(options[1].exactnessLabel).toBe('Partial');
    expect(options[1].exactnessDetail).toContain('src/big.bin');
    expect(options[1].exactnessDetail).toContain('docs/huge.md');
  });

  it('never describes a partial checkpoint as an exact replay', () => {
    const [option] = restoreOptions(
      list({
        checkpoints: [checkpoint({ exactRestorePossible: false, omittedPaths: ['src/a.ts'] })],
      }),
    );
    expect(option.exactnessDetail).toMatch(/cannot reproduce phase start exactly/);
    expect(option.exactnessDetail).not.toMatch(/byte for byte/);
    expect(option.exactnessLabel).not.toBe('Exact');
  });

  it('names the commits a restore would reset off, and stays silent when HEAD has not moved', () => {
    const [moved, still] = restoreOptions(
      list({
        checkpoints: [
          checkpoint({ commitsSince: 2, commitsSinceShas: ['deadbee', 'cafe123'] }),
          checkpoint({ checkpointId: 'c2' }),
        ],
      }),
    );
    expect(moved.commitNote).toContain('2 commits would be reset off the branch');
    expect(moved.commitNote).toContain('deadbee');
    expect(moved.commitNote).toContain('abcdef12');
    expect(moved.commitNote).toMatch(/git reflog/);
    expect(still.commitNote).toBe('');
  });

  it('surfaces a checkpoint-level blocker verbatim and marks it unselectable', () => {
    const [option] = restoreOptions(
      list({
        checkpoints: [
          checkpoint({
            restorable: false,
            exactRestorePossible: false,
            blocker: 'checkpoint_payload_missing',
          }),
        ],
      }),
    );
    expect(option.selectable).toBe(false);
    expect(option.blockedReason).toBe(RESTORE_REFUSAL_COPY.checkpoint_payload_missing);
  });

  it('answers with nothing before the list has loaded', () => {
    expect(restoreOptions(null)).toEqual([]);
  });
});

describe('restoreConfirmation', () => {
  it('names the phase, warns about the commit reset, and says nothing is started', () => {
    const confirmation = restoreConfirmation(
      checkpoint({ commitsSince: 3, commitsSinceShas: ['aaa1111', 'bbb2222', 'ccc3333'] }),
    );
    expect(confirmation.message).toContain('“Implement” (attempt 1)');
    expect(confirmation.message).toContain('3 commits would be reset off the branch');
    expect(confirmation.message).toContain('aaa1111');
    expect(confirmation.message).toContain('abcdef12');
    expect(confirmation.message).toMatch(/git reflog/);
    expect(confirmation.message).toMatch(/Nothing is started/);
    expect(confirmation.acceptsPartial).toBe(false);
    expect(confirmation.confirmLabel).toBe('Restore');
  });

  it('names the affected paths and states the acceptance for a non-exact checkpoint', () => {
    const confirmation = restoreConfirmation(
      checkpoint({ exactRestorePossible: false, omittedPaths: ['src/a.ts', 'src/b.ts'] }),
    );
    expect(confirmation.message).toContain('src/a.ts');
    expect(confirmation.message).toContain('src/b.ts');
    expect(confirmation.message).toMatch(/Confirming accepts a partial restore/);
    expect(confirmation.message).not.toMatch(/byte for byte/);
    expect(confirmation.acceptsPartial).toBe(true);
    expect(confirmation.title).toBe('Accept a partial restore');
    expect(confirmation.confirmLabel).toBe('Restore partially');
  });

  it('omits the commit warning when HEAD has not moved', () => {
    expect(restoreConfirmation(checkpoint()).message).not.toMatch(/reset off the branch/);
  });
});

describe('restoreRequest', () => {
  it('sends nothing at all without an accepted confirmation', () => {
    expect(restoreRequest(checkpoint(), false)).toBeNull();
    expect(restoreRequest(checkpoint({ exactRestorePossible: false }), false)).toBeNull();
  });

  it('never sends acceptPartial for an exact checkpoint', () => {
    expect(restoreRequest(checkpoint(), true)).toEqual({ runId: 'r1', checkpointId: 'c1' });
  });

  it('sends acceptPartial only after the partial confirmation was accepted', () => {
    const input = restoreRequest(
      checkpoint({ exactRestorePossible: false, omittedPaths: ['src/a.ts'] }),
      true,
    );
    expect(input).toEqual({ runId: 'r1', checkpointId: 'c1', acceptPartial: true });
  });

  it('refuses to build a call for a checkpoint nothing can be restored from', () => {
    expect(restoreRequest(checkpoint({ restorable: false }), true)).toBeNull();
  });
});

describe('restoreOutcome', () => {
  it('has nothing to say before a call is made', () => {
    expect(restoreOutcome(null)).toBeNull();
  });

  it('surfaces a refusal verbatim with no consolation', () => {
    const result: RestoreResult = {
      ok: false,
      refusal: 'partial_not_accepted',
      detail: RESTORE_REFUSAL_COPY.partial_not_accepted,
    };
    const outcome = restoreOutcome(result);
    expect(outcome).toEqual({
      tone: 'bad',
      detail: RESTORE_REFUSAL_COPY.partial_not_accepted,
      standing: '',
      nextStep: '',
    });
  });

  it('says where the operator now stands and that they must Continue', () => {
    const outcome = restoreOutcome({
      ok: true,
      detail: 'Restored “Implement”…',
      restored: record(),
    });
    expect(outcome?.tone).toBe('ok');
    expect(outcome?.detail).toBe('Restored “Implement”…');
    expect(outcome?.standing).toContain('“Implement” (attempt 2)');
    expect(outcome?.standing).toContain('abcdef12');
    expect(outcome?.nextStep).toMatch(/not running/);
    expect(outcome?.nextStep).toMatch(/Continue run/);
    expect(outcome?.nextStep).toContain('Engineer');
  });

  it('calls a partial success partial and names what it left alone', () => {
    const outcome = restoreOutcome({
      ok: true,
      detail: 'Restored…',
      restored: record({ partial: true, omittedPaths: ['src/a.ts'] }),
    });
    expect(outcome?.standing).toMatch(/partial restore/);
    expect(outcome?.standing).toContain('src/a.ts');
    expect(outcome?.standing).not.toMatch(/byte for byte|exactly as it began/);
  });

  it('names the dropped commits and where to find them again', () => {
    const outcome = restoreOutcome({
      ok: true,
      detail: 'Restored…',
      restored: record({ droppedCommits: ['aaa1111', 'bbb2222'] }),
    });
    expect(outcome?.standing).toContain('2 commits moved off the branch');
    expect(outcome?.standing).toContain('aaa1111');
    expect(outcome?.standing).toMatch(/git reflog/);
  });
});
