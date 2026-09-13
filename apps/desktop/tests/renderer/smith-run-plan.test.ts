import { describe, expect, it } from 'vitest';
import { smithRunPlanArtifact } from '../../src/shared/smith-run-plan.js';
import {
  artifactName,
  isRenderableArtifact,
} from '../../src/renderer/view-models/smith-artifact-view.js';
import { runPlanFixture } from '../helpers/run-plan.js';

describe('renderer run_plan projection', () => {
  it('projects explicit phase fields, excluding prompts, entries, raw replies and plan JSON', () => {
    const row = runPlanFixture();
    const artifact = smithRunPlanArtifact(row);
    expect(artifact.title).toBe('Make help text explain the next action.');
    expect(artifact.phases).toEqual([
      {
        index: 0,
        name: 'build',
        kind: 'agent',
        agent: 'builder',
        model: 'fixture/model',
        reasoningEffort: 'high',
        synthesized: false,
      },
      { index: 1, name: 'test', kind: 'code', command: 'true' },
    ]);
    expect(Object.keys(artifact).sort()).toEqual([
      'createdAt',
      'id',
      'kind',
      'phases',
      'planId',
      'projectId',
      'rationale',
      'refinedRequest',
      'revision',
      'status',
      'title',
      'version',
      'warnings',
    ]);
    expect(JSON.stringify(artifact)).not.toContain('private raw reply');
    expect(isRenderableArtifact(artifact)).toBe(true);
    expect(artifactName(artifact)).toBe(artifact.title);
  });

  it('bounds text and warnings and uses the accepted recast rather than the original plan', () => {
    const row = runPlanFixture();
    row.plan!.refinedRequest = 'b'.repeat(2001);
    row.plan!.rationale = 'r'.repeat(1001);
    row.plan!.warnings = Array.from({ length: 21 }, () => ({
      level: 'warning',
      where: 'phase',
      message: 'Warning',
    }));
    row.acceptedPlan = {
      ...row.plan!,
      pipeline: {
        ...row.plan!.pipeline,
        phases: [{ ...row.plan!.pipeline.phases[0]!, model: 'other/recast' }],
      },
    };
    row.acceptedRunId = 'run-accepted';
    row.status = 'accepted';
    const artifact = smithRunPlanArtifact(row);
    expect(artifact.title).toHaveLength(120);
    expect(artifact.refinedRequest).toHaveLength(2000);
    expect(artifact.rationale).toHaveLength(1000);
    expect(artifact.warnings).toHaveLength(20);
    expect(artifact.phases[0]!.model).toBe('other/recast');
    expect(artifact.acceptedRunId).toBe('run-accepted');
  });
});
