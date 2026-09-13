import type { ProposalSnapshot } from '../../src/shared/types.js';

export function runPlanFixture(projectId = 'project'): ProposalSnapshot {
  const planId = 'plan-artifact-fixture';
  return {
    planId,
    projectId,
    prompt: 'Improve the help text.',
    model: 'fixture/model',
    reasoningEffort: 'medium',
    status: 'ready',
    detail: '',
    entries: [],
    rawReply: 'private raw reply',
    messages: [],
    revision: 1,
    acceptedRunId: null,
    acceptedPlan: null,
    createdAt: 1,
    updatedAt: 2,
    plan: {
      planId,
      projectId,
      prompt: 'Improve the help text.',
      refinedRequest: 'Make help text explain the next action. Keep existing shortcuts.',
      rationale: 'Build the change, then run the project checks.',
      model: 'fixture/model',
      reasoningEffort: 'medium',
      agents: [],
      warnings: [],
      pipeline: {
        id: 'generated-artifact-fixture',
        name: 'Help text',
        description: 'A focused help-text change.',
        acceptance: { kind: 'all_phases_pass' },
        phases: [
          {
            name: 'build',
            kind: 'agent',
            agent: 'builder',
            model: 'fixture/model',
            reasoningEffort: 'high',
            description: 'Improve help.',
            envelope: 'build',
          },
          {
            name: 'test',
            kind: 'code',
            command: { argv: ['true'] },
            description: 'Check the change.',
          },
        ],
      },
    },
  };
}
