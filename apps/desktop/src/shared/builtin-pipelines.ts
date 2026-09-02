/**
 * The pipelines Foundry ships with. These pure shared seeds become editable copies in the
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
    prompt: { inputs: ['request'] },
  };
}

function planPhase(refined = false): PhaseDef {
  return {
    name: 'plan',
    kind: 'agent',
    agent: 'planner',
    retries: 2,
    description: refined
      ? 'Turn the refined brief into a plan the builder needs no questions to implement.'
      : 'Turn the request into a plan the builder needs no questions to implement.',
    gates: ['artifacts_exist', 'files_non_empty'],
    prompt: {
      inputs: refined ? ['envelope:refine.improved_request', 'envelope:refine'] : ['request'],
    },
  };
}

function commitPlanPhase(): PhaseDef {
  return commitPhase(
    'commit_plan',
    'plan',
    'Record the spec as its own commit so the plan has a history separate from the work.',
  );
}

function refinedRequest(inputs: string[]): string[] {
  return ['envelope:refine.improved_request', ...inputs];
}

function buildPhase(refined = false): PhaseDef {
  return {
    name: 'build',
    kind: 'agent',
    agent: 'builder',
    retries: 2,
    description:
      'Implement the plan exactly, writing or updating the tests the spec names as part of the change.',
    prompt: {
      inputs: refined
        ? refinedRequest(['envelope:plan', 'envelope:refine'])
        : ['request', 'envelope:plan'],
    },
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

function commitPhase(
  name: string,
  from: string,
  description: string,
  field = 'commit_message',
): PhaseDef {
  return {
    name,
    kind: 'code',
    description,
    command: { builtin: 'git_commit', messageFrom: `envelope:${from}.${field}` },
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
 * when it cannot close a gap.
 */
function productionCheckPhase(): PhaseDef {
  return {
    name: 'production_check',
    kind: 'agent',
    agent: 'finisher',
    retries: 2,
    description: 'Audit the work against the ship bar and close the gaps it finds.',
    gates: ['verdict_consistent', 'disapproval_halts'],
    prompt: { inputs: refinedRequest(['envelope:build', 'envelope:refine']) },
  };
}

function commitPolishPhase(): PhaseDef {
  return commitPhase(
    'commit_polish',
    'production_check',
    'Commit the production-check fixes separately from the implementation they polish.',
    'summary',
  );
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
    description: 'Check the built work against the refined brief, one finding per requirement.',
    gates: ['verdict_consistent', 'disapproval_halts'],
    prompt: {
      inputs: refinedRequest([
        'envelope:plan',
        'envelope:build',
        'envelope:production_check',
        'envelope:refine',
      ]),
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
    gates: ['artifacts_exist', 'files_non_empty'],
    prompt: {
      inputs: refinedRequest(['envelope:build', 'envelope:production_check']),
    },
  };
}

function commitDocsPhase(): PhaseDef {
  return commitPhase(
    'commit_docs',
    'document',
    'Commit the documentation separately so docs churn stays out of the code diff.',
    'summary',
  );
}

/**
 * Drafts the PR envelope, then the engine — not the agent — pushes
 * `foundry/<runId>` and runs `gh pr create`. A missing PR number or URL fails
 * the phase, and the executor hard-rejects a run whose PR phase aborted, so
 * "accepted" always means "the pull request exists".
 */
function prPhase(inputs: string[], refined = false): PhaseDef {
  return {
    name: 'open_pr',
    kind: 'agent',
    agent: 'pr_writer',
    description:
      'Open a pull request with a human-readable title and body, following the repo PR template when present.',
    prompt: { inputs: refined ? refinedRequest(inputs) : ['request', ...inputs] },
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
    prompt: { inputs: ['request', ...inputs] },
  };
}

function scoutPhase(name: string, description: string): PhaseDef {
  return {
    name,
    kind: 'agent',
    agent: 'scout',
    retries: 2,
    description,
    gates: ['artifacts_exist'],
    prompt: { inputs: ['request'] },
  };
}

function specPhase(inputs: string[], description: string): PhaseDef {
  return {
    name: 'spec',
    kind: 'agent',
    agent: 'planner',
    retries: 2,
    description,
    gates: ['artifacts_exist', 'files_non_empty'],
    prompt: { inputs },
  };
}

/** Refine → plan → build → test → commit → ship bar → re-test → commit. */
function shipPhases(): PhaseDef[] {
  return [
    refinePhase(),
    planPhase(true),
    commitPlanPhase(),
    buildPhase(true),
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
      "The standard chain: spec first, implement it (tests are part of the build), prove it with the project's own tests, then open the pull request.",
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
      scoutPhase(
        'diagnose',
        'Locate the fault in the real tree — paths, symbols, and the failing behaviour — before anything changes.',
      ),
      {
        name: 'fix',
        kind: 'agent',
        agent: 'builder',
        retries: 2,
        description: 'Repair exactly the diagnosed fault.',
        prompt: { inputs: ['request', 'envelope:diagnose'] },
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
      scoutPhase(
        'survey',
        'Map the code the spec will touch — current behaviour, owners, and constraints — with located evidence.',
      ),
      specPhase(
        ['request', 'envelope:survey'],
        'Write the implementable spec under specs/, grounded in what the survey actually found.',
      ),
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
      scoutPhase(
        'diagnose',
        'Locate the fault in the real tree — paths, symbols, and the failing behaviour — before anything is filed.',
      ),
      issuePhase(['envelope:diagnose']),
      specPhase(
        ['request', 'envelope:diagnose'],
        'Write the implementable fix spec under specs/, grounded in the diagnosed evidence.',
      ),
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
      prPhase(['envelope:plan', 'envelope:build', 'envelope:production_check'], true),
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
      prPhase(
        [
          'envelope:plan',
          'envelope:build',
          'envelope:production_check',
          'envelope:review',
          'envelope:document',
        ],
        true,
      ),
    ],
  },
];
