/**
 * The pipelines Foundry ships with. Every one is an editable copy in the
 * Designer, not a locked recipe: `builtin` only marks where it came from.
 *
 * Every shipped chain ends by opening a pull request, and every one holds two
 * rules by construction:
 *
 *   1. Nothing is recorded unproven. Every phase that edits code is followed by
 *      the project's test command before the commit that records it — including
 *      the production check, whose fixes land after `build` was already proven.
 *   2. A rejection halts. `disapproval_halts` requires a disapproving verdict
 *      to report `status: "fail"`, which aborts the phase, so disapproved work
 *      can never flow on into a commit or a pull request.
 *
 * Acceptance is `envelope_status` on `open_pr` for all of them: the run is
 * accepted only when the pull request actually exists (the engine records the
 * number and URL or fails the phase), never on an earlier flag that a later
 * failure would leave dangling.
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
    retries: 2,
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

/**
 * The proof between an edit and its commit. `feedbackTo` names the phase that
 * owns the fix, so a red run hands the log tail back to the agent that broke
 * it instead of committing broken work.
 */
function testPhase(feedbackTo: string, name = 'test'): PhaseDef {
  return {
    name,
    kind: 'code',
    description:
      name === 'verify'
        ? "Re-run the project's tests over the production-check fixes before anything records them."
        : "Run the project's test command and send failures back as evidence to the phase that owns the fix.",
    command: { ref: 'test' },
    feedbackTo,
    feedbackRetries: 2,
  };
}

function commitPhase(name: string, from: string, description: string): PhaseDef {
  return {
    name,
    kind: 'code',
    description,
    command: { builtin: 'git_commit', messageFrom: `envelope:${from}.commit_message` },
  };
}

function commitBuildPhase(): PhaseDef {
  return commitPhase(
    'commit_build',
    'build',
    'Commit the implementation once its tests are green.',
  );
}

/**
 * The one phase allowed to both judge and fix: a gap it only reported would
 * leave the run rejected with the work still short of the bar.
 * `verdict_consistent` keeps it from approving its way out and forces the halt
 * when it cannot close a gap; `diff_matches_claims` keeps its repairs visible
 * in the envelope (the finisher's `changed_files` custom field is what it
 * checks against).
 */
function productionCheckPhase(): PhaseDef {
  return {
    name: 'production_check',
    kind: 'agent',
    agent: 'finisher',
    retries: 2,
    description: 'Audit the work against the ship bar and close the gaps it finds.',
    envelope: 'review',
    gates: ['verdict_consistent', 'disapproval_halts', 'diff_matches_claims'],
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

/**
 * The build envelope stops describing the tree once production_check has
 * edited it, so the reviewer sees both.
 */
function reviewPhase(): PhaseDef {
  return {
    name: 'review',
    kind: 'agent',
    agent: 'reviewer',
    retries: 2,
    description: 'Check the built work against the original request, one finding per requirement.',
    envelope: 'review',
    gates: ['verdict_consistent', 'disapproval_halts'],
    prompt: {
      template: 'user',
      inputs: ['request', 'envelope:plan', 'envelope:build', 'envelope:production_check'],
    },
  };
}

function documentPhase(): PhaseDef {
  return {
    name: 'document',
    kind: 'agent',
    agent: 'documenter',
    retries: 2,
    description: "Write down what changed for the reader who arrives without this run's context.",
    envelope: 'document',
    gates: ['artifacts_exist', 'files_non_empty'],
    prompt: {
      template: 'user',
      inputs: ['request', 'envelope:build', 'envelope:production_check'],
    },
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
 * Drafts the PR envelope, then the engine — not the agent — pushes
 * `foundry/<runId>` and runs `gh pr create`. A missing PR number or URL fails
 * the phase, and the executor hard-rejects a run whose PR phase aborted, so
 * "accepted" always means "the pull request exists".
 */
function prPhase(inputs: string[]): PhaseDef {
  return {
    name: 'open_pr',
    kind: 'agent',
    agent: 'pr_writer',
    description:
      'Open a pull request with a human-readable title and body, following the repo PR template when present.',
    envelope: 'pr',
    prompt: { template: 'user', inputs: ['request', ...inputs] },
  };
}

/**
 * Drafts the issue envelope, then the engine — not the agent — runs
 * `gh issue create` and records the number and URL on the run. A missing
 * number or URL fails the phase, and the executor hard-rejects a run whose
 * issue phase aborted, exactly as it does for the PR phase.
 */
function issuePhase(inputs: string[]): PhaseDef {
  return {
    name: 'file_issue',
    kind: 'agent',
    agent: 'issue_writer',
    description:
      'File the GitHub issue that tracks the diagnosed problem, grounded in the located evidence.',
    envelope: 'issue',
    prompt: { template: 'user', inputs: ['request', ...inputs] },
  };
}

/** Refine → plan → build → test → commit → ship bar → re-test → commit. */
function shipPhases(): PhaseDef[] {
  return [
    refinePhase(),
    planPhase(true),
    commitPlanPhase(),
    buildPhase(),
    testPhase('build'),
    commitBuildPhase(),
    productionCheckPhase(),
    testPhase('production_check', 'verify'),
    commitPolishPhase(),
  ];
}

export const BUILTIN_PIPELINES: PipelineDef[] = [
  {
    id: 'build-pr',
    name: 'Plan → Build → Test → PR',
    description:
      "The standard chain: spec first, implement it, prove it with the project's own tests, then open the pull request.",
    acceptance: { kind: 'envelope_status', phase: 'open_pr' },
    builtin: true,
    phases: [
      planPhase(),
      commitPlanPhase(),
      buildPhase(),
      testPhase('build'),
      commitBuildPhase(),
      prPhase(['envelope:plan', 'envelope:build']),
    ],
  },
  {
    id: 'fix-pr',
    name: 'Diagnose → Fix → PR',
    description:
      'The bug chain: locate the fault with evidence first, fix exactly that, prove it with the tests, then open the pull request.',
    acceptance: { kind: 'envelope_status', phase: 'open_pr' },
    builtin: true,
    phases: [
      {
        name: 'diagnose',
        kind: 'agent',
        agent: 'scout',
        retries: 2,
        description:
          'Locate the fault in the real tree — paths, symbols, and the failing behaviour — before anything changes.',
        envelope: 'scout',
        gates: ['artifacts_exist'],
        prompt: { template: 'user', inputs: ['request'] },
      },
      {
        name: 'fix',
        kind: 'agent',
        agent: 'builder',
        retries: 2,
        description: 'Repair exactly the diagnosed fault and report every changed file.',
        envelope: 'build',
        gates: ['diff_matches_claims'],
        prompt: { template: 'user', inputs: ['request', 'envelope:diagnose'] },
      },
      testPhase('fix'),
      commitPhase('commit_fix', 'fix', 'Commit the fix once its tests are green.'),
      prPhase(['envelope:diagnose', 'envelope:fix']),
    ],
  },
  {
    id: 'spec-pr',
    name: 'Spec → PR',
    description:
      'No code changes: survey the repo, write a spec concrete enough to implement, and open a pull request that adds it for review.',
    acceptance: { kind: 'envelope_status', phase: 'open_pr' },
    builtin: true,
    phases: [
      {
        name: 'survey',
        kind: 'agent',
        agent: 'scout',
        retries: 2,
        description:
          'Map the code the spec will touch — current behaviour, owners, and constraints — with located evidence.',
        envelope: 'scout',
        gates: ['artifacts_exist'],
        prompt: { template: 'user', inputs: ['request'] },
      },
      {
        name: 'spec',
        kind: 'agent',
        agent: 'planner',
        retries: 2,
        description:
          'Write the implementable spec under specs/, grounded in what the survey actually found.',
        envelope: 'plan',
        gates: ['artifacts_exist', 'files_non_empty'],
        prompt: { template: 'user', inputs: ['request', 'envelope:survey'] },
      },
      commitPhase(
        'commit_spec',
        'spec',
        'Record the spec as the single commit the pull request will carry.',
      ),
      prPhase(['envelope:survey', 'envelope:spec']),
    ],
  },
  {
    id: 'triage-issue-pr',
    name: 'Diagnose → Issue → Spec → PR',
    description:
      'The triage chain: locate the fault with evidence, file the GitHub issue that tracks it, write the fix spec, and open the pull request that carries the spec.',
    acceptance: { kind: 'envelope_status', phase: 'open_pr' },
    builtin: true,
    phases: [
      {
        name: 'diagnose',
        kind: 'agent',
        agent: 'scout',
        retries: 2,
        description:
          'Locate the fault in the real tree — paths, symbols, and the failing behaviour — before anything is filed.',
        envelope: 'scout',
        gates: ['artifacts_exist'],
        prompt: { template: 'user', inputs: ['request'] },
      },
      issuePhase(['envelope:diagnose']),
      {
        name: 'spec',
        kind: 'agent',
        agent: 'planner',
        retries: 2,
        description:
          'Write the implementable fix spec under specs/, grounded in the diagnosed evidence.',
        envelope: 'plan',
        gates: ['artifacts_exist', 'files_non_empty'],
        prompt: { template: 'user', inputs: ['request', 'envelope:diagnose'] },
      },
      commitPhase(
        'commit_spec',
        'spec',
        'Record the fix spec as the single commit the pull request will carry.',
      ),
      prPhase(['envelope:diagnose', 'envelope:file_issue', 'envelope:spec']),
    ],
  },
  {
    id: 'ship-pr',
    name: 'Refine → Build → Ship → PR',
    description:
      'Sharpen the request, implement it, hold it to the ship bar, re-prove the polish, then open the pull request.',
    acceptance: { kind: 'envelope_status', phase: 'open_pr' },
    builtin: true,
    phases: [
      ...shipPhases(),
      prPhase(['envelope:plan', 'envelope:build', 'envelope:production_check']),
    ],
  },
  {
    id: 'sdlc-pr',
    name: 'Full SDLC → PR',
    description:
      'Refine, plan, build, test, polish, re-test, review, and document — committing at each proven boundary — then open the pull request.',
    acceptance: { kind: 'envelope_status', phase: 'open_pr' },
    builtin: true,
    phases: [
      ...shipPhases(),
      reviewPhase(),
      documentPhase(),
      commitDocsPhase(),
      prPhase([
        'envelope:plan',
        'envelope:build',
        'envelope:production_check',
        'envelope:review',
        'envelope:document',
      ]),
    ],
  },
];
