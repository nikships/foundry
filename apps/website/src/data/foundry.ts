/**
 * Real Foundry data, mirrored from the app tree so everything on this page is
 * showing the actual product rather than a plausible-looking mock.
 *
 *   AGENTS      ← apps/desktop/src/shared/builtin-agents.ts
 *   PIPELINES   ← apps/desktop/src/shared/builtin-pipelines.ts
 *   CHECKS      ← apps/desktop/src/main/engine/gates.ts (GATE_DESCRIPTIONS)
 *   REPORTS     ← apps/desktop/src/shared/types.ts (BUILTIN_ENVELOPE_BLURBS)
 *   ACCEPTANCE  ← apps/desktop/src/shared/types.ts (Acceptance)
 *
 * If any of those change, change them here too. Nothing enforces it — this
 * folder is deliberately outside the app build and the repo gate.
 *
 * Vocabulary note: the engine's internal names are `gate` and `envelope`; the
 * app's UI says **check** and **report**. This file keeps the engine names on
 * the identifiers (so a reader can grep the source) and the UI words in the
 * copy, exactly as the app does.
 */

export type PhaseKind = 'agent' | 'code' | 'engineer';

/** apps/desktop/src/renderer/utils/derive.ts:KIND_LABEL */
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
  | 'pr_writer'
  | 'issue_writer';

export type ReportKind =
  | 'generic'
  | 'brief'
  | 'plan'
  | 'build'
  | 'scout'
  | 'review'
  | 'document'
  | 'pr'
  | 'issue';

export interface Agent {
  name: AgentName;
  tagline: string;
  purpose: string;
  report: ReportKind;
  effort: 'medium' | 'high';
  /** `read-only` agents have no shell and no write tools at all. */
  toolProfile: 'full' | 'read-only';
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
    report: 'brief',
    effort: 'medium',
    toolProfile: 'read-only',
    writes: [],
    color: '#e879b9',
    prompt:
      'Turn a rough request into one sharp, self-contained brief the next phase can act on. Ground it in what is actually here: this repo\u2019s stack, terminology, and conventions.',
  },
  {
    name: 'planner',
    tagline: 'Shapes the work',
    purpose: 'Turn a request into a plan the builder needs no questions to implement.',
    report: 'plan',
    effort: 'high',
    toolProfile: 'full',
    writes: ['specs/', '.foundry-handoff/'],
    color: '#c89bff',
    prompt:
      'Keep the plan concrete: files to touch, changes to make, how to verify. Do not implement anything — planning and building are different phases for a reason.',
  },
  {
    name: 'builder',
    tagline: 'Writes the code',
    purpose: 'Implement the plan exactly.',
    report: 'build',
    effort: 'medium',
    toolProfile: 'full',
    writes: null,
    color: '#5ad2dd',
    prompt:
      'If a prior report carries a plan, a diagnosis, or test failures, that is your spec. Make the smallest change that satisfies the request; do not refactor unrelated code.',
  },
  {
    name: 'scout',
    tagline: 'Maps the repo',
    purpose: 'Map the ground before anyone changes it. Read-only.',
    report: 'scout',
    effort: 'medium',
    toolProfile: 'read-only',
    writes: [],
    color: '#e8b64a',
    prompt:
      'Answer with paths and symbols, not impressions. Every finding cites where it came from. You may not write anything.',
  },
  {
    name: 'reviewer',
    tagline: 'Judges the diff',
    purpose: 'Confirm what was built is what was asked for. This is not testing.',
    report: 'review',
    effort: 'high',
    toolProfile: 'read-only',
    writes: [],
    color: '#ff6f67',
    prompt:
      'You are read-only and have no shell. Call git_diff for the patch, then check each requirement against it. `approved` must be false if anything is blocking — a check verifies your verdict is self-consistent.',
  },
  {
    name: 'finisher',
    tagline: 'Holds the bar',
    purpose: 'Audit the work against the ship bar, then close the gaps it finds.',
    report: 'review',
    effort: 'high',
    toolProfile: 'full',
    writes: null,
    color: '#6aa9ff',
    prompt:
      'Answer one question honestly: is this ready to ship to real users today? Then make it so. Finding a gap and leaving it open is not finishing.',
  },
  {
    name: 'documenter',
    tagline: 'Leaves the trail',
    purpose: 'Write down what changed, for the human who arrives later.',
    report: 'document',
    effort: 'medium',
    toolProfile: 'full',
    writes: ['docs/', 'README.md'],
    color: '#4ade80',
    prompt:
      "Write for the reader who arrives without this run's context. Record intent and decisions, not a changelog of lines.",
  },
  {
    name: 'pr_writer',
    tagline: 'Drafts the PR',
    purpose: 'Draft a concise, human-readable, template-aware PR title and body. Change no files.',
    report: 'pr',
    effort: 'medium',
    toolProfile: 'read-only',
    writes: [],
    color: '#f59e0b',
    prompt:
      'Locate a PR template in the documented search order and follow it if found. Compose a bounded title and a non-empty markdown body. Do not modify files.',
  },
  {
    name: 'issue_writer',
    tagline: 'Files the issue',
    purpose: 'Draft a concise, evidence-backed GitHub issue. Change no files.',
    report: 'issue',
    effort: 'medium',
    toolProfile: 'read-only',
    writes: [],
    color: '#a3e635',
    prompt:
      'Ground the issue in the evidence handed to you: cite the paths, symbols, and behaviour a prior phase actually found. Do not restate the raw request as an issue.',
  },
];

export const agentByName = (name?: string): Agent | undefined =>
  AGENTS.find((a) => a.name === name);

export const agentColor = (name?: string): string => agentByName(name)?.color ?? 'var(--accent)';

/* ── the six shipped pipelines ────────────────────────────────────────────
 * Every one of them ends by opening a pull request, and acceptance is
 * `envelope_status` on `open_pr` for all six: the run counts as accepted only
 * when the pull request actually exists.
 */

export interface Pipeline {
  id: string;
  name: string;
  desc: string;
  phases: number;
  /** The phase names in execution order, for the strip under each row. */
  chain: string[];
}

export const PIPELINES: Pipeline[] = [
  {
    id: 'build-pr',
    name: 'Plan → Build → Test → PR',
    desc: "The standard chain: spec first, implement it, prove it with the project's own tests, then open the pull request.",
    phases: 6,
    chain: ['plan', 'commit_plan', 'build', 'test', 'commit_build', 'open_pr'],
  },
  {
    id: 'fix-pr',
    name: 'Diagnose → Fix → PR',
    desc: 'The bug chain: locate the fault with evidence first, fix exactly that, prove it with the tests, then open the pull request.',
    phases: 5,
    chain: ['diagnose', 'fix', 'test', 'commit_fix', 'open_pr'],
  },
  {
    id: 'spec-pr',
    name: 'Spec → PR',
    desc: 'No code changes: survey the repo, write a spec concrete enough to implement, and open a pull request that adds it for review.',
    phases: 4,
    chain: ['survey', 'spec', 'commit_spec', 'open_pr'],
  },
  {
    id: 'triage-issue-pr',
    name: 'Diagnose → Issue → Spec → PR',
    desc: 'The triage chain: locate the fault with evidence, file the GitHub issue that tracks it, write the fix spec, and open the pull request that carries the spec.',
    phases: 5,
    chain: ['diagnose', 'file_issue', 'spec', 'commit_spec', 'open_pr'],
  },
  {
    id: 'ship-pr',
    name: 'Refine → Build → Ship → PR',
    desc: 'Sharpen the request, implement it, hold it to the ship bar, re-prove the polish, then open the pull request.',
    phases: 10,
    chain: [
      'refine',
      'plan',
      'commit_plan',
      'build',
      'test',
      'commit_build',
      'production_check',
      'verify',
      'commit_polish',
      'open_pr',
    ],
  },
  {
    id: 'sdlc-pr',
    name: 'Full SDLC → PR',
    desc: 'Refine, plan, build, test, polish, re-test, review, and document — committing at each proven boundary — then open the pull request.',
    phases: 13,
    chain: [
      'refine',
      'plan',
      'commit_plan',
      'build',
      'test',
      'commit_build',
      'production_check',
      'verify',
      'commit_polish',
      'review',
      'document',
      'commit_docs',
      'open_pr',
    ],
  },
];

/**
 * The six checks in the engine. `command_passes` runs your argv; the rest read
 * the report and the worktree. A check returns evidence, never an opinion.
 */
export const CHECK_DESCRIPTIONS: Record<string, string> = {
  artifacts_exist: 'Every path the report declares as an artifact exists on disk.',
  files_non_empty: 'Declared artifacts have content, not just a name.',
  json_parses: 'Declared .json artifacts actually parse.',
  verdict_consistent: 'A review cannot approve while it also lists blocking items.',
  disapproval_halts:
    'A review that does not approve must report failure, so disapproved work never flows into later phases.',
  command_passes: 'A configured command exits 0 against the phase result.',
};

export const REPORT_BLURBS: Record<ReportKind, string> = {
  generic: 'Base reply: status, summary, artifacts, notes',
  brief: 'Rewritten request with constraints and acceptance criteria',
  plan: 'Approach plus a commit message for the next step',
  build: 'Commit message for the work',
  scout: 'Findings from reading the repo, one per entry',
  review: 'Approve or block, with per-requirement findings',
  document: 'Base reply; the written doc is declared in artifacts',
  pr: 'Bounded title and a non-empty markdown pull-request body',
  issue: 'Bounded title and a non-empty markdown GitHub-issue body',
};

/** apps/desktop/src/shared/types.ts:Acceptance — what "done" is allowed to mean. */
export const ACCEPTANCE_KINDS: Array<[string, string]> = [
  ['envelope_status', "A named phase's report reports success. What all six built-ins use."],
  ['phase_flag', 'A named phase sets passed or approved.'],
  ['last_phase_pass', 'The final phase passes.'],
  ['all_phases_pass', 'Every phase passes.'],
];

/* ── the run the waterfall demo replays ───────────────────────────────────
 * Modelled on a real Refine → Build → Ship → PR trace: phase kinds, check
 * attachment, the feedback edge, retry counts, per-phase model attribution and
 * the commit boundaries are the genuine article.
 */

export type ToolKind =
  | 'read'
  | 'glob'
  | 'edit'
  | 'bash'
  | 'check'
  | 'assistant'
  | 'report'
  | 'gh';

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
  checks: string[];
  agent?: AgentName;
  report?: ReportKind;
  model?: string;
  tokens?: string;
  /** Percent of the model's context the phase actually occupied. */
  context?: number;
  command?: string;
  retries?: number;
  /** A failing command hands its log tail back to this earlier agent phase. */
  feedbackTo?: string;
  trace: ToolCall[];
}

const call = (tool: ToolKind, arg: string, ms: number): ToolCall => ({ tool, arg, ms });

export const RUN_PHASES: RunPhase[] = [
  {
    name: 'refine',
    kind: 'agent',
    agent: 'refiner',
    report: 'brief',
    start: 0,
    dur: 34,
    checks: [],
    desc: 'Sharpen the raw request into a brief grounded in this repository.',
    model: 'gemini-3.7-flash',
    tokens: '68K',
    context: 3,
    trace: [
      call('read', 'README.md', 210),
      call('glob', 'src/**/routes/*.ts', 180),
      call('read', 'src/server/http.ts', 340),
      call('assistant', 'the repo has no limiter — scope is one middleware', 900),
      call('report', 'brief · 3 constraints · 4 acceptance criteria', 120),
    ],
  },
  {
    name: 'plan',
    kind: 'agent',
    agent: 'planner',
    report: 'plan',
    start: 34,
    dur: 96,
    checks: ['artifacts_exist', 'files_non_empty'],
    desc: 'Turn the refined brief into a plan the builder needs no questions to implement.',
    model: 'gpt-5.6-sol',
    tokens: '284K',
    context: 14,
    trace: [
      call('read', 'src/server/http.ts', 260),
      call('read', 'src/server/middleware/auth.ts', 240),
      call('glob', 'tests/**/*.test.ts', 150),
      call('read', 'src/shared/types.ts', 410),
      call('assistant', 'token bucket in-process, keyed by api key', 1400),
      call('edit', 'specs/rate-limit.md', 520),
      call('check', 'artifacts_exist → pass', 40),
      call('check', 'files_non_empty → pass', 30),
      call('report', 'plan · 6 steps · commit_message set', 90),
    ],
  },
  {
    name: 'commit_plan',
    kind: 'code',
    command: 'git_commit',
    start: 130,
    dur: 4,
    checks: [],
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
    report: 'build',
    start: 134,
    dur: 168,
    retries: 1,
    checks: [],
    desc: 'Implement the plan exactly.',
    model: 'gpt-5.6-sol',
    tokens: '911K',
    context: 41,
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
      call('report', 'build · 4 files · commit_message set', 110),
    ],
  },
  {
    name: 'test',
    kind: 'code',
    command: 'test',
    start: 302,
    dur: 62,
    checks: [],
    feedbackTo: 'build',
    desc: "Run the project's test command and send failures back as evidence to the phase that owns the fix.",
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
    checks: [],
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
    report: 'review',
    start: 367,
    dur: 38,
    checks: ['verdict_consistent', 'disapproval_halts'],
    desc: 'Audit the work against the ship bar and close the gaps it finds.',
    model: 'claude-opus-5',
    tokens: '412K',
    context: 19,
    trace: [
      call('read', 'src/server/middleware/rate-limit.ts', 230),
      call('assistant', 'no 429 Retry-After header — closing that gap', 820),
      call('edit', 'src/server/middleware/rate-limit.ts', 410),
      call('check', 'verdict_consistent → pass', 40),
      call('check', 'disapproval_halts → pass', 30),
      call('report', 'review · approved · 1 gap closed', 90),
    ],
  },
  {
    name: 'verify',
    kind: 'code',
    command: 'test',
    start: 405,
    dur: 58,
    checks: [],
    feedbackTo: 'production_check',
    desc: "Re-run the project's tests over the production-check fixes before anything records them.",
    trace: [
      call('bash', 'npm test', 57800),
      call('assistant', 'exit 0 · 704 passed · 0 failed · 48 files', 40),
    ],
  },
  {
    name: 'commit_polish',
    kind: 'code',
    command: 'git_commit',
    start: 463,
    dur: 3,
    checks: [],
    desc: 'Commit the production-check fixes separately from the implementation they polish.',
    trace: [
      call('bash', 'git commit -am "fix(api): send Retry-After on 429"', 180),
      call('assistant', 'exit 0 · 1 file · +9 −1', 20),
    ],
  },
  {
    name: 'open_pr',
    kind: 'agent',
    agent: 'pr_writer',
    report: 'pr',
    start: 466,
    dur: 21,
    checks: [],
    desc: 'Open a pull request with a human-readable title and body, following the repo PR template when present.',
    model: 'gemini-3.7-flash',
    tokens: '96K',
    context: 5,
    trace: [
      call('read', '.github/pull_request_template.md', 120),
      call('bash', 'git_diff · 5 files', 240),
      call('assistant', 'following the repo template — 4 sections', 780),
      call('report', 'pr · title 58 chars · body set', 90),
      call('gh', 'git push -u origin foundry/run_260823_a41c9e', 4200),
      call('gh', 'gh pr create → #412', 3100),
    ],
  },
];

export const RUN = {
  id: 'run_260823_a41c9e',
  pipeline: 'Refine → Build → Ship → PR',
  request: 'Add rate limiting to the public API',
  branch: 'foundry/run_260823_a41c9e',
  pr: 412,
  tokens: 1.77,
  phases: RUN_PHASES,
  total: RUN_PHASES.reduce((m, p) => Math.max(m, p.start + p.dur), 0),
  calls: RUN_PHASES.reduce((n, p) => n + p.trace.length, 0),
};

/** One hue per tool class, so a timing bar reads as what the agent did. */
export const TOOL_COLOR: Record<ToolKind, string> = {
  read: '#5ad2dd',
  glob: 'var(--blue)',
  edit: 'var(--green)',
  bash: 'var(--amber)',
  check: 'var(--purple)',
  assistant: 'var(--accent)',
  report: '#e879b9',
  gh: '#f59e0b',
};

/* ── the pipeline the canvas demo lays out ─────────────────────────────── */

export interface CanvasPhase {
  name: string;
  kind: PhaseKind;
  desc: string;
  x: number;
  y: number;
  checks: number;
  agent?: AgentName;
  report?: ReportKind;
  command?: string;
  retries?: number;
  feedbackTo?: string;
}

export const CANVAS_PHASES: CanvasPhase[] = [
  {
    name: 'refine',
    kind: 'agent',
    agent: 'refiner',
    report: 'brief',
    checks: 0,
    desc: 'Sharpen the raw request into a brief grounded in this repository.',
    x: 40,
    y: 296,
  },
  {
    name: 'plan',
    kind: 'agent',
    agent: 'planner',
    report: 'plan',
    checks: 2,
    retries: 2,
    desc: 'Turn the refined brief into a plan the builder needs no questions to implement.',
    x: 296,
    y: 200,
  },
  {
    name: 'build',
    kind: 'agent',
    agent: 'builder',
    report: 'build',
    checks: 0,
    retries: 2,
    desc: 'Implement the plan exactly.',
    x: 296,
    y: 44,
  },
  {
    name: 'test',
    kind: 'code',
    command: 'test',
    checks: 0,
    feedbackTo: 'build',
    desc: "Run the project's test command and send failures back as evidence to the phase that owns the fix.",
    x: 552,
    y: 44,
  },
  {
    name: 'commit_build',
    kind: 'code',
    command: 'git_commit',
    checks: 0,
    desc: 'Commit the implementation once its tests are green.',
    x: 552,
    y: 296,
  },
  {
    name: 'sign_off',
    kind: 'engineer',
    checks: 0,
    desc: 'Hold the run until a human accepts the release candidate.',
    x: 808,
    y: 168,
  },
  {
    name: 'open_pr',
    kind: 'agent',
    agent: 'pr_writer',
    report: 'pr',
    checks: 0,
    desc: 'Open a pull request with a human-readable title and body, following the repo PR template when present.',
    x: 808,
    y: 330,
  },
];

/* ── the check run the evidence demo replays ─────────────────────────────
 * A `review` report going through the two checks that guard every reviewing
 * phase. The second pass fails `disapproval_halts` on purpose: an agent that
 * lists blockers and still reports success is exactly what code is for.
 */

export interface CheckCase {
  name: string;
  ms: number;
  pass: string;
  fail?: string;
}

export const CHECK_RUN = {
  phase: 'production_check',
  report: 'review' as ReportKind,
  claim: [
    ['status', 'ok'],
    ['approved', 'true'],
    ['blocking', '[]'],
  ] as ReadonlyArray<readonly [string, string]>,
  /** What the second, failing pass claims instead. */
  badClaim: [
    ['status', 'ok'],
    ['approved', 'false'],
    ['blocking', '["429 has no Retry-After"]'],
  ] as ReadonlyArray<readonly [string, string]>,
  files: ['src/server/middleware/rate-limit.ts', 'tests/rate-limit.test.ts'],
  checks: [
    { name: 'artifacts_exist', ms: 12, pass: 'both declared paths resolve inside the worktree' },
    { name: 'files_non_empty', ms: 9, pass: 'smallest is tests/rate-limit.test.ts at 1.4 KB' },
    {
      name: 'verdict_consistent',
      ms: 7,
      pass: 'approved is true and no blocking findings are listed',
      fail: 'approved is false while status claims success — the verdict contradicts itself',
    },
    {
      name: 'disapproval_halts',
      ms: 6,
      pass: 'the review approved, so the run may continue',
      fail: 'a disapproving review must report status "fail" — the phase aborts here',
    },
  ] satisfies CheckCase[],
};

/* ── model casting: what "mix providers inside one run" looks like ───────
 * Model ids are opaque `provider/model` strings — Foundry keeps no allowlist
 * of its own, so anything the install can reach is selectable per agent and
 * overridable per phase.
 */

export interface Seat {
  phase: string;
  agent: AgentName;
  model: string;
  vendor: string;
  why: string;
}

export const CAST: Seat[] = [
  {
    phase: 'refine',
    agent: 'refiner',
    model: 'gemini-3.7-flash',
    vendor: 'Gemini',
    why: 'Cheap and fast. Sharpening an ask does not need a frontier reasoner.',
  },
  {
    phase: 'plan',
    agent: 'planner',
    model: 'claude-opus-5',
    vendor: 'Claude',
    why: 'Creative reach — turns a vague ask into an approach worth building.',
  },
  {
    phase: 'build',
    agent: 'builder',
    model: 'gpt-5.6-sol',
    vendor: 'Codex',
    why: 'Mechanical precision. Executes the plan as written, without redesigning it.',
  },
  {
    phase: 'production_check',
    agent: 'finisher',
    model: 'qwen3-coder-next',
    vendor: 'local',
    why: 'Weights on your own machine. An audit pass costs nothing per token.',
  },
  {
    phase: 'review',
    agent: 'reviewer',
    model: 'grok-5',
    vendor: 'Grok',
    why: "A reviewer that shares the builder's blind spots is not a review.",
  },
  {
    phase: 'open_pr',
    agent: 'pr_writer',
    model: 'kimi-k3',
    vendor: 'Kimi',
    why: 'Writing prose from a finished diff. Any competent model does this well.',
  },
];

/** The Bridge turns a subscription you already pay for into a local endpoint. */
export const SUBSCRIPTIONS: Array<[string, string]> = [
  ['Claude', 'claude'],
  ['ChatGPT (Codex)', 'openai'],
  ['Gemini (Antigravity)', 'gemini'],
  ['Kimi', 'kimi'],
  ['Grok', 'grok'],
];

export const DIRECT_KEYS =
  'Anthropic · OpenAI · Google · Vertex · Bedrock · Azure · OpenRouter · Groq · Cerebras · Fireworks · Together · DeepSeek · Mistral · MiniMax · Moonshot · NVIDIA · xAI · Z.ai · Baseten · Hugging Face · Cloudflare';

/* ── Smith: the native in-app operator chat ─────────────────────────────
 * Smith is not a skill and not a CLI. It is a chat on the bundled pi runtime
 * with typed tools, rich inline artifacts, and one approval slot: every
 * privileged action stops at a card before it runs.
 */

export type SmithRowKind = 'user' | 'tool' | 'note' | 'artifact' | 'card' | 'receipt' | 'error';

export interface SmithRow {
  kind: SmithRowKind;
  text: string;
}

export const SMITH_FACTS: Array<[string, string]> = [
  ['Surface', 'A screen, plus a launcher docked in the titlebar'],
  ['Scope', 'One persistent chat per project, one global'],
  ['Reads', 'Answer immediately — entities, runs, PRs, settings, doctor'],
  ['Writes', 'One approval card at a time, executor held in main'],
  ['Artifacts', '17 typed inline cards; presentation only, never a write'],
  ['Secrets', 'An API key is entered on the card and never enters the chat'],
];

export const SMITH_TOOLS: string[] = [
  'smith_list',
  'smith_show',
  'smith_propose',
  'smith_entities',
  'smith_settings',
  'smith_projects',
  'smith_runs',
  'smith_prs',
  'smith_interrupts',
  'smith_providers',
  'smith_companion',
  'smith_system',
  'smith_present',
];

export const SMITH_LEAD: SmithRow[] = [
  {
    kind: 'user',
    text: 'This chain never lints. Add a lint command phase between build and test.',
  },
  { kind: 'tool', text: 'smith_list · pipeline → 6 shipped, 2 forked' },
  { kind: 'tool', text: 'smith_show · pipeline build-pr → 6 phases' },
  { kind: 'tool', text: 'smith_projects · commands → test, lint, typecheck, build' },
  {
    kind: 'note',
    text: 'The project already defines a lint command, so the phase can reference it rather than hardcoding argv.',
  },
  { kind: 'artifact', text: 'PIPELINE DESIGN · build-pr · 7 phases · +lint after build' },
];

export const SMITH_PENDING: SmithRow = {
  kind: 'card',
  text: 'pipeline · build-pr · overwrites the stored definition',
};

export const SMITH_APPROVED: SmithRow[] = [
  { kind: 'receipt', text: 'ACTION RECEIPT · pipeline saved · build-pr now runs 7 phases' },
  {
    kind: 'note',
    text: 'Saved, and Design is open on it. Approval is not success — the receipt carries what the executor actually did.',
  },
];

export const SMITH_REJECTED: SmithRow[] = [
  { kind: 'error', text: 'REJECTED · nothing was written' },
  {
    kind: 'note',
    text: 'The pipeline is unchanged. Tell me what to do differently and I will propose again.',
  },
];

/* ── the phone ───────────────────────────────────────────────────────────
 * A LAN host inside the main process. Every route is a projection of an
 * operation the desktop already has, so the phone can never do something the
 * window cannot.
 */

export const COMPANION_POINTS: Array<[string, string]> = [
  [
    'Start and watch runs',
    'The same composer, the same waterfall, the same trace pages the desktop reads.',
  ],
  [
    'Answer a checkpoint',
    'An engineer phase blocking on a question can be approved, edited, or rejected from the couch.',
  ],
  [
    'Open the pull request',
    'The PR path is the desktop’s — the phone asks main to run it, it never runs gh itself.',
  ],
  [
    'Paired, not exposed',
    'Bound to your LAN address, not 0.0.0.0. Pairing spends a short-lived single-use secret; every later call needs a token that hashes to a paired device.',
  ],
];

export const PHONE_SHOTS: Array<{ file: string; name: string; desc: string }> = [
  {
    file: 'android-runs-live-and-history',
    name: 'Runs',
    desc: 'Live runs and history, the same rows the desktop shows.',
  },
  {
    file: 'android-run-detail-live',
    name: 'Live run',
    desc: 'The waterfall streaming mid-phase, on the phone.',
  },
  {
    file: 'android-run-detail-interrupt',
    name: 'Checkpoint',
    desc: 'An engineer phase waiting on a human, answerable here.',
  },
  {
    file: 'android-new-run-composer',
    name: 'Composer',
    desc: 'Pick a project and pipeline, describe the work, start it.',
  },
  {
    file: 'android-run-detail-create-pr',
    name: 'Open PR',
    desc: 'The desktop’s PR path, requested from the phone.',
  },
  {
    file: 'android-pair-screen',
    name: 'Pairing',
    desc: 'One QR, one single-use secret, one paired device.',
  },
];

/* ── readiness ─────────────────────────────────────────────────────────── */

export const READINESS_POINTS: Array<[string, string]> = [
  [
    'It checks the repo, not the vibe',
    'A language- and monorepo-aware static checklist: does the project tell an agent how to build, test, and behave?',
  ],
  [
    'It fixes what it finds',
    'One agent turn writes the missing guidance in an isolated foundry-ready worktree and opens a pull request for it.',
  ],
  [
    'The proof is a committed file',
    '.agents/agent-ready.json on your base ref. A marker only in your local checkout proves nothing, so only the base ref counts.',
  ],
  [
    'A merged PR is not proof',
    'After the fast-forward it re-reads the base ref. No valid marker there means not ready, and it says so.',
  ],
];

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
    name: 'Inspection bay',
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
    file: 'runs',
    name: 'Runs',
    desc: 'The composer with the chain laid out, readiness, and whether your base ref is behind its remote.',
  },
  {
    file: 'run-detail',
    name: 'Run detail',
    desc: 'The waterfall, the outcome banner, and per-phase Report / Checks / Prompt.',
  },
  {
    file: 'inspector',
    name: 'Inspector',
    desc: 'Every phase as a lane: streaming tool calls, context occupancy, the model that actually answered.',
  },
  {
    file: 'pipeline-canvas',
    name: 'Pipelines',
    desc: 'Freeform editing — drag phases, set boundaries, saved the moment it validates.',
  },
  {
    file: 'agents',
    name: 'Agents',
    desc: 'Nine specialists, every prompt, model, tool surface and boundary editable in place.',
  },
  {
    file: 'smith',
    name: 'Smith',
    desc: 'The native operator chat, answering with typed artifact cards instead of prose.',
  },
  {
    file: 'prs',
    name: 'Pull requests',
    desc: "Your repo's open PRs, merge method and all, without leaving the app.",
  },
  {
    file: 'providers',
    name: 'Providers',
    desc: 'Subscriptions through the Bridge, direct keys in the runtime store, one catalog out.',
  },
];
