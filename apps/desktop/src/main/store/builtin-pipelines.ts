/**
 * The pipelines Foundry ships with. Every one is an editable copy in the
 * Designer, not a locked recipe: `builtin` only marks where it came from.
 *
 * A phase name identifies; a description explains. Both are required, and the
 * Designer enforces at edit time that a description does not merely echo its
 * name — the same rule SSSF enforces at construction, moved to where a human
 * can still fix it.
 */

import type { PhaseDef, PipelineDef } from '@shared/types.js';

function planPhase(): PhaseDef {
  return {
    name: 'plan',
    kind: 'agent',
    agent: 'planner',
    description: 'Turn the request into a plan the builder needs no questions to implement.',
    envelope: 'plan',
    gates: ['artifacts_exist', 'files_non_empty'],
    prompt: { template: 'user', inputs: ['request'] },
  };
}

function commitPlanPhase(): PhaseDef {
  return {
    name: 'commit_plan',
    kind: 'code',
    description: 'Record the spec as its own commit so the plan has a history separate from the work.',
    command: { builtin: 'git_commit', messageFrom: 'envelope:plan.commit_message' },
  };
}

function buildPhase(): PhaseDef {
  return {
    name: 'build',
    kind: 'agent',
    agent: 'builder',
    retries: 2,
    description: 'Implement the plan exactly and report every changed file.',
    envelope: 'build',
    gates: ['diff_matches_claims'],
    prompt: { template: 'user', inputs: ['request', 'envelope:plan'] },
  };
}

function commitBuildPhase(description = 'Commit the implementation using the message the builder proposed for it.'): PhaseDef {
  return {
    name: 'commit_build',
    kind: 'code',
    description,
    command: { builtin: 'git_commit', messageFrom: 'envelope:build.commit_message' },
  };
}

function testPhase(
  description = "Run the project's test command and capture the evidence either way.",
): PhaseDef {
  return {
    name: 'test',
    kind: 'code',
    description,
    command: { ref: 'test' },
    feedbackTo: 'build',
    feedbackRetries: 2,
  };
}

function reviewPhase(): PhaseDef {
  return {
    name: 'review',
    kind: 'agent',
    agent: 'reviewer',
    description: 'Check the built work against the original request, one finding per requirement.',
    envelope: 'review',
    gates: ['verdict_consistent'],
    prompt: { template: 'user', inputs: ['request', 'envelope:plan', 'envelope:build'] },
  };
}

export const BUILTIN_PIPELINES: PipelineDef[] = [
  {
    id: 'prompt',
    name: 'Prompt',
    description: 'One agent, one turn, one envelope. The smallest useful run.',
    acceptance: { kind: 'last_phase_pass' },
    isolation: false,
    builtin: true,
    phases: [
      {
        name: 'respond',
        kind: 'agent',
        agent: 'builder',
        description: 'Answer the request directly with a single bounded agent turn.',
        envelope: 'generic',
        gates: ['artifacts_exist'],
        prompt: { template: 'user', inputs: ['request'] },
      },
    ],
  },
  {
    id: 'scout',
    name: 'Scout',
    description: 'Read-only reconnaissance: answer a question about the codebase with evidence.',
    acceptance: { kind: 'envelope_status', phase: 'scout' },
    isolation: false,
    builtin: true,
    phases: [
      {
        name: 'scout',
        kind: 'agent',
        agent: 'scout',
        description: 'Investigate the question against the real tree and report located findings.',
        envelope: 'scout',
        gates: ['artifacts_exist'],
        prompt: { template: 'user', inputs: ['request'] },
      },
    ],
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Produce a spec concrete enough to implement, and commit it.',
    acceptance: { kind: 'envelope_status', phase: 'plan' },
    builtin: true,
    phases: [planPhase(), commitPlanPhase()],
  },
  {
    id: 'plan-build',
    name: 'Plan → Build',
    description: 'Spec first, then implement it, with each step committed separately.',
    acceptance: { kind: 'envelope_status', phase: 'build' },
    builtin: true,
    phases: [planPhase(), commitPlanPhase(), buildPhase(), commitBuildPhase()],
  },
  {
    id: 'plan-build-test',
    name: 'Plan → Build → Test',
    description: "The standard chain: spec first, implement, then prove it with the project's own tests.",
    acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
    builtin: true,
    phases: [
      planPhase(),
      commitPlanPhase(),
      buildPhase(),
      testPhase(),
      commitBuildPhase('Commit the implementation once its tests are green.'),
    ],
  },
  {
    id: 'plan-build-review',
    name: 'Plan → Build → Review',
    description: 'Implement against a spec, then have a second agent check it against the request.',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    builtin: true,
    phases: [planPhase(), buildPhase(), commitBuildPhase(), reviewPhase()],
  },
  {
    id: 'full-sdlc',
    name: 'Full SDLC',
    description: 'Plan, build, test, review, and document, committing at each meaningful boundary.',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    builtin: true,
    phases: [
      planPhase(),
      commitPlanPhase(),
      buildPhase(),
      testPhase("Run the project's test command and send failures back to the builder as evidence."),
      commitBuildPhase('Commit the implementation once its tests are green.'),
      reviewPhase(),
      {
        name: 'document',
        kind: 'agent',
        agent: 'documenter',
        description: "Write down what changed for the reader who arrives without this run's context.",
        envelope: 'document',
        gates: ['artifacts_exist', 'files_non_empty'],
        prompt: { template: 'user', inputs: ['request', 'envelope:build'] },
      },
      {
        name: 'commit_docs',
        kind: 'code',
        description: 'Commit the documentation separately so docs churn stays out of the code diff.',
        command: { builtin: 'git_commit', messageFrom: 'envelope:document.summary' },
      },
    ],
  },
];
