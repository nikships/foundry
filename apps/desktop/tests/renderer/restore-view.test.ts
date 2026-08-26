import { describe, expect, it } from 'vitest';
import type {
  RestorableCheckpoint,
  RestorableCheckpointList,
  RestoreRecord,
  RestoreResult,
  RestoreRunInput,
  RunRow,
} from '@shared/types.js';
import { RESTORE_REFUSAL_COPY } from '@shared/types.js';
import {
  performRestore,
  restoreActionState,
  restoreAvailability,
  restoreConfirmation,
  restoreEmptyCopy,
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
    droppedCommitCount: 0,
    filesRestored: 4,
    filesRemoved: 1,
    omittedPaths: [],
    partial: false,
    driftEnumerated: true,
    freshSessions: [{ agent: 'Engineer', previousSessionId: 's1' }],
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

  // A missing payload clears exactRestorePossible too, which would otherwise
  // print "a restore would be partial" beside "cannot be restored". There is
  // no restore to be partial about.
  it('says nothing about exactness for a checkpoint nothing can be restored from', () => {
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
    expect(option.exactnessDetail).toBe('');
    expect(option.blockedReason).toBe(RESTORE_REFUSAL_COPY.checkpoint_payload_missing);
  });

  it('still describes exactness for a truncated record that can be partly restored', () => {
    const [option] = restoreOptions(
      list({
        checkpoints: [
          checkpoint({
            restorable: true,
            exactRestorePossible: false,
            blocker: 'partial_not_accepted',
            omittedPaths: ['src/a.ts'],
          }),
        ],
      }),
    );
    expect(option.selectable).toBe(true);
    expect(option.exactnessDetail).toContain('src/a.ts');
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

  it('says where the operator now stands and that nothing is running', () => {
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
  });

  // `executor.resume` restarts at the first phase whose status is `fail`, and a
  // restore changes no phase status, so Continue does not resume from the
  // checkpoint. It also does not exist at all for a killed run.
  it('does not claim Continue resumes from the restored checkpoint', () => {
    const outcome = restoreOutcome({ ok: true, detail: 'Restored…', restored: record() });
    expect(outcome?.nextStep).not.toMatch(/from here/);
    expect(outcome?.nextStep).toMatch(/first failed phase/);
    expect(outcome?.nextStep).toMatch(/not from this checkpoint/);
    expect(outcome?.nextStep).toMatch(/when it is available/);
  });

  it('names every agent whose session the restore dropped, not only one', () => {
    const outcome = restoreOutcome({
      ok: true,
      detail: 'Restored…',
      restored: record({
        freshSessions: [
          { agent: 'Engineer', previousSessionId: 's1' },
          { agent: 'Reviewer', previousSessionId: null },
        ],
      }),
    });
    expect(outcome?.nextStep).toContain('Engineer');
    expect(outcome?.nextStep).toContain('Reviewer');
    expect(outcome?.nextStep).toMatch(/start a new session/);
  });

  it('says nothing about sessions when the restore dropped none', () => {
    const outcome = restoreOutcome({
      ok: true,
      detail: 'Restored…',
      restored: record({ freshSessions: [] }),
    });
    expect(outcome?.nextStep).not.toMatch(/new session/);
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

  it('reports an unenumerated partial without claiming nothing was left behind', () => {
    const outcome = restoreOutcome({
      ok: true,
      detail: 'Restored…',
      restored: record({ partial: true, driftEnumerated: false, omittedPaths: [] }),
    });
    expect(outcome?.standing).toMatch(/partial restore/);
    expect(outcome?.standing).toMatch(/could not be listed in full/);
    // The empty path list is the engine saying it cannot name them, so
    // counting it would read as a clean restore.
    expect(outcome?.standing).not.toMatch(/0 paths/);
  });

  it('names the dropped commits and where to find them again', () => {
    const outcome = restoreOutcome({
      ok: true,
      detail: 'Restored…',
      restored: record({ droppedCommits: ['aaa1111', 'bbb2222'], droppedCommitCount: 2 }),
    });
    expect(outcome?.standing).toContain('2 commits moved off the branch');
    expect(outcome?.standing).toContain('aaa1111');
    expect(outcome?.standing).toMatch(/git reflog/);
  });

  // Split 2 caps the sha list at 20 and counts separately, because "20 moved
  // off" when 500 did is the number the operator would have decided on.
  it('counts with the uncapped count and quotes the capped list, elided', () => {
    const outcome = restoreOutcome({
      ok: true,
      detail: 'Restored…',
      restored: record({ droppedCommits: ['aaa1111', 'bbb2222'], droppedCommitCount: 500 }),
    });
    expect(outcome?.standing).toContain('500 commits moved off the branch');
    expect(outcome?.standing).not.toContain('2 commits moved off');
    expect(outcome?.standing).toContain('aaa1111, bbb2222, …');
  });

  // `restored` rides along on the one refusal that happens after the reset, so
  // it is a report of what the worktree went through, never proof of success.
  it('reports the reset on a refusal that carries a record, without calling it success', () => {
    const outcome = restoreOutcome({
      ok: false,
      refusal: 'partial_not_accepted',
      detail: RESTORE_REFUSAL_COPY.partial_not_accepted,
      restored: record({
        partial: true,
        omittedPaths: ['src/a.ts'],
        droppedCommits: ['aaa1111'],
        droppedCommitCount: 1,
      }),
    });
    expect(outcome?.tone).toBe('bad');
    expect(outcome?.detail).toBe(RESTORE_REFUSAL_COPY.partial_not_accepted);
    expect(outcome?.standing).toMatch(/already reset/);
    expect(outcome?.standing).toContain('src/a.ts');
    expect(outcome?.standing).toContain('aaa1111');
    // No next step: the operator was not handed a restored tree to continue from.
    expect(outcome?.nextStep).toBe('');
    expect(outcome?.standing).not.toMatch(/back at the start of/);
  });
});

describe('performRestore', () => {
  const exact = checkpoint();
  const partial = checkpoint({ exactRestorePossible: false, omittedPaths: ['src/a.ts'] });
  const ok: RestoreResult = { ok: true, detail: 'done', restored: record() };

  function spyDeps(answer: boolean) {
    const order: string[] = [];
    const calls: RestoreRunInput[] = [];
    return {
      order,
      calls,
      deps: {
        confirm: async (): Promise<boolean> => {
          order.push('confirm');
          return answer;
        },
        call: async (input: RestoreRunInput): Promise<RestoreResult> => {
          order.push('call');
          calls.push(input);
          return ok;
        },
      },
    };
  }

  it('calls nothing when the confirmation is declined', async () => {
    const { deps, order, calls } = spyDeps(false);
    expect(await performRestore(deps, exact)).toBeNull();
    expect(calls).toEqual([]);
    expect(order).toEqual(['confirm']);
  });

  it('declines a partial checkpoint without ever sending acceptPartial', async () => {
    const { deps, calls } = spyDeps(false);
    expect(await performRestore(deps, partial)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('confirms before it calls, never the other way', async () => {
    const { deps, order } = spyDeps(true);
    await performRestore(deps, exact);
    expect(order).toEqual(['confirm', 'call']);
  });

  it('sends acceptPartial only for a non-exact checkpoint the operator accepted', async () => {
    const accepted = spyDeps(true);
    await performRestore(accepted.deps, partial);
    expect(accepted.calls).toEqual([{ runId: 'r1', checkpointId: 'c1', acceptPartial: true }]);

    const exactRun = spyDeps(true);
    await performRestore(exactRun.deps, exact);
    expect(exactRun.calls).toEqual([{ runId: 'r1', checkpointId: 'c1' }]);
    expect(exactRun.calls[0]).not.toHaveProperty('acceptPartial');
  });

  it('returns the call’s own result untouched', async () => {
    const { deps } = spyDeps(true);
    expect(await performRestore(deps, exact)).toBe(ok);
  });

  it('never calls for a checkpoint nothing can be restored from', async () => {
    const { deps, calls } = spyDeps(true);
    expect(await performRestore(deps, checkpoint({ restorable: false }))).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('restoreActionState', () => {
  it('disables and renames the button for the whole confirm-to-completion window', () => {
    expect(restoreActionState({ busy: true, refreshing: false, hasSelection: true })).toEqual({
      disabled: true,
      label: 'Restoring…',
    });
  });

  it('disables while the branch is being re-read, so no stale list is confirmed against', () => {
    expect(restoreActionState({ busy: false, refreshing: true, hasSelection: true })).toEqual({
      disabled: true,
      label: 'Checking the branch…',
    });
  });

  it('needs a selection when idle', () => {
    expect(restoreActionState({ busy: false, refreshing: false, hasSelection: false })).toEqual({
      disabled: true,
      label: 'Restore…',
    });
    expect(restoreActionState({ busy: false, refreshing: false, hasSelection: true })).toEqual({
      disabled: false,
      label: 'Restore…',
    });
  });
});

describe('restoreEmptyCopy', () => {
  it('does not claim the run recorded nothing when the read failed', () => {
    expect(restoreEmptyCopy(null)).toBe('Could not read this run’s checkpoints.');
    expect(restoreEmptyCopy(null)).not.toMatch(/recorded no phase checkpoints/);
  });

  it('quotes the engine’s reason for an empty list', () => {
    expect(
      restoreEmptyCopy(
        list({
          checkpoints: [],
          refusal: 'no_checkpoints',
          detail: RESTORE_REFUSAL_COPY.no_checkpoints,
        }),
      ),
    ).toBe(RESTORE_REFUSAL_COPY.no_checkpoints);
  });

  it('falls back to the no-checkpoints reason when an eligible run has none', () => {
    expect(restoreEmptyCopy(list({ checkpoints: [] }))).toBe(RESTORE_REFUSAL_COPY.no_checkpoints);
  });
});
