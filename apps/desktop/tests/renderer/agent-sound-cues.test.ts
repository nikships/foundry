/**
 * Milestone sounds fire on orchestrator turns, proposed pipelines, finished
 * phases, settled runs, and new Smith proposals — never on the first historical
 * snapshot, and never on tool chatter that never reaches this view-model.
 */

import { describe, expect, it } from 'vitest';
import type { OrchestratorState } from '@shared/ipc-contract.js';
import type { PhaseStatus, RunRow, RunStatus } from '@shared/types.js';
import {
  isOrchestratorPingNote,
  orchestratorCues,
  runCues,
  smithCues,
  snapshotOrchestrator,
  snapshotRun,
  snapshotSmith,
  type OrchestratorCueSnapshot,
  type RunCueSnapshot,
} from '@renderer/view-models/agent-sound-cues.js';

function orch(
  over: Partial<OrchestratorCueSnapshot> & Pick<OrchestratorCueSnapshot, 'planId'>,
): OrchestratorCueSnapshot {
  return {
    status: 'running',
    hasPlan: false,
    revision: 0,
    pingKeys: [],
    ...over,
  };
}

function runSnap(
  over: Partial<RunCueSnapshot> & Pick<RunCueSnapshot, 'runId'> = { runId: 'run_1' },
): RunCueSnapshot {
  return {
    status: 'running',
    phases: [],
    ...over,
  };
}

describe('isOrchestratorPingNote', () => {
  it('recognises the ask and the correction retry, not setup notes', () => {
    expect(isOrchestratorPingNote('Asking the Orchestrator (anthropic/claude)…')).toBe(true);
    expect(isOrchestratorPingNote('Sending the validation errors back (attempt 2 of 4)…')).toBe(
      true,
    );
    expect(isOrchestratorPingNote('Reading the models this install can reach…')).toBe(false);
    expect(isOrchestratorPingNote('Rejected: phases: missing')).toBe(false);
  });
});

describe('snapshotOrchestrator', () => {
  it('keeps ping keys off tool and text entries', () => {
    const state = {
      planId: 'plan-1',
      status: 'running',
      revision: 0,
      plan: null,
      entries: [
        { id: 'n1', kind: 'note', text: 'Asking the Orchestrator…', at: 1 },
        { id: 't1', kind: 'tool', text: 'read README.md', at: 2, toolKind: 'read' },
        { id: 'x1', kind: 'text', text: 'thinking out loud', at: 3 },
      ],
    } as OrchestratorState;
    expect(snapshotOrchestrator(state).pingKeys).toEqual(['n1']);
  });
});

describe('orchestratorCues', () => {
  it('pings when a new ask note lands, including the first snapshot', () => {
    expect(orchestratorCues(undefined, orch({ planId: 'p', pingKeys: ['a'] }))).toEqual([
      'orchestrator-ping',
    ]);
    expect(
      orchestratorCues(
        orch({ planId: 'p', pingKeys: ['a'] }),
        orch({ planId: 'p', pingKeys: ['a', 'b'] }),
      ),
    ).toEqual(['orchestrator-ping']);
  });

  it('does not treat an already-present plan on first snapshot as a proposal', () => {
    expect(orchestratorCues(undefined, orch({ planId: 'p', hasPlan: true, revision: 1 }))).toEqual(
      [],
    );
  });

  it('proposes when a plan first appears or is revised', () => {
    expect(
      orchestratorCues(orch({ planId: 'p' }), orch({ planId: 'p', hasPlan: true, revision: 1 })),
    ).toEqual(['plan-proposed']);
    expect(
      orchestratorCues(
        orch({ planId: 'p', hasPlan: true, revision: 1 }),
        orch({ planId: 'p', hasPlan: true, revision: 2 }),
      ),
    ).toEqual(['plan-proposed']);
  });
});

describe('runCues', () => {
  it('is silent the first time a still-running run appears', () => {
    expect(
      runCues(
        undefined,
        runSnap({
          runId: 'run_1',
          status: 'running',
          phases: [{ name: 'build', status: 'success' }],
        }),
      ),
    ).toEqual([]);
  });

  it('settles a run that appears already finished after the historical load', () => {
    expect(
      runCues(
        undefined,
        runSnap({
          runId: 'run_1',
          status: 'accepted',
          phases: [{ name: 'build', status: 'success' }],
        }),
      ),
    ).toEqual(['run-accepted']);
  });

  it('sounds each finished phase and the settled run, not skipped or still-running ones', () => {
    const prev = runSnap({
      runId: 'run_1',
      phases: [
        { name: 'scout', status: 'success' },
        { name: 'build', status: 'running' },
        { name: 'review', status: 'queued' },
      ],
    });
    expect(
      runCues(prev, {
        ...prev,
        phases: [
          { name: 'scout', status: 'success' },
          { name: 'build', status: 'success' },
          { name: 'review', status: 'queued' },
        ],
      }),
    ).toEqual(['phase-success']);
    expect(
      runCues(prev, {
        ...prev,
        phases: [
          { name: 'scout', status: 'success' },
          { name: 'build', status: 'fail' },
          { name: 'review', status: 'queued' },
        ],
      }),
    ).toEqual(['phase-fail']);
    expect(
      runCues(
        { ...prev, status: 'running' },
        {
          runId: 'run_1',
          status: 'accepted',
          phases: [
            { name: 'scout', status: 'success' },
            { name: 'build', status: 'success' },
            { name: 'review', status: 'success' },
          ],
        },
      ),
    ).toEqual(['run-accepted']);
  });

  it.each<[RunStatus, 'run-accepted' | 'run-rejected' | 'run-failed']>([
    ['accepted', 'run-accepted'],
    ['rejected', 'run-rejected'],
    ['failed', 'run-failed'],
    ['killed', 'run-failed'],
  ])('maps a %s settlement to %s', (status, cue) => {
    expect(runCues(runSnap({ runId: 'run_1' }), runSnap({ runId: 'run_1', status }))).toEqual([
      cue,
    ]);
  });
});

describe('snapshotRun', () => {
  it('reads phaseSummary and ignores a missing one', () => {
    const run = { runId: 'run_1', status: 'running' } as RunRow;
    expect(snapshotRun(run).phases).toEqual([]);
    expect(
      snapshotRun({
        ...run,
        phaseSummary: [{ name: 'build', status: 'success' as PhaseStatus, kind: 'agent' }],
      }).phases,
    ).toEqual([{ name: 'build', status: 'success' }]);
  });
});

describe('smithCues', () => {
  it('is silent on the first pending list and pings only for a new id', () => {
    const first = snapshotSmith([{ id: 'old' }]);
    expect(smithCues(undefined, first)).toEqual([]);
    expect(smithCues(first, first)).toEqual([]);
    expect(smithCues(first, snapshotSmith([{ id: 'old' }, { id: 'new' }]))).toEqual(['needs-you']);
  });
});
