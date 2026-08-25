/**
 * Who may continue a settled run.
 *
 * Every Continue affordance — the desktop banner through IPC, the Companion
 * route, Smith's run tool — refuses through this one decision, so they cannot
 * disagree about whether a killed run can be picked up or about the words the
 * refusal uses.
 */

import { describe, expect, it } from 'vitest';
import { continueDetail, continueEligibility } from '../../../src/main/engine/continue-run.js';
import type { PhaseRow, PipelineDef, RunRow, RunStatus } from '../../../src/shared/types.js';

const pipeline: PipelineDef = {
  id: 'p',
  name: 'p',
  description: 'test pipeline',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    { name: 'prepare', kind: 'code', description: 'prepare', command: { argv: ['true'] } },
    { name: 'build', kind: 'agent', agent: 'builder', description: 'build', envelope: 'build' },
  ],
};

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
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    totalTokens: 0,
    ...over,
  };
}

function phases(buildStatus: PhaseRow['status'] = 'fail'): PhaseRow[] {
  return [
    phase({ phaseId: 'ph_1', seq: 0, name: 'prepare', kind: 'code', status: 'success' }),
    phase({ phaseId: 'ph_2', seq: 1, name: 'build', kind: 'agent', status: buildStatus }),
  ];
}

function phase(over: Partial<PhaseRow> & Pick<PhaseRow, 'phaseId' | 'name'>): PhaseRow {
  return {
    runId: 'run_1',
    seq: 0,
    kind: 'agent',
    owner: 'builder',
    description: over.name,
    status: 'success',
    attempt: 1,
    error: null,
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

const eligible = (over: Partial<RunRow> = {}, rows = phases()) =>
  continueEligibility({ run: run(over), pipeline, phases: rows, worktreeExists: () => true });

describe('continueEligibility', () => {
  it('continues a killed run on a fresh session', () => {
    const answer = eligible();
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.strategy).toBe('fresh_session');
    expect(answer.failedPhase.name).toBe('build');
  });

  it.each<RunStatus>(['rejected', 'failed'])(
    'continues a %s run by reopening the persisted session',
    (status) => {
      const answer = eligible({ status });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(answer.strategy).toBe('reopen_session');
    },
  );

  it.each<RunStatus>(['accepted', 'running'])('refuses a %s run by status', (status) => {
    expect(eligible({ status })).toEqual({
      ok: false,
      detail: 'only a rejected, failed, or killed run can be continued',
    });
  });

  it('refuses a merged killed run', () => {
    expect(eligible({ merged: true })).toEqual({
      ok: false,
      detail: 'a merged run cannot be continued',
    });
  });

  it('refuses a killed run whose worktree is gone', () => {
    const answer = continueEligibility({
      run: run(),
      pipeline,
      phases: phases(),
      worktreeExists: () => false,
    });
    expect(answer).toEqual({ ok: false, detail: 'this run’s worktree is no longer available' });
  });

  it('refuses a killed run with no active failed phase', () => {
    expect(eligible({}, phases('success'))).toEqual({
      ok: false,
      detail: 'this run has no failed phase to continue',
    });
  });

  it('refuses when the saved pipeline is missing or belongs to another pipeline', () => {
    const missing = continueEligibility({ run: run(), pipeline: null, phases: phases() });
    expect(missing).toEqual({
      ok: false,
      detail: 'this run’s saved pipeline is no longer available',
    });
    const other = continueEligibility({
      run: run({ pipelineId: 'other' }),
      pipeline,
      phases: phases(),
    });
    expect(other).toEqual({
      ok: false,
      detail: 'this run’s saved pipeline is no longer available',
    });
  });

  it('refuses when the phase history no longer matches the saved pipeline', () => {
    const answer = continueEligibility({
      run: run(),
      pipeline,
      phases: [phase({ phaseId: 'ph_1', name: 'prepare', kind: 'code', status: 'success' })],
      worktreeExists: () => true,
    });
    expect(answer).toEqual({
      ok: false,
      detail: 'the saved pipeline no longer matches this run’s phase history',
    });
  });
});

describe('continueDetail', () => {
  it('says the killed phase restarts rather than resumes', () => {
    expect(continueDetail('fresh_session', 'build')).toBe('Restarting “build” in a new session…');
    expect(continueDetail('reopen_session', 'build')).toBe('Continuing from “build”…');
  });
});
