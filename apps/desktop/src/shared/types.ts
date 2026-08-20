/**
 * The one contract both processes import. Main owns the implementations; the
 * renderer only ever sees these shapes across `ipc.ts`.
 */

// ── Pipelines (data, not scripts) ────────────────────────────────────────────

export type PhaseKind = 'agent' | 'code' | 'engineer';
export type PhaseStatus = 'queued' | 'running' | 'success' | 'fail' | 'skipped';
export type RunStatus = 'running' | 'accepted' | 'rejected' | 'failed' | 'killed';
/** Which agent transport answered for a run. Agent phases run in-process on pi. */
export type RunMode = 'pi';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type EnvelopeKind =
  'generic' | 'brief' | 'plan' | 'build' | 'scout' | 'review' | 'document' | 'pr' | 'issue';

/** Built-in envelope kinds. Custom envelopes are named strings outside this set. */
export const BUILTIN_ENVELOPE_KINDS: readonly EnvelopeKind[] = [
  'generic',
  'brief',
  'plan',
  'build',
  'scout',
  'review',
  'document',
  'pr',
  'issue',
] as const;

/** One-line blurbs for picker UIs. Keep in sync with `engine/envelopes.ts` schemas. */
export const BUILTIN_ENVELOPE_BLURBS: Record<EnvelopeKind, string> = {
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

/** Hard schema bound for `pr.title` and `issue.title`. Style guidance is tighter (≤72). */
export const PR_TITLE_MAX = 120;

/** Default roster name for the PR writer setting. */
export const DEFAULT_PR_AGENT = 'pr_writer';

/**
 * Repository-relative PR template locations, first match wins.
 * A glob means the first matching file in lexicographic order.
 */
export const PR_TEMPLATE_SEARCH_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  '.github/PULL_REQUEST_TEMPLATE/*.md',
  'docs/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
] as const;

/** Headings the writer uses when no repository template exists. */
export const PR_FALLBACK_HEADINGS = [
  'Summary',
  'Motivation',
  'Changes',
  'Verification',
  'Risk',
] as const;

/** How a code phase names the process it runs. */
export type CommandSpec =
  { ref: string } | { builtin: BuiltinCommand; messageFrom?: string } | { argv: string[] };

export type BuiltinCommand = 'git_commit' | 'git_status' | 'noop';

export interface GateSpec {
  gate: string;
  /** Config for parameterised gates, e.g. command_passes needs argv. */
  config?: Record<string, unknown>;
}

export interface PromptSpec {
  /** Declared inputs: `request`, `envelope:<phase>`, `handoff_files`, `feedback`. */
  inputs: string[];
}

export interface PhaseDef {
  name: string;
  kind: PhaseKind;
  /** A phase name identifies; a description explains. Both are required. */
  description: string;
  agent?: string;
  /** Optional phase override of the selected agent's model. Absent means inherit. */
  model?: string;
  /**
   * Optional phase override of the agent's envelope. Absent means inherit
   * `agent.envelope`. The engine resolves `phase.envelope ?? agent.envelope`.
   */
  envelope?: string;
  gates?: (string | GateSpec)[];
  prompt?: PromptSpec;
  command?: CommandSpec;
  retries?: number;
  /** On failure, hand the evidence back to this earlier agent phase. */
  feedbackTo?: string;
  feedbackRetries?: number;
  /** Engineer phases: what the sheet asks the human. */
  question?: string;
  timeoutMs?: number;
  /** Code phases: a non-zero exit is recorded but does not fail the run. */
  optional?: boolean;
}

/** A freely positioned point on the Pipelines canvas, in canvas coordinates. */
export interface PipelineCanvasPoint {
  x: number;
  y: number;
}

/** Presentation-only state for the Pipelines canvas. It never affects execution order. */
export interface PipelineCanvas {
  /** Phase-name keyed positions. Phase names are unique in a valid pipeline. */
  nodes?: Record<string, PipelineCanvasPoint>;
  /** The operator's last pan and zoom level. */
  viewport?: PipelineCanvasPoint & { zoom: number };
}

export type Acceptance =
  | { kind: 'phase_flag'; phase: string; flag: 'passed' | 'approved' }
  | { kind: 'all_phases_pass' }
  | { kind: 'last_phase_pass' }
  | { kind: 'envelope_status'; phase: string };

export interface PipelineDef {
  id: string;
  name: string;
  description: string;
  acceptance: Acceptance;
  phases: PhaseDef[];
  /** Docs-only chains can opt out of worktree isolation. */
  isolation?: boolean;
  builtin?: boolean;
  /** Persisted board presentation; deliberately separate from the run definition. */
  canvas?: PipelineCanvas;
}

// ── Roster ───────────────────────────────────────────────────────────────────

export interface CustomEnvelopeField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required: boolean;
  description?: string;
}

/**
 * A named custom envelope in the shared library. Built from the generic base
 * plus typed fields; selectable anywhere a built-in envelope kind is.
 */
export interface EnvelopeDef {
  name: string;
  description?: string;
  fields: CustomEnvelopeField[];
}

/**
 * `writes: null` = unrestricted (minus protected paths); `[]` = read-only;
 * a list = only those paths, prefixes, or globs.
 */
export type WriteBoundary = string[] | null;

export interface AgentDef {
  name: string;
  purpose: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  /**
   * When true, a run uses Settings → Agent defaults for both model and
   * reasoning. Stored `model` / `reasoningEffort` remain the fallback when this
   * is off. Absent means off.
   */
  inheritDefaults?: boolean;
  systemPrompt: string;
  userPrompt: string;
  writes: WriteBoundary;
  /** Built-in EnvelopeKind or a custom envelope name from the shared library. */
  envelope: string;
  customFields?: CustomEnvelopeField[];
  color: string;
  /**
   * How this agent is drawn. Absent or `monogram` is the initial letter.
   * A library id (`anvil`, `loupe`, …) is stroke linework. `image:<file>` is
   * a user upload under the support dir. Any other safe token is the painted
   * portrait at `agents/<token>.png` (what the shipped roster stores).
   */
  emblem?: string;
  builtin?: boolean;
}

/**
 * The envelope a phase actually uses. Matches the engine rule
 * `phase.envelope ?? agent.envelope`. An absent phase envelope is inheritance,
 * not "no envelope".
 */
export function effectivePhaseEnvelope(
  phase: Pick<PhaseDef, 'envelope' | 'agent'>,
  agents: ReadonlyArray<Pick<AgentDef, 'name' | 'envelope'>>,
): string | undefined {
  if (phase.envelope) return phase.envelope;
  if (!phase.agent) return undefined;
  return agents.find((agent) => agent.name === phase.agent)?.envelope;
}

/**
 * What a run actually uses for this agent. `inheritDefaults` takes both knobs
 * from Settings → Agent defaults. Otherwise only `model: "inherit"` follows the
 * default model; reasoning stays on the agent.
 */
export function resolveAgentExecution(
  agent: Pick<AgentDef, 'model' | 'reasoningEffort' | 'inheritDefaults'>,
  defaults: { model?: string; reasoningEffort: ReasoningEffort },
): { model: string; reasoningEffort: ReasoningEffort } {
  if (agent.inheritDefaults) {
    return {
      model: defaults.model && defaults.model !== 'inherit' ? defaults.model : 'inherit',
      reasoningEffort: defaults.reasoningEffort,
    };
  }
  return {
    model:
      agent.model === 'inherit' && defaults.model && defaults.model !== 'inherit'
        ? defaults.model
        : agent.model,
    reasoningEffort: agent.reasoningEffort,
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface AppSettings {
  /**
   * Model for project detection and readiness, as a `provider/model` id.
   * `inherit` follows `defaultModel`.
   */
  helperModel: string;
  /** Reasoning effort for project detection, readiness evaluation, and remediation. */
  helperReasoningEffort: ReasoningEffort;
  /** Recorded on every run so a trace says who asked for it. */
  engineerName: string;
  /**
   * Roster name used when a pipeline (or later UI) needs a PR writer.
   * Defaults to the shipped `pr_writer` builtin.
   */
  prAgent: string;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  turnTimeoutMs: number;
  /**
   * How full an agent's context may get before the engine compacts it between
   * phases, as a fraction of the model's window.
   */
  compactionThreshold: number;
  notifications: { accepted: boolean; rejected: boolean; failed: boolean; needsInput: boolean };
  dockBadge: boolean;
  /** Which terminal emulator "Open in terminal" hands a directory to. */
  terminalApp: TerminalAppId | null;
  /**
   * Which coding-agent CLI Smith starts in that terminal. Settings stores the
   * catalog `id`, never a binary name, so a hand-edited file cannot put an
   * arbitrary string on the session command line.
   */
  codingAgent: CodingAgentId | null;
  retentionDays: number | null;
  onboarded: boolean;
  /**
   * Model IDs the operator chose to hide from choosers. App-scoped filter on
   * catalog reads.
   */
  hiddenModelIds: string[];
}

/** Engine retry policy is intentionally fixed rather than operator configuration. */
export const FIXED_ENGINE_DEFAULTS = {
  envelopeRetries: 3,
  gateRetries: 2,
  rewindAfterCorrections: 2,
} as const;

export type MergePolicy = 'auto' | 'ask' | 'never';

// ── Pull requests (via the gh CLI) ───────────────────────────────────────────

/** One word per PR, summarised from gh's per-context statusCheckRollup. */
export type PrChecks = 'passing' | 'failing' | 'pending' | 'none';

export type PrMergeMethod = 'merge' | 'squash';

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  additions: number;
  deletions: number;
  isDraft: boolean;
  checks: PrChecks;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  /** '' when the repo requires no review; otherwise gh's reviewDecision verbatim. */
  reviewDecision: string;
}

/**
 * Whether PR features can work at all for a repo: gh installed, authenticated,
 * and the repo resolving to something on GitHub. `detail` carries the reason
 * when they cannot, in gh's own words where possible.
 */
export interface GhStatus {
  available: boolean;
  detail: string;
  /** owner/name when the repo resolved, so the UI can say which repo. */
  repo?: string;
}

/**
 * Who gh is signed in as, asked without a repo in hand. Creating a repository
 * happens before any local checkout exists, which is the one question
 * `ghStatus` cannot answer: it resolves the repo of a directory.
 */
export interface GithubAccount {
  available: boolean;
  detail: string;
  /** The authenticated login, which is also the default owner for a new repo. */
  login?: string;
  /** Owners a repo can be created under: the login first, then its orgs. */
  owners?: string[];
}

export interface ProjectCommand {
  name: string;
  argv: string[];
}

export interface ProjectDef {
  id: string;
  name: string;
  path: string;
  baseRef: string;
  isolation: boolean;
  mergePolicy: MergePolicy;
  commands: ProjectCommand[];
  protectedPaths: string[];
  ownRoster: boolean;
  ownPipelines: boolean;
  /**
   * Created empty from Foundry rather than pointed at an existing checkout, so
   * it has no build or test command yet. Code phases whose `{ref}` is still
   * unconfigured skip instead of failing the run, and start-time detection does
   * not spend an agent turn looking for commands that cannot exist. Cleared as
   * soon as a command is found.
   */
  scaffold?: boolean;
  /**
   * Cache only: last time Foundry saw a valid `.agents/agent-ready.json`.
   * The marker file is the source of truth; this never overrides it.
   */
  readinessValidated?: boolean;
  /**
   * The operator explicitly skipped the readiness flow. Re-runnable from
   * project settings; the Runs banner still reflects the marker file.
   */
  readinessSkipped?: boolean;
  /**
   * Shell script run at the worktree root via `sh -c` after every
   * `git worktree add`. Installs deps so agents find their binaries.
   * Empty means nothing to run.
   */
  setupScript?: string;
  addedAt: string;
}

/**
 * Whether the project's local base ref matches the preferred remote.
 * Inspect fetches the remote-tracking ref only; it never moves local branches.
 * Sync is fast-forward only — a diverged base is reported, not rewritten.
 */
export type BaseSyncState = 'current' | 'behind' | 'ahead' | 'diverged' | 'no_remote' | 'error';

export interface BaseSyncStatus {
  projectId: string;
  baseRef: string;
  remote: string | null;
  localSha: string | null;
  remoteSha: string | null;
  ahead: number;
  behind: number;
  state: BaseSyncState;
  /** False when the comparison used a previously fetched tracking ref. */
  fetched: boolean;
  detail: string;
}

export interface BaseSyncResult {
  ok: boolean;
  status: BaseSyncStatus;
}

// ── Agent readiness (project onboarding, not a pipeline phase) ───────────────

/** Criteria the readiness check must judge. N/A is a recorded adaptation. */
export const READINESS_CRITERION_IDS = [
  'lint_format',
  'typecheck',
  'tests',
  'build',
  'setup',
  'agents_md',
  'env_example',
  'ci_parity',
  'templates',
  'precommit',
  'coverage',
] as const;

export type ReadinessCriterionId = (typeof READINESS_CRITERION_IDS)[number];

export type ReadinessCriterionStatus = 'pass' | 'fail' | 'n/a';

export interface ReadinessCriterion {
  id: ReadinessCriterionId;
  status: ReadinessCriterionStatus;
  measurement?: Record<string, unknown>;
  notes: string;
}

export interface AgentReadyStack {
  languages: string[];
  monorepo: boolean;
  packages: string[];
}

/**
 * Portable proof that a repo is ready for agent-driven work. Lives at
 * `.agents/agent-ready.json` and travels with the repo.
 */
export interface AgentReadyMarker {
  schemaVersion: 1;
  generatedAt: string;
  commit: string;
  agent: { harness: string; model: string; reasoningEffort: string };
  verdict: 'ready';
  summary: string;
  stack: AgentReadyStack;
  criteria: ReadinessCriterion[];
}

export interface ReadinessEvaluation {
  stack: AgentReadyStack;
  criteria: ReadinessCriterion[];
  ready: boolean;
  summary: string;
}

export type ReadinessPhase =
  | 'idle'
  | 'inspecting'
  | 'confirming'
  | 'evaluating'
  | 'not_ready'
  | 'remediating'
  | 'verifying'
  /** Isolated work is kept; Continue sends remaining failures back. */
  | 'needs_continue'
  | 'pr_ready'
  | 'awaiting_merge'
  | 'confirming_merge'
  | 'finalizing'
  | 'complete'
  | 'skipped'
  | 'failed';

export interface ReadinessAskQuestion {
  index: number;
  question: string;
  options: string[];
}

export interface ReadinessPendingAsk {
  askId: string;
  questions: ReadinessAskQuestion[];
}

export interface ReadinessAskAnswer {
  index: number;
  answer: string;
}

/**
 * What kind of work one tool call in a live transcript was, so a panel can
 * icon it without knowing tool names. Deliberately coarse and shared by every
 * transcript the app renders — detection, setup, and the readiness fix — so
 * their icon maps cannot drift apart.
 */
export type TranscriptToolKind = 'command' | 'read' | 'edit' | 'search' | 'other';

/**
 * One line in a live panel transcript. Shared by detection, setup, and
 * readiness so their icon maps and folding cannot drift apart.
 */
export interface PanelEntry {
  id: string;
  kind: 'text' | 'tool' | 'note' | 'error';
  text: string;
  /** Tool entries only: what kind of work it was, so the UI can icon it. */
  toolKind?: TranscriptToolKind;
  /** Tool entries only: set once the result arrives. */
  done?: boolean;
  failed?: boolean;
  at: number;
}

export type ReadinessEntry = PanelEntry;

/**
 * Fields every one-shot panel state carries. Feature-specific state extends
 * this rather than restating the core.
 */
export interface PanelStateCore {
  model: string;
  entries: PanelEntry[];
  detail: string;
  startedAt: number;
  endedAt?: number;
}

export interface ReadinessPr {
  number: number;
  url: string;
  merged: boolean;
}

export interface ReadinessState extends PanelStateCore {
  sessionId: string;
  projectId: string;
  phase: ReadinessPhase;
  reasoningEffort: ReasoningEffort;
  marker: AgentReadyMarker | null;
  markerValid: boolean;
  markerDetail: string;
  evaluation: ReadinessEvaluation | null;
  pendingAsk: ReadinessPendingAsk | null;
  pr: ReadinessPr | null;
  mergeDetail: string;
  skipDetail: string;
  /** The phase that was running when the session failed, so the stepper can mark it. */
  failedPhase?: ReadinessPhase;
}

/**
 * Banner/settings status. Always derived from the marker committed on the
 * project's base ref, never from the cache.
 */
export interface ReadinessInspectResult {
  projectId: string;
  markerValid: boolean;
  marker: AgentReadyMarker | null;
  markerDetail: string;
  skipped: boolean;
  validatedCache: boolean;
  ready: boolean;
  /** Which tree answered: the base ref, or the working checkout as a fallback. */
  markerSource?: 'base-ref' | 'worktree';
  /** The ref the marker was read from, when git answered. */
  markerRef?: string;
}

// ── Trace rows (what the renderer polls) ─────────────────────────────────────

export interface RunRow {
  runId: string;
  projectId: string;
  pipelineId: string;
  pipelineName: string;
  request: string;
  status: RunStatus;
  engineer: string;
  worktreePath: string | null;
  branch: string | null;
  baseRef: string | null;
  /** The base commit the run branched from, so a later merge can check drift. */
  branchPointSha: string | null;
  /** Why the run ended as it did, in the words the banner shows. */
  outcomeDetail: string | null;
  /** Set once a PR has been opened for this run's branch. */
  prNumber: number | null;
  prUrl: string | null;
  /** Set once a GitHub issue has been filed by this run. */
  issueNumber: number | null;
  issueUrl: string | null;
  merged: boolean;
  archived: boolean;
  mode: RunMode;
  startedAt: string;
  endedAt: string | null;
  totalTokens: number;
  /** Denormalised for the run list; cheap because phases are few. */
  phaseSummary?: { name: string; status: PhaseStatus; kind: PhaseKind }[];
}

export interface PhaseRow {
  phaseId: string;
  runId: string;
  seq: number;
  name: string;
  kind: PhaseKind;
  owner: string;
  description: string;
  status: PhaseStatus;
  attempt: number;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export type EventType =
  | 'phase_start'
  | 'phase_end'
  | 'agent_start'
  | 'agent_end'
  | 'tool_call'
  | 'assistant_text'
  | 'thinking'
  | 'handoff'
  | 'gate_pass'
  | 'gate_fail'
  | 'correction'
  | 'interrupt'
  | 'compaction'
  | 'log'
  | 'error';

export interface EventRow {
  rowid: number;
  /**
   * Monotonic per-row revision, bumped on every insert and in-place update.
   * The poll cursor walks this (not rowid), so a patched row — a tool result
   * landing, a thinking block growing — reflows to the renderer live instead
   * of only on reopen.
   */
  changeId: number;
  eventId: string;
  runId: string;
  phaseId: string | null;
  parentId: string | null;
  type: EventType;
  name: string;
  payload: Record<string, unknown>;
  tokens: number;
  startedAt: string;
  endedAt: string | null;
}

export interface EnvelopeRow {
  envelopeId: string;
  runId: string;
  phaseId: string;
  agent: string;
  schemaKind: string;
  payload: Record<string, unknown>;
  valid: boolean;
  attempt: number;
  createdAt: string;
}

export interface GateCheck {
  item: string;
  ok: boolean;
  note: string;
}

export interface GateResultRow {
  id: number;
  runId: string;
  phaseId: string;
  attempt: number;
  gate: string;
  passed: boolean;
  checks: GateCheck[];
  createdAt: string;
}

export interface AgentSessionRow {
  runId: string;
  agent: string;
  model: string;
  reasoningEffort: string;
  /** The agent runtime's own session id. */
  agentSessionId: string | null;
  mode: RunMode;
  color: string;
  contextTokens: number;
  contextWindow: number;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * What is occupying an agent's context window, as pi accounts for it.
 *
 * Pi reports one estimate for the whole conversation rather than a per-source
 * composition, so this is four numbers and the model they belong to. The
 * occupancy can differ from `AgentSessionRow.contextTokens` by a token or two:
 * they are two reads of a moving number, so a view shows one of them, never a
 * difference between them.
 */
export interface ContextBreakdown {
  modelId: string;
  modelDisplayName: string;
  contextBudget: number;
  usedTokens: number;
  freeTokens: number;
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  /** Providers that omit usage get an honest gap, not a zero. */
  reported: boolean;
}

// ── Engine reports ───────────────────────────────────────────────────────────

export interface CommandResult {
  name: string;
  command: string;
  exitCode: number | null;
  passed: boolean;
  durationMs: number;
  outputTail: string;
  timedOut: boolean;
}

export interface BoundaryViolation {
  path: string;
  change: string;
  reverted: boolean;
}

export interface ModelInfo {
  id: string;
  displayName: string;
  provider: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  isCustom: boolean;
  deprecated: boolean;
  contextWindow?: number;
}

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /**
   * A failure that stops onboarding. Only git and a reachable model qualify: a
   * provider the operator never signed into is a fact about the machine, not a
   * broken setup, and blocking on one would make the app unusable to anyone who
   * wants a subset.
   */
  blocking?: boolean;
  fix?: { kind: 'open-url' | 'open-settings' | 'run'; value: string };
}

/**
 * A deliberate checkpoint an engineer phase in the pipeline asked for. Runs
 * never stop for permission: those are settled by the engine policy and only
 * appear in the trace.
 */
export interface PendingInterrupt {
  interruptId: string;
  runId: string;
  phaseId: string | null;
  kind: 'engineer';
  title: string;
  body: string;
  /** Engineer phases accept edited text alongside approve/reject. */
  options: { id: string; label: string; kind: 'approve' | 'reject' | 'edit' }[];
  createdAt: string;
}

export interface InterruptAnswer {
  interruptId: string;
  decision: 'approve' | 'reject';
  text?: string;
}

export interface StartRunInput {
  projectId: string;
  pipelineId: string;
  request: string;
}

export interface DryRunPrompt {
  phase: string;
  agent: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

export interface OrphanWorktree {
  path: string;
  branch: string;
  runId: string | null;
  projectId: string;
}

export interface MaintenanceReport {
  runsDeleted: number;
  bytesReclaimed: number;
  worktreesRemoved: number;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

// ── Terminals ────────────────────────────────────────────────────────────────

/** The terminal emulators Foundry can hand a directory to. */
export type TerminalAppId = 'terminal' | 'iterm' | 'ghostty' | 'warp' | 'alacritty' | 'kitty';

export interface TerminalAppInfo {
  id: TerminalAppId;
  label: string;
  /**
   * The macOS application name `open -a` resolves. Settings stores the `id`, not
   * this, so the value handed to `open` is always one of ours — never a string a
   * user typed.
   */
  appName: string;
  /**
   * Whether Foundry can start the session itself rather than only opening a
   * directory at it. That needs an emulator which runs a command given on its
   * own command line — on macOS, Ghostty's documented `open -na Ghostty.app
   * --args -e <command>`. The others take a directory and nothing else, so they
   * keep the copyable handoff.
   */
  prepared?: true;
}

/** Terminal.app first: it is the only one guaranteed to be installed. */
export const TERMINAL_APPS: readonly TerminalAppInfo[] = [
  { id: 'terminal', label: 'Terminal', appName: 'Terminal' },
  { id: 'iterm', label: 'iTerm2', appName: 'iTerm' },
  { id: 'ghostty', label: 'Ghostty', appName: 'Ghostty', prepared: true },
  { id: 'warp', label: 'Warp', appName: 'Warp' },
  { id: 'alacritty', label: 'Alacritty', appName: 'Alacritty' },
  { id: 'kitty', label: 'kitty', appName: 'kitty' },
] as const;

// ── Coding agents (Smith's prepared-session CLI) ─────────────────────────────

/**
 * The coding-agent CLIs Foundry can start in a prepared Smith session.
 *
 * Settings stores the `id`. The binary name is looked up on PATH at launch, so
 * a hand-edited settings file cannot put an arbitrary string on the command
 * line — the same lock `terminalApp` has for `open -a`.
 */
export type CodingAgentId = 'droid' | 'claude' | 'codex' | 'opencode' | 'pi';

export interface CodingAgentInfo {
  id: CodingAgentId;
  label: string;
  /** The PATH name `whichBinary()` looks up. Never stored in settings. */
  binary: string;
}

/** Droid first: it is what existing Smith sessions already start. */
export const CODING_AGENTS: readonly CodingAgentInfo[] = [
  { id: 'droid', label: 'Droid', binary: 'droid' },
  { id: 'claude', label: 'Claude Code', binary: 'claude' },
  { id: 'codex', label: 'Codex', binary: 'codex' },
  { id: 'opencode', label: 'OpenCode', binary: 'opencode' },
  { id: 'pi', label: 'Pi', binary: 'pi' },
] as const;

/** The chosen agent, falling back to Droid for an id we no longer know. */
export function codingAgentFor(id: CodingAgentId): CodingAgentInfo {
  return CODING_AGENTS.find((agent) => agent.id === id) ?? CODING_AGENTS[0]!;
}

// ── Smith (the entity-smith skill's approval gate) ───────────────────────────

/**
 * What Smith proposes writing through the helper CLI. One entity, staged for a
 * human to approve before the store is touched. `spec` is the entity JSON as the
 * store would save it (an `AgentDef`, `PipelineDef`, or `EnvelopeDef`), carried
 * as `unknown` because the card only needs to render and forward it.
 */
export interface SmithProposal {
  id: string;
  kind: 'agent' | 'pipeline' | 'envelope';
  mode: 'create' | 'edit';
  /** The entity's identifying name (agents/envelopes) or id (pipelines). */
  name: string;
  /** The entity JSON, validated but not yet saved. */
  spec: unknown;
  /** Non-blocking warnings the store surfaced; errors would have refused earlier. */
  validation: ValidationIssue[];
  /** True when a stored entity already carries this name/id — approving overwrites it. */
  overwrites: boolean;
  /** Which project the proposing session scoped itself to, so save uses the right scope. */
  projectId: string;
  createdAt: string;
}

/**
 * The answer a human gives a proposal card. The card sends no `note`: the agent
 * is sitting in the user's own terminal, so revision guidance is simply the next
 * thing they type there. `note` survives for the shutdown path, which explains
 * itself to a CLI it is unblocking.
 */
export interface SmithProposalAnswer {
  approved: boolean;
  note?: string;
}

/**
 * Everything the renderer needs to hand a Smith session off to the user's own
 * terminal. Resolved in main because only main knows where the app is installed,
 * where the skill shipped, and which terminal the settings chose.
 */
export interface SmithLaunchInfo {
  /** Absolute path to the helper binary. Invoke it as `node <cliPath>`. */
  cliPath: string;
  /** Absolute path to the skill directory shipped inside the app bundle. */
  skillDir: string;
  /** The unix socket the CLI connects to, for the troubleshooting case. */
  socketPath: string;
  /** A shell block that aliases `foundry-cli` and exports the project scope. */
  bootstrap: string;
  /** The terminal the launch button will use, and whether it is actually installed. */
  terminal: TerminalAppInfo & { installed: boolean };
  /** The coding-agent CLI the prepared session starts. */
  agent: CodingAgentInfo;
  /**
   * True when this launch will start the agent itself: the chosen terminal
   * supports being handed a command, and the agent CLI resolved to a real file.
   * False falls back to opening the directory and letting the user paste.
   */
  canAutoStart: boolean;
  /** Why an auto-start is unavailable, for the launcher to say so plainly. */
  autoStartBlocked?: 'terminal' | 'agent-cli';
  /** The opening instruction the agent is started with, shown before it is sent. */
  prompt: string;
  /** The project the session would scope to; null means no project is selected. */
  project: { id: string; name: string; path: string; exists: boolean } | null;
}

/**
 * What the sidebar's Smith click did.
 *
 * `started` is the whole point of the prepared path: there is nothing to show,
 * because the session is already up in the user's terminal. Every other outcome
 * carries the reason the launcher has to open — so the modal is the exception,
 * not a toll booth in front of the common case.
 */
export type SmithStartResult =
  | { status: 'started' }
  | { status: 'needs-launcher'; reason: SmithLaunchInfo['autoStartBlocked'] | 'project' }
  | { status: 'error'; error: string };

// ── Updater ──────────────────────────────────────────────────────────────────

export type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  stage: UpdateStage;
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
}
