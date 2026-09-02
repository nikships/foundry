import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { startLinearIssueRun } from '../../../src/main/linear/orchestration.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import type { StartRunDeps } from '../../../src/main/engine/operations.js';
import type {
  GeneratedRunPlan,
  LinearIssueSnapshot,
  LinearStatusMapping,
  LinearWorkflowState,
  PipelineDef,
} from '../../../src/shared/types.js';

const workflow: LinearWorkflowState[] = [
  { id: 'todo', name: 'Todo', type: 'unstarted' },
  { id: 'started', name: 'In Progress', type: 'started' },
  { id: 'completed', name: 'Done', type: 'completed' },
  { id: 'failed', name: 'Canceled', type: 'canceled' },
];
const statusMapping: LinearStatusMapping = {
  started: 'started',
  completed: 'completed',
  failed: 'failed',
};
const issue: LinearIssueSnapshot = {
  id: 'issue-uuid',
  identifier: 'FOU-190',
  title: 'Add Linear ticket orchestration integration',
  description: 'Use this issue as the run brief.',
  url: 'https://linear.app/foundry/issue/FOU-190',
  updatedAt: '2026-08-25T19:09:16.054Z',
  team: { id: 'team-uuid', name: 'Foundry' },
  state: workflow[0]!,
};
const pipeline: PipelineDef = {
  id: 'ship',
  name: 'Ship',
  description: 'Run one deterministic check.',
  phases: [
    {
      name: 'check',
      kind: 'code',
      description: 'Verify the implementation.',
      command: { argv: ['true'] },
    },
  ],
  acceptance: { kind: 'all_phases_pass' },
};

function generatedPlan(projectId: string): GeneratedRunPlan {
  return {
    planId: 'plan-linear',
    projectId,
    prompt: 'the raw Linear issue brief',
    refinedRequest: 'Implement the Linear issue with a focused regression test.',
    rationale: 'A generated verification pipeline fits this issue.',
    pipeline: {
      ...pipeline,
      id: 'generated-plan-linear',
      name: 'Generated Linear plan',
    },
    agents: [],
    warnings: [],
    model: 'inherit',
    reasoningEffort: 'medium',
  };
}

function harness(snapshot: LinearIssueSnapshot = issue): {
  deps: StartRunDeps;
  projectId: string;
  linear: {
    issue(id: string): Promise<LinearIssueSnapshot>;
    workflowStates(teamId: string): Promise<LinearWorkflowState[]>;
  };
  issueIds: string[];
  teamIds: string[];
  started: Parameters<StartRunDeps['registry']['start']>[0][];
} {
  const project = defaultProject(tempDir('foundry-linear-start-'));
  const issueIds: string[] = [];
  const teamIds: string[] = [];
  const started: Parameters<StartRunDeps['registry']['start']>[0][] = [];
  return {
    projectId: project.id,
    deps: {
      projectById: (id) => (id === project.id ? project : null),
      pipelineFor: (projectId, pipelineId) =>
        projectId === project.id && pipelineId === pipeline.id ? pipeline : null,
      rosterFor: () => [],
      envelopeDefs: () => [],
      settings: () => defaultSettings(),
      saveProject: (next) => next,
      oneShot: () => {
        throw new Error('Linear start should use the ordinary preflight without detection here');
      },
      registry: {
        start: (input) => {
          started.push(input);
          return 'run-linear';
        },
      },
    },
    linear: {
      issue: async (id) => {
        issueIds.push(id);
        return snapshot;
      },
      workflowStates: async (teamId) => {
        teamIds.push(teamId);
        return workflow;
      },
    },
    issueIds,
    teamIds,
    started,
  };
}

describe('startLinearIssueRun', () => {
  it('re-fetches the issue and starts the ordinary pipeline with an immutable source snapshot', async () => {
    const h = harness();

    const result = await startLinearIssueRun(h.deps, h.linear, statusMapping, {
      projectId: h.projectId,
      pipelineId: pipeline.id,
      issueId: issue.id,
    });

    expect(result).toEqual({ ok: true, runId: 'run-linear', issues: [] });
    expect(h.issueIds).toEqual([issue.id]);
    expect(h.teamIds).toEqual([issue.team.id]);
    const startInput = h.started[0]!;
    expect(startInput.pipeline).toBe(pipeline);
    expect(startInput.request).toBe(`Implement ${issue.identifier}: ${issue.title}`);
    expect(startInput.request).not.toContain(issue.description);
    expect(startInput.source).toEqual({
      kind: 'linear',
      trigger: 'manual',
      issueId: issue.id,
      url: issue.url,
      revision: issue.updatedAt,
      statusMapping,
      snapshot: issue,
    });
    expect(startInput.source?.statusMapping).not.toBe(statusMapping);
  });

  it('rejects missing or stale workflow mappings before entering the registry', async () => {
    const h = harness();
    const result = await startLinearIssueRun(
      h.deps,
      h.linear,
      { started: null, completed: 'not-this-team', failed: 'failed' },
      { projectId: h.projectId, pipelineId: pipeline.id, issueId: issue.id },
    );

    expect(result.ok).toBe(false);
    expect(result.issues.map((problem) => problem.where)).toEqual([
      'linear.status.started',
      'linear.status.completed',
    ]);
    expect(h.started).toHaveLength(0);
  });

  it('starts an orchestrated Linear run with the plan pipeline and refined request', async () => {
    const h = harness();
    const plan = generatedPlan(h.projectId);

    const result = await startLinearIssueRun(h.deps, h.linear, statusMapping, {
      projectId: h.projectId,
      pipelineId: plan.pipeline.id,
      issueId: issue.id,
      plan,
    });

    expect(result).toEqual({ ok: true, runId: 'run-linear', issues: [] });
    const startInput = h.started[0]!;
    expect(startInput.pipeline).toBe(plan.pipeline);
    expect(startInput.request).toBe(plan.refinedRequest);
    expect(startInput.plan).toBe(plan);
    expect(startInput.source).toMatchObject({
      kind: 'linear',
      issueId: issue.id,
      snapshot: issue,
    });
  });

  it('keeps a large issue description on the snapshot, not in the run request', async () => {
    const largeIssue = { ...issue, description: 'x'.repeat(40_000) };
    const h = harness(largeIssue);

    await startLinearIssueRun(h.deps, h.linear, statusMapping, {
      projectId: h.projectId,
      pipelineId: pipeline.id,
      issueId: issue.id,
    });

    const startInput = h.started[0]!;
    expect(startInput.request).toBe(`Implement ${issue.identifier}: ${issue.title}`);
    expect(startInput.request).not.toContain('x'.repeat(20));
    expect(startInput.source?.snapshot.description).toHaveLength(40_000);
  });
});
