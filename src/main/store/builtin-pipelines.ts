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

function refinePhase(): PhaseDef {
  return {
    name: 'refine',
    kind: 'agent',
    agent: 'refiner',
    description: 'Sharpen the raw request into a brief grounded in this repository.',
    envelope: 'brief',
    prompt: { template: 'user', inputs: ['request'] },
  };
}

/**
 * The planner's own template already renders `{{request}}`, so a refined chain
 * adds the brief alongside it rather than replacing it.
 */
function planPhase(refined = false): PhaseDef {
  return {
    name: 'plan',
    kind: 'agent',
    agent: 'planner',
    description: refined
      ? 'Turn the refined brief into a plan the builder needs no questions to implement.'
      : 'Turn the request into a plan the builder needs no questions to implement.',
    envelope: 'plan',
    gates: ['artifacts_exist', 'files_non_empty'],
    prompt: { template: 'user', inputs: refined ? ['request', 'envelope:refine'] : ['request'] },
  };
}

function commitPlanPhase(): PhaseDef {
  return {
    name: 'commit_plan',
    kind: 'code',
    description:
      'Record the spec as its own commit so the plan has a history separate from the work.',
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

function commitBuildPhase(
  description = 'Commit the implementation using the message the builder proposed for it.',
): PhaseDef {
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

/**
 * The one phase allowed to both judge and fix: a gap it only reported would
 * leave the run rejected with the work still short of the bar. `verdict_consistent`
 * keeps it from approving its way out, and `diff_matches_claims` keeps its
 * repairs visible in the envelope.
 */
function productionCheckPhase(): PhaseDef {
  return {
    name: 'production_check',
    kind: 'agent',
    agent: 'finisher',
    description: 'Audit the work against the ship bar and close the gaps it finds.',
    envelope: 'review',
    gates: ['verdict_consistent'],
    prompt: { template: 'user', inputs: ['request', 'envelope:build'] },
  };
}

function commitPolishPhase(): PhaseDef {
  return {
    name: 'commit_polish',
    kind: 'code',
    description:
      'Commit the production-check fixes separately from the implementation they polish.',
    command: { builtin: 'git_commit', messageFrom: 'envelope:production_check.summary' },
  };
}

function reviewPhase(afterProductionCheck = false): PhaseDef {
  const inputs = ['request', 'envelope:plan', 'envelope:build'];
  // The build envelope stops describing the tree once production_check has
  // edited it, so a reviewer that runs after one has to see both.
  if (afterProductionCheck) inputs.push('envelope:production_check');
  return {
    name: 'review',
    kind: 'agent',
    agent: 'reviewer',
    description: 'Check the built work against the original request, one finding per requirement.',
    envelope: 'review',
    gates: ['verdict_consistent'],
    prompt: { template: 'user', inputs },
  };
}

function documentPhase(): PhaseDef {
  return {
    name: 'document',
    kind: 'agent',
    agent: 'documenter',
    description: "Write down what changed for the reader who arrives without this run's context.",
    envelope: 'document',
    gates: ['artifacts_exist', 'files_non_empty'],
    prompt: { template: 'user', inputs: ['request', 'envelope:build'] },
  };
}

function commitDocsPhase(): PhaseDef {
  return {
    name: 'commit_docs',
    kind: 'code',
    description: 'Commit the documentation separately so docs churn stays out of the code diff.',
    command: { builtin: 'git_commit', messageFrom: 'envelope:document.summary' },
  };
}

/**
 * Drafts the PR envelope, then the engine pushes `foundry/<runId>` and runs
 * `gh pr create`. `afterProductionCheck` adds that handoff so the body can
 * describe the ship-bar pass, not only the build.
 */
function prPhase(afterProductionCheck = false): PhaseDef {
  const inputs = ['request', 'envelope:plan', 'envelope:build'];
  if (afterProductionCheck) inputs.push('envelope:production_check');
  return {
    name: 'open_pr',
    kind: 'agent',
    agent: 'pr_writer',
    description:
      'Open a pull request with a human-readable title and body, following the repo PR template when present.',
    envelope: 'pr',
    prompt: { template: 'user', inputs },
  };
}

function refineBuildShipPhases(): PhaseDef[] {
  return [
    refinePhase(),
    planPhase(true),
    commitPlanPhase(),
    buildPhase(),
    testPhase(),
    commitBuildPhase('Commit the implementation once its tests are green.'),
    productionCheckPhase(),
    commitPolishPhase(),
  ];
}

function fullSdlcPhases(): PhaseDef[] {
  return [
    refinePhase(),
    planPhase(true),
    commitPlanPhase(),
    buildPhase(),
    testPhase("Run the project's test command and send failures back to the builder as evidence."),
    commitBuildPhase('Commit the implementation once its tests are green.'),
    productionCheckPhase(),
    commitPolishPhase(),
    reviewPhase(true),
    documentPhase(),
    commitDocsPhase(),
  ];
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
    description:
      "The standard chain: spec first, implement, then prove it with the project's own tests.",
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
    id: 'refine-build-ship',
    name: 'Refine → Build → Ship',
    description:
      'Sharpen the request first, implement it, then hold the result to the ship bar before it counts.',
    acceptance: { kind: 'phase_flag', phase: 'production_check', flag: 'approved' },
    builtin: true,
    phases: refineBuildShipPhases(),
  },
  {
    id: 'refine-build-ship-pr',
    name: 'Refine → Build → Ship → PR',
    description:
      'Sharpen the request, implement it, hold it to the ship bar, then open the pull request.',
    acceptance: { kind: 'phase_flag', phase: 'production_check', flag: 'approved' },
    builtin: true,
    phases: [...refineBuildShipPhases(), prPhase(true)],
  },
  {
    id: 'full-sdlc',
    name: 'Full SDLC',
    description:
      'Refine, plan, build, test, polish, review, and document, committing at each meaningful boundary.',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    builtin: true,
    phases: fullSdlcPhases(),
  },
  {
    id: 'full-sdlc-pr',
    name: 'Full SDLC → PR',
    description: 'The full chain, then open a pull request with a human-readable title and body.',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    builtin: true,
    phases: [...fullSdlcPhases(), prPhase(true)],
  },
];
