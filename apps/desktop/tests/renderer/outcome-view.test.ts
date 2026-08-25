/**
 * What the outcome banner offers and says.
 *
 * The killed case is the one that has to be right: the operator stopped the
 * run, so the copy must neither pretend the work is gone nor promise a clean
 * replay of a phase that was cut off mid-write.
 */

import { describe, expect, it } from 'vitest';
import type { PhaseRow, RunRow, RunStatus } from '@shared/types.js';
import {
  canResumeRun,
  outcomeExplanation,
  outcomeHeadline,
  resumeTitleFor,
} from '@renderer/view-models/outcome-view.js';

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    runId: 'run_1',
    projectId: 'proj_1',
    pipelineId: 'p',
    pipelineName: 'p',
    request: 'do the thing',
    status: 'killed',
    engineer: 'test',
    worktreePath: '/tmp/foundry-worktree',
    branch: 'foundry/run_1',
    baseRef: 'main',
    branchPointSha: 'abc123',
    outcomeDetail: 'the run was killed',
    prNumber: null,
    prUrl: null,
    issueNumber: null,
    issueUrl: null,
    source: null,
    sourceSyncError: null,
    merged: false,
    archived: false,
    mode: 'pi',
    orchestrated: false,
    amendments: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    totalTokens: 0,
    ...over,
  };
}

function phases(status: PhaseRow['status'] = 'fail', kind: PhaseRow['kind'] = 'agent'): PhaseRow[] {
  return [
    {
      phaseId: 'ph_1',
      runId: 'run_1',
      seq: 0,
      name: 'build',
      kind,
      owner: 'builder',
      description: 'build it',
      status,
      attempt: 1,
      error: null,
      startedAt: null,
      endedAt: null,
    },
  ];
}

describe('canResumeRun', () => {
  it('offers Continue on a killed run with a worktree and an interrupted phase', () => {
    expect(canResumeRun(run(), true)).toBe(true);
  });

  it.each<RunStatus>(['rejected', 'failed'])('still offers Continue on a %s run', (status) => {
    expect(canResumeRun(run({ status }), true)).toBe(true);
  });

  it.each<RunStatus>(['accepted', 'running'])('hides Continue on a %s run', (status) => {
    expect(canResumeRun(run({ status }), true)).toBe(false);
  });

  it('hides Continue on a merged killed run, a discarded worktree, or nothing red', () => {
    expect(canResumeRun(run({ merged: true }), true)).toBe(false);
    expect(canResumeRun(run({ worktreePath: null }), true)).toBe(false);
    expect(canResumeRun(run(), false)).toBe(false);
  });
});

describe('resumeTitleFor', () => {
  it('describes a killed agent phase as a restart in a new session', () => {
    const title = resumeTitleFor(run(), phases());
    expect(title).toBe('Restart the interrupted phase in a new session, in the same worktree');
    expect(title).not.toMatch(/[Rr]etry the first failed phase/);
  });

  it('promises no new session for a killed command phase', () => {
    // A `code` phase has no conversation, so the engine reopens nothing — the
    // button must not claim otherwise.
    expect(resumeTitleFor(run(), phases('fail', 'code'))).toBe(
      'Retry the first failed phase and continue this pipeline in the same worktree',
    );
  });

  it('leaves the correction wording on a failed run', () => {
    expect(resumeTitleFor(run({ status: 'failed' }), phases())).toBe(
      'Retry the first failed phase and continue this pipeline in the same worktree',
    );
  });
});

describe('outcomeExplanation', () => {
  it('says a continuable killed run restarts its phase in a new session', () => {
    const copy = outcomeExplanation(run(), phases(), { canResume: true });
    expect(copy).toContain('You stopped this run');
    expect(copy).toContain('during “build”');
    expect(copy).toContain('new session');
    // Not a correction, not a clean replay, and not a write-off.
    expect(copy).not.toMatch(/reopen/i);
    expect(copy).not.toMatch(/clean/i);
    expect(copy).not.toMatch(/replay/i);
    expect(copy).not.toMatch(/abandon/i);
    expect(copy).not.toMatch(/discard/i);
  });

  it('describes a killed command phase as a re-run, not a new session', () => {
    const copy = outcomeExplanation(run(), phases('fail', 'code'), { canResume: true });
    expect(copy).toContain('You stopped this run');
    expect(copy).toContain('during “build”');
    // Still continuable — the affordance stays, only the false promise goes.
    expect(copy).toContain('Continue re-runs that phase');
    expect(copy).not.toMatch(/new session/);
    expect(copy).not.toMatch(/agent/i);
  });

  it('does not offer to continue a killed run that cannot be continued', () => {
    const copy = outcomeExplanation(run({ merged: true }), phases(), { canResume: false });
    expect(copy).toContain('still on its branch');
    expect(copy).not.toMatch(/new session/);
  });

  it('leaves the other statuses alone', () => {
    expect(outcomeExplanation(run({ status: 'accepted', outcomeDetail: null }), phases())).toBe(
      'Every phase passed and the acceptance criterion was met.',
    );
    expect(
      outcomeExplanation(run({ status: 'rejected', outcomeDetail: null }), phases()),
    ).toContain('(build failed)');
    expect(outcomeExplanation(run({ status: 'failed', outcomeDetail: 'boom' }), phases())).toBe(
      'boom',
    );
  });
});

describe('outcomeHeadline', () => {
  it('reads as an operator action rather than a crash', () => {
    expect(outcomeHeadline('killed')).toBe('Stopped');
    expect(outcomeHeadline('accepted')).toBe('Accepted');
    expect(outcomeHeadline('rejected')).toBe('Not accepted');
    expect(outcomeHeadline('failed')).toBe('Failed');
  });
});
