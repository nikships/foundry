/**
 * Restore test suite — split across files to parallelize over CPU cores.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  sh,
  headOf,
  pipe,
  codePhase,
  agentPhase,
  buildEnvelope,
  createHarness,
  type Harness,
  runForHarness,
  type RunInput,
  scopeForHarness,
  checkpointForHarness,
  rejectedRunWithDirtyCheckpointForHarness,
  executorForHarness,
} from './restore-harness.js';
import {
  listRestorableCheckpoints,
  restoreRun,
  type RestoreScope,
} from '../../../src/main/engine/restore.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});
const scope = (over?: Partial<RestoreScope>) => scopeForHarness(h, over);
const run = (input: RunInput) => runForHarness(h, input);
const checkpointFor = (runId: string, phaseName: string, gen?: number) =>
  checkpointForHarness(h, runId, phaseName, gen);
const rejectedRunWithDirtyCheckpoint = () => rejectedRunWithDirtyCheckpointForHarness(h);
const executorFor = (input: RunInput, runId: string, scripted: ScriptedAgent) =>
  executorForHarness(h, input, runId, scripted);

describe('restoring a terminal run to a checkpoint', () => {
  it('puts tracked modifications, recorded untracked files, and HEAD back', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');

    // The mess a killed or failed attempt leaves: a tracked file overwritten,
    // a recorded untracked file deleted, and a new file that never belonged.
    writeFileSync(join(worktree, 'tracked.txt'), 'clobbered by the dead attempt\n');
    rmSync(join(worktree, 'extra.txt'));
    writeFileSync(join(worktree, 'junk.txt'), 'left behind\n');

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(worktree, 'tracked.txt'), 'utf8')).toBe('phase-start\n');
    expect(readFileSync(join(worktree, 'extra.txt'), 'utf8')).toBe('kept\n');
    expect(existsSync(join(worktree, 'junk.txt'))).toBe(false);
    expect(headOf(worktree)).toBe(checkpoint.headSha);
    expect(result.restored!.partial).toBe(false);
    expect(result.restored!.omittedPaths).toEqual([]);
  });

  it('resets the run branch to the checkpoint commit and names the commits it moved off', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');

    writeFileSync(join(worktree, 'committed-after.txt'), 'work committed after the checkpoint\n');
    sh(worktree, ['git', 'add', '-A']);
    sh(worktree, ['git', 'commit', '-qm', 'after the checkpoint']);
    const dropped = headOf(worktree);

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.ok).toBe(true);
    expect(headOf(worktree)).toBe(checkpoint.headSha);
    expect(result.restored!.previousHeadSha).toBe(dropped);
    expect(result.restored!.droppedCommits).toHaveLength(1);
    expect(dropped.startsWith(result.restored!.droppedCommits[0]!)).toBe(true);
    // Moved off the branch, not deleted: the commit is still reachable.
    expect(sh(worktree, ['git', 'cat-file', '-t', dropped]).trim()).toBe('commit');
    expect(result.detail).toContain('moved off');
    expect(result.detail).toContain('reflog');
  });

  it('works inside the run worktree only, never the base checkout', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    writeFileSync(join(h.repo, 'operator-edit.txt'), 'the operator is mid-thought\n');
    const baseHead = headOf(h.repo);

    const result = await restoreRun(scope(), {
      runId,
      checkpointId: checkpointFor(runId, 'build').checkpointId,
    });

    expect(result.ok).toBe(true);
    expect(worktree.startsWith(join(h.repo, '.foundry-worktrees'))).toBe(true);
    expect(readFileSync(join(h.repo, 'operator-edit.txt'), 'utf8')).toBe(
      'the operator is mid-thought\n',
    );
    expect(headOf(h.repo)).toBe(baseHead);
  });

  it('leaves the phase rows, transcript, and earlier checkpoints as they were', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const phasesBefore = h.tracer.phases(runId);
    const eventsBefore = h.tracer.eventsAfter(runId, 0, 1000);
    const checkpointsBefore = h.tracer.phaseCheckpoints(runId);

    await restoreRun(scope(), { runId, checkpointId: checkpointFor(runId, 'build').checkpointId });

    expect(h.tracer.phases(runId)).toEqual(phasesBefore);
    expect(h.tracer.phaseCheckpoints(runId)).toEqual(checkpointsBefore);
    const after = h.tracer.eventsAfter(runId, 0, 1000);
    // Additive: every earlier event survives and the restore appends one.
    expect(after.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    const restore = after.find((e) => e.name === 'restore')!;
    expect(restore.type).toBe('log');
    expect(restore.payload.fromStatus).toBe('rejected');
    expect(restore.payload.phaseName).toBe('build');
  });

  it('does not start the run: status, live state, and phase statuses are untouched', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const statusesBefore = h.tracer.phases(runId).map((p) => p.status);

    await restoreRun(scope(), { runId, checkpointId: checkpointFor(runId, 'build').checkpointId });

    const run = h.tracer.run(runId)!;
    expect(run.status).toBe('rejected');
    expect(run.endedAt).toBeTruthy();
    expect(h.tracer.phases(runId).map((p) => p.status)).toEqual(statusesBefore);
  });

  it('notifies the run list once, because the tracer was written', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const s = scope();
    await restoreRun(s, { runId, checkpointId: checkpointFor(runId, 'build').checkpointId });
    expect(s.notified()).toBe(1);
  });
});

describe('the session a restore leaves behind', () => {
  it('drops the agent’s session pointer so the next Continue opens a new one', async () => {
    const pipeline = pipe([agentPhase('build')]);
    // Three unparseable turns exhaust the envelope budget and reject the run
    // with its session alive; the fourth answers the continued attempt.
    const scripted = new ScriptedAgent(['no', 'still no', 'nope', buildEnvelope()]);
    const first = await run({ pipeline, scripted });
    expect(first.status).toBe('rejected');

    const before = h.tracer.agentSessions(first.runId)[0]!;
    expect(before.agentSessionId).toBe('s1');

    const result = await restoreRun(scope(), {
      runId: first.runId,
      checkpointId: checkpointFor(first.runId, 'build').checkpointId,
    });

    expect(result.restored!.freshSessions).toEqual([{ agent: 'builder', previousSessionId: 's1' }]);
    // The row survives — it is the evidence of what was abandoned — and only
    // the pointer to the runtime conversation is gone.
    const cleared = h.tracer.agentSessions(first.runId)[0]!;
    expect(cleared.agent).toBe('builder');
    expect(cleared.model).toBe(before.model);
    expect(cleared.agentSessionId).toBeNull();

    const continued = await executorFor({ pipeline }, first.runId, scripted).resume();
    expect(continued.status).toBe('accepted');
    // A reopen would have prompted `s1` again; this is a new conversation.
    expect(scripted.turnRequests.at(-1)!.sessionId).toBe('s2');
  });

  it('accepts a checkpoint whose phase had no session open yet', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const build = checkpointFor(runId, 'build');
    // The first entry into a phase has no leaf: nothing had been sent. That is
    // not an error, and a restore must not treat it as one.
    expect(build.leafMessageId).toBeNull();

    const result = await restoreRun(scope(), { runId, checkpointId: build.checkpointId });
    expect(result.ok).toBe(true);
    const restore = h.tracer.eventsAfter(runId, 0, 1000).find((e) => e.name === 'restore')!;
    expect(restore.payload.leafMessageId).toBeNull();
  });

  it('drops the pointer of a later phase’s agent, not only the restored phase’s', async () => {
    // `dirty` is a code phase and precedes `build`. Restoring to it must still
    // clear `builder`: the tree has moved out from under that conversation,
    // and a Continue resumes from `build`, which would otherwise reopen the
    // session the restore was performed to escape.
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    expect(h.tracer.agentSessions(runId)[0]!.agentSessionId).toBe('s1');

    const result = await restoreRun(scope(), {
      runId,
      checkpointId: checkpointFor(runId, 'dirty').checkpointId,
    });

    expect(result.ok).toBe(true);
    expect(result.restored!.freshSessions).toEqual([{ agent: 'builder', previousSessionId: 's1' }]);
    expect(h.tracer.agentSessions(runId)[0]!.agentSessionId).toBeNull();
  });

  it('reports no fresh sessions for a run that never opened one', async () => {
    const outcome = await run({
      pipeline: pipe([codePhase('touch', { argv: ['sh', '-c', 'printf x > only.txt && false'] })]),
    });
    expect(outcome.status).toBe('rejected');

    const result = await restoreRun(scope(), {
      runId: outcome.runId,
      checkpointId: checkpointFor(outcome.runId, 'touch').checkpointId,
    });

    expect(result.ok).toBe(true);
    expect(result.restored!.freshSessions).toEqual([]);
    expect(result.detail).not.toContain('new session');
  });
});

describe('a later attempt at the same phase', () => {
  it('is its own restore target, and restoring one leaves the other readable', async () => {
    // The check passes only once fix.txt exists, so the first pass routes
    // feedback back into `build` and enters it a second time.
    writeFileSync(join(h.repo, 'check.sh'), '#!/bin/sh\ntest -f fix.txt\n');
    sh(h.repo, ['chmod', '+x', 'check.sh']);
    sh(h.repo, ['git', 'add', '-A']);
    sh(h.repo, ['git', 'commit', '-qm', 'add check']);

    const scripted = new ScriptedAgent([buildEnvelope(), buildEnvelope()], [null, 'fix.txt']);
    const outcome = await run({
      scripted,
      project: { commands: [{ name: 'test', argv: ['./check.sh'] }] },
      pipeline: pipe(
        [
          agentPhase('build'),
          codePhase('test', { ref: 'test' }, { feedbackTo: 'build', feedbackRetries: 2 }),
        ],
        { acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' } },
      ),
    });
    expect(outcome.status).toBe('accepted');

    // An accepted run with `mergePolicy: never` keeps its worktree, but it is
    // not terminal in the restorable sense, so the list says why.
    const accepted = await listRestorableCheckpoints(scope(), outcome.runId);
    expect(accepted.refusal).toBe('run_not_terminal');
    expect(accepted.checkpoints.filter((c) => c.phaseName === 'build')).toHaveLength(2);
    expect(
      accepted.checkpoints.filter((c) => c.phaseName === 'build').map((c) => c.generation),
    ).toEqual([1, 2]);
  });
});

describe('the list of restorable checkpoints', () => {
  it('labels every recorded checkpoint for a picker', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const listed = await listRestorableCheckpoints(scope(), runId);

    expect(listed.runId).toBe(runId);
    expect(listed.refusal).toBeNull();
    expect(listed.detail).toBe('');
    expect(listed.checkpoints.map((c) => c.phaseName)).toEqual(['dirty', 'build']);
    for (const checkpoint of listed.checkpoints) {
      expect(checkpoint.generation).toBe(1);
      expect(checkpoint.createdAt).toBeTruthy();
      expect(checkpoint.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(checkpoint.restorable).toBe(true);
      expect(checkpoint.exactRestorePossible).toBe(true);
      expect(checkpoint.blocker).toBeUndefined();
      expect(checkpoint.omittedPaths).toEqual([]);
      expect(checkpoint.commitsSince).toBe(0);
    }
    const build = listed.checkpoints.find((c) => c.phaseName === 'build')!;
    expect(build.phaseKind).toBe('agent');
    expect(build.agent).toBe('builder');
    expect(build.model).toBe('scripted/model');
    // tracked.txt modified plus extra.txt untracked, as the code phase left it.
    expect(build.fileCount).toBe(2);
    expect(build.untrackedCount).toBe(1);
    expect(listed.checkpoints.find((c) => c.phaseName === 'dirty')!.agent).toBeNull();
  });

  it('counts the commits a restore to each checkpoint would move off', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    writeFileSync(join(worktree, 'later.txt'), 'later\n');
    sh(worktree, ['git', 'add', '-A']);
    sh(worktree, ['git', 'commit', '-qm', 'later work']);

    const listed = await listRestorableCheckpoints(scope(), runId);
    for (const checkpoint of listed.checkpoints) {
      expect(checkpoint.commitsSince).toBe(1);
      expect(checkpoint.commitsSinceShas).toHaveLength(1);
    }
  });

  it('answers with an empty list for a run recorded before checkpoints shipped', async () => {
    h.tracer.startRun({
      runId: 'run_before_checkpoints',
      projectId: h.project.id,
      pipeline: pipe([]),
      request: 'x',
      engineer: 'test',
      worktreePath: h.repo,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    h.tracer.finishRun('run_before_checkpoints', 'failed', 'stopped');

    const listed = await listRestorableCheckpoints(scope(), 'run_before_checkpoints');
    expect(listed.checkpoints).toEqual([]);
    expect(listed.refusal).toBe('no_checkpoints');
    expect(listed.detail).toBe(
      'this run recorded no phase checkpoints, so there is nothing to restore to',
    );
  });

  it('still lists a merged run’s checkpoints, with the reason they cannot be used', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    h.tracer.setMerged(runId, true);

    const listed = await listRestorableCheckpoints(scope(), runId);
    expect(listed.refusal).toBe('run_merged');
    expect(listed.checkpoints).toHaveLength(2);
  });
});
