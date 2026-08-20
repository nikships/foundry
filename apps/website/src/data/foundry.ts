/**
 * Real Foundry data, mirrored from the app tree so everything on this page is
 * showing the actual product rather than a plausible-looking mock.
 *
 *   AGENTS    ← apps/desktop/src/main/store/builtin-agents.ts
 *   PIPELINES ← apps/desktop/src/main/store/builtin-pipelines.ts
 *   GATES     ← apps/desktop/src/main/engine/gates.ts (GATE_DESCRIPTIONS)
 *   ENVELOPES ← apps/desktop/src/main/store/envelopes.ts
 *
 * If any of those change, change them here too. Nothing enforces it — this
 * folder is deliberately outside the app build and the repo gate.
 */

export type PhaseKind = 'agent' | 'code' | 'engineer';

export const KIND_LABEL: Record<PhaseKind, string> = {
  agent: 'agent',
  code: 'command',
  engineer: 'checkpoint',
};

export type AgentName =
  | 'refiner'
  | 'planner'
  | 'builder'
  | 'scout'
  | 'reviewer'
  | 'finisher'
  | 'documenter'
  | 'pr_writer';

export type EnvelopeKind =
  | 'generic'
  | 'brief'
  | 'plan'
  | 'build'
  | 'scout'
  | 'review'
  | 'document'
  | 'pr';

export interface Agent {
  name: AgentName;
  tagline: string;
  purpose: string;
  envelope: EnvelopeKind;
  effort: 'medium' | 'high';
  /** null means the whole worktree; [] means read-only. */
  writes: string[] | null;
  color: string;
  prompt: string;
}

export const AGENTS: Agent[] = [
  {
    name: 'refiner',
    tagline: 'Sharpens the ask',
    purpose: 'Rewrite a rough request into a brief grounded in this repository.',
    envelope: 'brief',
    effort: 'medium',
    writes: [],
    color: 'var(--accents-refiner)',
    prompt:
      'Turn a rough request into one sharp, self-contained brief the next phase can act on. Preserve the intent — sharpening a request never means widening it.',
  },
  {
    name: 'planner',
    tagline: 'Shapes the work',
    purpose: 'Turn a request into a plan the builder needs no questions to implement.',
    envelope: 'plan',
    effort: 'high',
    writes: ['specs/', '.foundry-handoff/'],
    color: 'var(--accents-planner)',
    prompt:
      'Produce a plan concrete enough that the builder never has to make a judgment call you could have made here. Name the files. Name the order.',
  },
  {
    name: 'builder',
    tagline: 'Writes the code',
    purpose: 'Implement the plan exactly; report every file changed.',
    envelope: 'build',
    effort: 'medium',
    writes: null,
    color: 'var(--accents-builder)',
    prompt:
      'Implement the plan as written, inside an isolated worktree. Every file you touch goes in the envelope — the diff gate checks your claim against git.',
  },
  {
    name: 'scout',
    tagline: 'Maps the repo',
    purpose: 'Map the ground before anyone changes it. Read-only.',
    envelope: 'scout',
    effort: 'medium',
    writes: [],
    color: 'var(--accents-scout)',
    prompt:
      'Answer with paths and symbols, not impressions. Every finding cites where it came from. You may not write anything.',
  },
  {
    name: 'reviewer',
    tagline: 'Judges the diff',
    purpose: 'Confirm what was built is what was asked for. This is not testing.',
    envelope: 'review',
    effort: 'high',
    writes: [],
    color: 'var(--accents-reviewer)',
    prompt:
      'One finding per requirement in the original request. You cannot approve while you are also listing blocking items — the verdict gate checks that.',
  },
  {
    name: 'finisher',
    tagline: 'Holds the bar',
    purpose: 'Audit the work against the ship bar, then close the gaps it finds.',
    envelope: 'review',
    effort: 'high',
    writes: null,
    color: 'var(--accents-finisher)',
    prompt:
      'Audit against the ship bar and then actually fix what you found. Finding a gap and leaving it open is not finishing.',
  },
  {
    name: 'documenter',
    tagline: 'Leaves the trail',
    purpose: 'Write down what changed, for the human who arrives later.',
    envelope: 'document',
    effort: 'medium',
    writes: ['docs/', 'README.md'],
    color: 'var(--accents-documenter)',
    prompt:
      "Write for the reader who arrives without this run's context. Record intent and decisions, not a changelog of lines.",
  },
  {
    name: 'pr_writer',
    tagline: 'Drafts the PR',
    purpose: 'Draft a concise, human-readable, template-aware PR title and body. Change no files.',
    envelope: 'pr',
    effort: 'medium',
    writes: [],
    color: 'var(--accents-pr)',
    prompt:
      'Draft a concise, human-readable pull request title and body following repository templates when present. You may not modify any files.',
  },
];

export const agentByName = (name?: string): Agent | undefined =>
  AGENTS.find((a) => a.name === name);

export const agentColor = (name?: string): string => agentByName(name)?.color ?? 'var(--accent)';

export interface Pipeline {
  id: string;
  name: string;
  desc: string;
  phases: number;
}

export const PIPELINES: Pipeline[] = [
  { id: 'prompt', name: 'Prompt', desc: 'One agent, one turn, one envelope. The smallest useful run.', phases: 1 },
  {
    id: 'scout',
    name: 'Scout',
    desc: 'Read-only reconnaissance: answer a question about the codebase with evidence.',
    phases: 1,
  },
  { id: 'plan', name: 'Plan', desc: 'Produce a spec concrete enough to implement, and commit it.', phases: 2 },
  {
    id: 'plan-build',
    name: 'Plan → Build',
    desc: 'Spec first, then implement it, with each step committed separately.',
    phases: 4,
  },
  {
    id: 'plan-build-test',
    name: 'Plan → Build → Test',
    desc: "The standard chain: spec first, implement, then prove it with the project's own tests.",
    phases: 5,
  },
  {
    id: 'plan-build-review',
    name: 'Plan → Build → Review',
    desc: 'Implement against a spec, then have a second agent check it against the request.',
    phases: 4,
  },
  {
    id: 'refine-build-ship',
    name: 'Refine → Build → Ship',
    desc: 'Sharpen the request first, implement it, then hold the result to the ship bar before it counts.',
    phases: 8,
  },
  {
    id: 'refine-build-ship-pr',
    name: 'Refine → Build → Ship → PR',
    desc: 'Sharpen the request, implement it, hold it to the ship bar, then open the pull request.',
    phases: 9,
  },
  {
    id: 'full-sdlc',
    name: 'Full SDLC',
    desc: 'Refine, plan, build, test, polish, review, and document, committing at each meaningful boundary.',
    phases: 11,
  },
  {
    id: 'full-sdlc-pr',
    name: 'Full SDLC → PR',
    desc: 'The full chain, then open a pull request with a human-readable title and body.',
    phases: 12,
  },
];

export const GATE_DESCRIPTIONS: Record<string, string> = {
  artifacts_exist: 'Every path the envelope declares as an artifact exists on disk.',
  files_non_empty: 'Declared artifacts have content, not just a name.',
  json_parses: 'Declared .json artifacts actually parse.',
  diff_matches_claims:
    'Files claimed as changed appear in the git diff (including deletions), and nothing changed is left unclaimed.',
  verdict_consistent: 'A review cannot approve while it also lists blocking items.',
  command_passes: 'A configured command exits 0 against the phase result.',
};

export const ENVELOPE_BLURBS: Record<EnvelopeKind, string> = {
  generic: 'Status, summary, artifacts, notes',
  brief: 'Rewritten request with constraints and acceptance criteria',
  plan: 'Approach plus a commit message for the next step',
  build: 'Changed files and the commit message for the work',
  scout: 'Findings from reading the repo, one per entry',
  review: 'Approve or block, with per-requirement findings',
  document: 'Path of the doc written and the files it covers',
  pr: 'Bounded title and a non-empty markdown pull-request body',
};

/* ── the run the waterfall demo replays ───────────────────────────────────
 * Modelled on the shape of a real Refine → Build → Ship trace: phase kinds,
 * gate attachment, retry counts and the commit boundaries are the genuine
 * article; the file paths are this repository's.
 */

export type ToolKind = 'read' | 'glob' | 'edit' | 'bash' | 'gate' | 'assistant' | 'envelope';

export interface ToolCall {
  tool: ToolKind;
  arg: string;
  ms: number;
}

export interface RunPhase {
  name: string;
  kind: PhaseKind;
  /** seconds from run start */
  start: number;
  /** seconds */
  dur: number;
  desc: string;
  gates: string[];
  agent?: AgentName;
  envelope?: EnvelopeKind;
  model?: string;
  tokens?: string;
  command?: string;
  retries?: number;
  trace: ToolCall[];
}

const call = (tool: ToolKind, arg: string, ms: number): ToolCall => ({ tool, arg, ms });

export const RUN_PHASES: RunPhase[] = [
  {
    name: 'refine',
    kind: 'agent',
    agent: 'refiner',
    envelope: 'brief',
    start: 0,
    dur: 34,
    gates: [],
    desc: 'Sharpen the raw request into a brief grounded in this repository.',
    model: 'claude-sonnet-4-5',
    tokens: '68K',
    trace: [
      call('read', 'README.md', 210),
      call('glob', 'src/**/routes/*.ts', 180),
      call('read', 'src/server/http.ts', 340),
      call('assistant', 'the repo has no limiter — scope is one middleware', 900),
      call('envelope', 'brief · 3 constraints · 4 acceptance criteria', 120),
    ],
  },
  {
    name: 'plan',
    kind: 'agent',
    agent: 'planner',
    envelope: 'plan',
    start: 34,
    dur: 96,
    gates: ['artifacts_exist', 'files_non_empty'],
    desc: 'Turn the refined brief into a plan the builder needs no questions to implement.',
    model: 'claude-opus-4-1',
    tokens: '284K',
    trace: [
      call('read', 'src/server/http.ts', 260),
      call('read', 'src/server/middleware/auth.ts', 240),
      call('glob', 'tests/**/*.test.ts', 150),
      call('read', 'src/shared/types.ts', 410),
      call('assistant', 'token bucket in-process, keyed by api key', 1400),
      call('edit', 'specs/rate-limit.md', 520),
      call('gate', 'artifacts_exist → pass', 40),
      call('gate', 'files_non_empty → pass', 30),
      call('envelope', 'plan · 6 steps · commit_message set', 90),
    ],
  },
  {
    name: 'commit_plan',
    kind: 'code',
    command: 'git_commit',
    start: 130,
    dur: 4,
    gates: [],
    desc: 'Record the spec as its own commit so the plan has a history separate from the work.',
    trace: [
      call('bash', 'git add specs/rate-limit.md', 60),
      call('bash', 'git commit -m "spec: rate limiting for the public API"', 190),
      call('assistant', 'exit 0 · 1 file · +84 −0', 20),
    ],
  },
  {
    name: 'build',
    kind: 'agent',
    agent: 'builder',
    envelope: 'build',
    start: 134,
    dur: 168,
    retries: 1,
    gates: ['diff_matches_claims'],
    desc: 'Implement the plan exactly and report every changed file.',
    model: 'claude-opus-4-1',
    tokens: '911K',
    trace: [
      call('read', 'specs/rate-limit.md', 190),
      call('read', 'src/server/http.ts', 220),
      call('edit', 'src/server/middleware/rate-limit.ts', 780),
      call('edit', 'src/server/http.ts', 340),
      call('edit', 'src/shared/types.ts', 210),
      call('bash', 'npm run typecheck', 6100),
      call('assistant', 'one type error — RateLimitConfig not exported', 700),
      call('edit', 'src/shared/types.ts', 180),
      call('bash', 'npm run typecheck', 5800),
      call('edit', 'tests/rate-limit.test.ts', 640),
      call('gate', 'diff_matches_claims → pass · 4 claimed / 4 changed', 70),
      call('envelope', 'build · 4 files · commit_message set', 110),
    ],
  },
  {
    name: 'test',
    kind: 'code',
    command: 'test',
    start: 302,
    dur: 62,
    gates: [],
    desc: "Run the project's test command and capture the evidence either way.",
    trace: [
      call('bash', 'npm test', 61400),
      call('assistant', 'exit 0 · 703 passed · 0 failed · 48 files', 40),
    ],
  },
  {
    name: 'commit_build',
    kind: 'code',
    command: 'git_commit',
    start: 364,
    dur: 3,
    gates: [],
    desc: 'Commit the implementation once its tests are green.',
    trace: [
      call('bash', 'git add -A', 50),
      call('bash', 'git commit -m "feat(api): token-bucket rate limiting"', 170),
      call('assistant', 'exit 0 · 4 files · +312 −18', 20),
    ],
  },
  {
    name: 'production_check',
    kind: 'agent',
    agent: 'finisher',
    envelope: 'review',
    start: 367,
    dur: 38,
    gates: ['verdict_consistent'],
    desc: 'Audit the work against the ship bar and close the gaps it finds.',
    model: 'claude-sonnet-4-5',
    tokens: '412K',
    trace: [
      call('read', 'src/server/middleware/rate-limit.ts', 230),
      call('assistant', 'no 429 Retry-After header — closing that gap', 820),
      call('edit', 'src/server/middleware/rate-limit.ts', 410),
      call('bash', 'npm test -- rate-limit', 9200),
      call('gate', 'verdict_consistent → pass', 40),
      call('envelope', 'review · approved · 1 gap closed', 90),
    ],
  },
  {
    name: 'commit_polish',
    kind: 'code',
    command: 'git_commit',
    start: 405,
    dur: 3,
    gates: [],
    desc: 'Commit the production-check fixes separately from the implementation they polish.',
    trace: [
      call('bash', 'git commit -am "fix(api): send Retry-After on 429"', 180),
      call('assistant', 'exit 0 · 1 file · +9 −1', 20),
    ],
  },
];

export const RUN = {
  id: 'run_412',
  pipeline: 'Refine → Build → Ship',
  request: 'Add rate limiting to the public API',
  branch: 'foundry/run_260812_a41c9e',
  tokens: 2.19,
  cost: 4.87,
  phases: RUN_PHASES,
  total: RUN_PHASES.reduce((m, p) => Math.max(m, p.start + p.dur), 0),
  calls: RUN_PHASES.reduce((n, p) => n + p.trace.length, 0),
};

/** One hue per tool class, so a timing bar reads as what the agent did. */
export const TOOL_COLOR: Record<ToolKind, string> = {
  read: 'var(--accents-builder)',
  glob: 'var(--blue)',
  edit: 'var(--green)',
  bash: 'var(--amber)',
  gate: 'var(--purple)',
  assistant: 'var(--accent)',
  envelope: 'var(--accents-refiner)',
};

/* ── the pipeline the canvas demo lays out ─────────────────────────────── */

export interface CanvasPhase {
  name: string;
  kind: PhaseKind;
  desc: string;
  x: number;
  y: number;
  gates: number;
  agent?: AgentName;
  envelope?: EnvelopeKind;
  command?: string;
  retries?: number;
  feedbackTo?: string;
}

export const CANVAS_PHASES: CanvasPhase[] = [
  {
    name: 'refine',
    kind: 'agent',
    agent: 'refiner',
    envelope: 'brief',
    gates: 0,
    desc: 'Sharpen the raw request into a brief grounded in this repository.',
    x: 40,
    y: 296,
  },
  {
    name: 'plan',
    kind: 'agent',
    agent: 'planner',
    envelope: 'plan',
    gates: 2,
    desc: 'Turn the refined brief into a plan the builder needs no questions to implement.',
    x: 296,
    y: 200,
  },
  {
    name: 'commit_plan',
    kind: 'code',
    command: 'git_commit',
    gates: 0,
    desc: 'Record the spec as its own commit so the plan has a history separate from the work.',
    x: 552,
    y: 296,
  },
  {
    name: 'build',
    kind: 'agent',
    agent: 'builder',
    envelope: 'build',
    gates: 1,
    retries: 2,
    desc: 'Implement the plan exactly and report every changed file.',
    x: 296,
    y: 44,
  },
  {
    name: 'test',
    kind: 'code',
    command: 'test',
    gates: 0,
    feedbackTo: 'build',
    desc: "Run the project's test command and capture the evidence either way.",
    x: 552,
    y: 44,
  },
  {
    name: 'sign_off',
    kind: 'engineer',
    gates: 0,
    desc: 'Hold the run until a human accepts the release candidate.',
    x: 808,
    y: 168,
  },
  {
    name: 'production_check',
    kind: 'agent',
    agent: 'finisher',
    envelope: 'review',
    gates: 1,
    desc: 'Audit the work against the ship bar and close the gaps it finds.',
    x: 808,
    y: 330,
  },
];

/* ── the gate run the evidence demo replays ────────────────────────────── */

export interface GateCheck {
  name: string;
  ms: number;
  pass: string;
  fail?: string;
}

export const GATE_RUN = {
  phase: 'build',
  envelope: 'build' as EnvelopeKind,
  claim: [
    ['status', 'ok'],
    ['files_changed', '4'],
    ['commit_message', 'feat(api): token-bucket rate limiting'],
  ] as ReadonlyArray<readonly [string, string]>,
  files: [
    'src/server/middleware/rate-limit.ts',
    'src/server/http.ts',
    'src/shared/types.ts',
    'tests/rate-limit.test.ts',
  ],
  checks: [
    { name: 'artifacts_exist', ms: 12, pass: 'all 4 declared paths resolve inside the worktree' },
    { name: 'files_non_empty', ms: 9, pass: 'smallest is tests/rate-limit.test.ts at 1.4 KB' },
    {
      name: 'diff_matches_claims',
      ms: 41,
      pass: 'git reports 4 changed paths; the envelope claims the same 4',
      fail: 'git reports a path the envelope does not claim: src/server/logger.ts',
    },
    { name: 'verdict_consistent', ms: 7, pass: 'status ok, and no blocking findings are listed' },
  ] satisfies GateCheck[],
};

/* ── concept art ───────────────────────────────────────────────────────── */

export interface ArtScene {
  file: string;
  name: string;
  desc: string;
}

export const ART: ArtScene[] = [
  {
    file: 'foundry-intake-chamber',
    name: 'Intake chamber',
    desc: 'A work item crosses from the intake rail into a calibrated workcell. One request in.',
  },
  {
    file: 'foundry-branching-worktrees',
    name: 'Branching worktrees',
    desc: 'A central router distributes isolated work across four micro-workshops. Nothing shares a checkout.',
  },
  {
    file: 'foundry-gate-tribunal',
    name: 'Gate tribunal',
    desc: 'Mechanical inspectors validate a work package before release. Code judges, not vibes.',
  },
  {
    file: 'foundry-evidence-vault',
    name: 'Evidence vault',
    desc: 'Evidence modules enter a radial archive through a verification corridor. Every run keeps its proof.',
  },
  {
    file: 'foundry-night-shift',
    name: 'Night shift',
    desc: 'An autonomous workcell network keeps going in a calm, dark factory. You are not the bottleneck.',
  },
  {
    file: 'foundry-forge-workcell',
    name: 'Forge workcell',
    desc: 'The original scene: one cell, many arms, a single part moving through under constant measurement.',
  },
];

export interface AppShot {
  file: string;
  name: string;
  desc: string;
}

export const APP_SHOTS: AppShot[] = [
  {
    file: 'onboarding-hero',
    name: 'Onboarding',
    desc: 'Six screens: your harness, your repos, and a doctor that proves the setup.',
  },
  {
    file: 'pipeline-canvas',
    name: 'Pipeline canvas',
    desc: 'Freeform editing — drag phases, set boundaries, saved the moment it validates.',
  },
  {
    file: 'roster',
    name: 'Roster',
    desc: 'Eight agents, every prompt and boundary editable in place.',
  },
  {
    file: 'run-timeline',
    name: 'Inspector',
    desc: 'The waterfall, the transcript, the envelope, the gates, the cost.',
  },
  {
    file: 'concepts',
    name: 'Primitives',
    desc: 'Runs as data, typed envelopes, and gates that leave evidence behind.',
  },
];
