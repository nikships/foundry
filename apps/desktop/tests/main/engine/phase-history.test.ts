import { describe, expect, it } from 'vitest';
import type { PhaseRow, PipelineDef } from '@shared/types.js';
import { activeRowsForPipeline } from '@main/engine/phase-history.js';

const pipeline: PipelineDef = {
  id: 'amended',
  name: 'Amended',
  description: 'A pipeline whose failed tail was replaced.',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    {
      name: 'build',
      kind: 'code',
      description: 'Build the requested artifact.',
      command: { argv: ['true'] },
    },
    {
      name: 'verify',
      kind: 'code',
      description: 'Verify the repaired artifact.',
      command: { argv: ['true'] },
    },
  ],
};

function row(phaseId: string, name: string, status: PhaseRow['status'], seq: number): PhaseRow {
  return {
    phaseId,
    runId: 'run-1',
    seq,
    name,
    kind: 'code',
    owner: 'code',
    description: `${name} phase`,
    status,
    attempt: 0,
    error: null,
    startedAt: null,
    endedAt: null,
  };
}

describe('active amended phase history', () => {
  it('uses the latest row for a reintroduced phase and ignores removed failures', () => {
    const active = activeRowsForPipeline(pipeline, [
      row('old-build', 'build', 'fail', 0),
      row('removed-tail', 'obsolete', 'fail', 1),
      row('new-build', 'build', 'success', 2),
      row('verify', 'verify', 'success', 3),
    ]);

    expect(active?.map((phase) => phase.phaseId)).toEqual(['new-build', 'verify']);
    expect(active?.some((phase) => phase.status === 'fail')).toBe(false);
  });

  it('refuses history that cannot represent the persisted pipeline', () => {
    expect(activeRowsForPipeline(pipeline, [row('build', 'build', 'success', 0)])).toBeNull();
  });
});
