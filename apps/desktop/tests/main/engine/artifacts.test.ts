/**
 * The Document tab reads a phase's declared artifacts off disk. These tests
 * use real files in a real temp directory: the read is entirely about what is
 * on disk and where, so mocking the filesystem would test nothing.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnvelopeRow, PhaseRow, RunRow } from '@shared/types.js';
import { readPhaseArtifacts, type ArtifactScope } from '@main/engine/artifacts.js';
import { tempDir } from '../../helpers/tmp.js';

const PHASE_ID = 'phase-plan';
const RUN_ID = 'run-1';

function phase(): PhaseRow {
  return {
    phaseId: PHASE_ID,
    runId: RUN_ID,
    seq: 0,
    name: 'plan',
    kind: 'agent',
    owner: 'planner',
    description: 'Plan the work.',
    status: 'success',
    attempt: 1,
    error: null,
    startedAt: null,
    endedAt: null,
  };
}

function run(overrides: Partial<RunRow>): RunRow {
  return {
    runId: RUN_ID,
    projectId: 'project-1',
    pipelineId: 'plan-build',
    pipelineName: 'Plan then Build',
    request: 'Write a plan.',
    status: 'accepted',
    engineer: 'nik',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    branchPointSha: null,
    outcomeDetail: null,
    source: null,
    sourceSyncError: null,
    merged: false,
    archived: false,
    mode: 'manual',
    fromPlan: false,
    startedAt: new Date().toISOString(),
    endedAt: null,
    ...overrides,
  } as RunRow;
}

function envelope(artifacts: unknown, overrides: Partial<EnvelopeRow> = {}): EnvelopeRow {
  return {
    envelopeId: 'env-1',
    runId: RUN_ID,
    phaseId: PHASE_ID,
    agent: 'planner',
    schemaKind: 'plan',
    payload: { status: 'success', artifacts },
    valid: true,
    attempt: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function scope(
  worktree: string | null,
  envelopes: EnvelopeRow[],
  extra?: Partial<RunRow>,
): ArtifactScope {
  return {
    tracer: {
      phase: () => phase(),
      run: () => run({ worktreePath: worktree, ...extra }),
      envelopes: () => envelopes,
    },
  };
}

describe('reading a phase’s declared documents', () => {
  it('returns the file the plan phase wrote, with its real size', () => {
    const worktree = tempDir('foundry-artifacts-');
    mkdirSync(join(worktree, 'specs'), { recursive: true });
    writeFileSync(join(worktree, 'specs/plan.md'), '# Plan\n\nDo the thing.\n');

    const result = readPhaseArtifacts(scope(worktree, [envelope(['specs/plan.md'])]), PHASE_ID);

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe('specs/plan.md');
    expect(result.files[0]!.content).toContain('# Plan');
    expect(result.files[0]!.bytes).toBeGreaterThan(0);
    expect(result.files[0]!.truncated).toBe(false);
    expect(result.missing).toEqual([]);
  });

  it('reads the latest valid envelope, so a re-entered phase shows its newest document', () => {
    const worktree = tempDir('foundry-artifacts-');
    writeFileSync(join(worktree, 'first.md'), 'first');
    writeFileSync(join(worktree, 'second.md'), 'second');

    const result = readPhaseArtifacts(
      scope(worktree, [
        envelope(['first.md']),
        envelope(['second.md'], { envelopeId: 'env-2', attempt: 2 }),
      ]),
      PHASE_ID,
    );

    expect(result.files.map((f) => f.path)).toEqual(['second.md']);
  });

  it('ignores an invalid envelope, which is not a claim about anything', () => {
    const worktree = tempDir('foundry-artifacts-');
    writeFileSync(join(worktree, 'good.md'), 'good');

    const result = readPhaseArtifacts(
      scope(worktree, [
        envelope(['good.md']),
        envelope(['never-written.md'], { envelopeId: 'env-2', valid: false }),
      ]),
      PHASE_ID,
    );

    expect(result.files.map((f) => f.path)).toEqual(['good.md']);
  });

  it('reports a declared path the agent never wrote, rather than failing the read', () => {
    const worktree = tempDir('foundry-artifacts-');
    writeFileSync(join(worktree, 'written.md'), 'here');

    const result = readPhaseArtifacts(
      scope(worktree, [envelope(['written.md', 'missing.md'])]),
      PHASE_ID,
    );

    expect(result.files.map((f) => f.path)).toEqual(['written.md']);
    expect(result.missing).toEqual([{ path: 'missing.md', reason: 'not_found' }]);
  });

  it('refuses a path that climbs out of the worktree', () => {
    const worktree = tempDir('foundry-artifacts-');
    const outside = tempDir('foundry-outside-');
    writeFileSync(join(outside, 'secret.md'), 'not this run’s work');

    const result = readPhaseArtifacts(
      scope(worktree, [envelope(['../secret.md', '/etc/hosts'])]),
      PHASE_ID,
    );

    expect(result.files).toEqual([]);
    expect(result.missing.map((m) => m.reason)).toEqual(['not_found', 'not_found']);
  });

  it('refuses a symlink, which string math alone cannot see through', () => {
    const worktree = tempDir('foundry-artifacts-');
    const outside = tempDir('foundry-outside-');
    writeFileSync(join(outside, 'secret.md'), 'not this run’s work');
    symlinkSync(join(outside, 'secret.md'), join(worktree, 'link.md'));

    const result = readPhaseArtifacts(scope(worktree, [envelope(['link.md'])]), PHASE_ID);

    expect(result.files).toEqual([]);
    expect(result.missing).toEqual([{ path: 'link.md', reason: 'not_found' }]);
  });

  it('reports a binary file instead of rendering it', () => {
    const worktree = tempDir('foundry-artifacts-');
    writeFileSync(join(worktree, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));

    const result = readPhaseArtifacts(scope(worktree, [envelope(['image.bin'])]), PHASE_ID);

    expect(result.missing).toEqual([{ path: 'image.bin', reason: 'not_text' }]);
  });

  it('says the phase declared nothing rather than reporting a missing file', () => {
    const worktree = tempDir('foundry-artifacts-');
    expect(readPhaseArtifacts(scope(worktree, [envelope([])]), PHASE_ID).reason).toBe(
      'no_artifacts',
    );
  });

  it('falls back to the checkout for a merged run, whose worktree is gone', () => {
    const checkout = tempDir('foundry-checkout-');
    mkdirSync(join(checkout, 'specs'), { recursive: true });
    writeFileSync(join(checkout, 'specs/plan.md'), '# Landed plan\n');

    const base = scope(null, [envelope(['specs/plan.md'])], { merged: true });
    const result = readPhaseArtifacts({ ...base, projectPath: checkout }, PHASE_ID);

    expect(result.files[0]!.content).toContain('# Landed plan');
  });

  it('does not read the checkout for an unmerged run whose worktree was discarded', () => {
    const checkout = tempDir('foundry-checkout-');
    mkdirSync(join(checkout, 'specs'), { recursive: true });
    writeFileSync(join(checkout, 'specs/plan.md'), 'a different run’s file');

    const base = scope(null, [envelope(['specs/plan.md'])]);
    const result = readPhaseArtifacts({ ...base, projectPath: checkout }, PHASE_ID);

    expect(result.files).toEqual([]);
    expect(result.reason).toBe('worktree_gone');
  });
});
