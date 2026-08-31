/**
 * The one contract both processes import. Main owns the implementations; the
 * renderer only ever sees these shapes across `ipc.ts`.
 */

// ── Pipelines (data, not scripts) ────────────────────────────────────────────

export type PhaseKind = 'agent' | 'code';
export type PhaseStatus = 'queued' | 'running' | 'success' | 'fail' | 'skipped';
export type RunStatus = 'running' | 'accepted' | 'rejected' | 'failed' | 'killed';
/** Which agent transport answered for a run. Agent phases run in-process on pi. */
export type RunMode = 'pi';
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  /** Code phases: a non-zero exit is recorded but does not fail the run. */
  optional?: boolean;
  /**
   * Code phases: whether a failing command gets a healing agent before the
   * failure escalates. Absent means on, which is what every phase whose
   * failure fails the run wants. `false` opts one out.
   */
  heal?: boolean;
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

/**
 * Which tools a run session is opened with. `read-only` is not a policy that
 * refuses a write: the editing and shell tools are absent from the session's
 * registry, so nothing the agent can call could write. Absent means `full`.
 */
export type ToolProfile = 'full' | 'read-only';

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
  /**
   * The tool surface every session this agent opens is given. Absent means
   * `full`. `read-only` drops `edit`, `write`, and `bash` from the registry —
   * it is the tool list, not a refusal, so it cannot be talked around.
   */
  toolProfile?: ToolProfile;
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
 * Which kind of command a code phase carries, for the Designer's source
 * control. Engine behaviour does not branch on it.
 */
export type CommandSource = 'ref' | 'builtin' | 'argv';

/** Which of the three `CommandSpec` shapes a phase carries. */
export function commandSourceOf(command: CommandSpec | undefined): CommandSource {
  if (!command) return 'ref';
  if ('ref' in command) return 'ref';
  if ('builtin' in command) return 'builtin';
  return 'argv';
}

/**
 * Whether a failed command gets a healing agent before the failure escalates.
 *
 * `optional` always wins: a phase whose failure does not fail the run has
 * nothing to repair. Otherwise an explicit `heal` decides, and the default is
 * on for every remaining code phase.
 *
 * The command's source deliberately does not enter into it. Treating a commit
 * as un-healable plumbing was the obvious line to draw and the wrong one: a
 * repository with a pre-commit hook turns `git_commit` into a quality gate, so
 * the most common real commit failure is a check the hook ran and a fix the
 * hook itself named. What a command *is* does not predict whether its failure
 * is repairable, so the phase says, not the argv.
 *
 * Shared because the Designer's toggle and the engine's decision must be the
 * same rule: a phase the editor draws as healing has to actually heal.
 */
export function healingEligible(phase: Pick<PhaseDef, 'optional' | 'heal'>): boolean {
  if (phase.optional) return false;
  return phase.heal ?? true;
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

export type AppTheme = 'dark' | 'light';

export interface AppSettings {
  /** Application-wide desktop palette. Existing installs default to dark. */
  theme: AppTheme;
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
  /**
   * Model the healing agent runs on when a programmatic phase's command fails,
   * as a `provider/model` id. `inherit` follows `defaultModel`.
   */
  healingModel: string;
  /** Reasoning effort a healing turn opens at. */
  healingReasoningEffort: ReasoningEffort;
  /**
   * Model Smith's in-app chat runs on, as a `provider/model` id. `inherit`
   * follows this install's default.
   */
  smithModel: string;
  /**
   * Reasoning effort a new Smith chat opens at. A level the chosen model does
   * not support is normalized to that model's default before it reaches a
   * provider; the chat header can still override this per conversation.
   */
  smithReasoningEffort: ReasoningEffort;
  /**
   * How full an agent's context may get before the engine compacts it between
   * phases, as a fraction of the model's window.
   */
  compactionThreshold: number;
  notifications: { accepted: boolean; rejected: boolean; failed: boolean };
  dockBadge: boolean;
  retentionDays: number | null;
  onboarded: boolean;
  /**
   * Model IDs the operator chose to hide from choosers. App-scoped filter on
   * catalog reads.
   */
  hiddenModelIds: string[];
  /**
   * Linear workflow-state IDs for the three run lifecycle stages. IDs, rather
   * than names, are stored because each Linear team owns its own workflow.
   * The selected issue's team states are re-fetched before a run starts.
   */
  linearStatusMapping: LinearStatusMapping;
}

export interface LinearStatusMapping {
  started: string | null;
  completed: string | null;
  failed: string | null;
}

/** Engine retry policy is intentionally fixed rather than operator configuration. */
export const FIXED_ENGINE_DEFAULTS = {
  envelopeRetries: 3,
  gateRetries: 2,
  rewindAfterCorrections: 2,
  /**
   * How many healing turns one failing command gets before the failure
   * escalates through `feedbackTo` (or fails the run). Bounded here rather
   * than per pipeline: an unbounded healer is a run that never ends.
   */
  healingAttempts: 2,
  /** Mid-run pipeline amendments an orchestrated run may request. */
  replanAttempts: 2,
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
  /**
   * Once-per-project factual repository card generated by a privileged,
   * read-only one-shot and supplied to every run agent's system role.
   */
  contextSummary?: string;
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
  /** Immutable external source captured before the run entered preflight. */
  source: RunSource | null;
  /** Latest external status-sync failure, also recorded as an error event. */
  sourceSyncError: string | null;
  merged: boolean;
  archived: boolean;
  mode: RunMode;
  /** True when the run started from an Orchestrator-generated plan. */
  orchestrated: boolean;
  /** How many mid-run amendments the pipeline received, for the list badge. */
  amendments: number;
  startedAt: string;
  endedAt: string | null;
  totalTokens: number;
  /** Denormalised for the run list; cheap because phases are few. */
  phaseSummary?: { name: string; status: PhaseStatus; kind: PhaseKind }[];
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface LinearIssueSnapshot {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  updatedAt: string;
  team: { id: string; name: string };
  state: LinearWorkflowState;
}

export interface LinearRunSource {
  kind: 'linear';
  trigger: 'manual';
  issueId: string;
  url: string;
  /** Linear's `updatedAt` value from the fetch that supplied the run brief. */
  revision: string;
  /** Validated team workflow mapping frozen for this run's full lifecycle. */
  statusMapping: LinearStatusMapping;
  snapshot: LinearIssueSnapshot;
}

export type RunSource = LinearRunSource;

/**
 * How a continued run treats the interrupted phase's agent conversation.
 *
 * `reopen_session` is the correction workflow a rejected or failed run gets:
 * the agent's persisted session is reopened, so the retry costs one message on
 * a conversation that already holds the phase.
 *
 * `fresh_session` is what a killed run gets. The operator stopped that turn
 * mid-flight, so its conversation ends on a truncated exchange no one asked
 * for; reopening it would make the killed turn the context the retry reasons
 * from. The interrupted phase's agent starts a new session instead, and the
 * worktree — partial writes included — is what carries the work over.
 */
export type ContinueStrategy = 'reopen_session' | 'fresh_session';

/** Why a run of this status cannot be continued. */
export const CONTINUE_STATUS_REFUSAL = 'only a rejected, failed, or killed run can be continued';

/** Whether a settled run of this status can be continued at all. */
export function continuableStatus(status: RunStatus): boolean {
  return status === 'killed' || status === 'rejected' || status === 'failed';
}

/**
 * How this run would be continued, or null when it cannot be.
 *
 * The interrupted phase decides as much as the status does: only an agent
 * phase has a conversation to abandon. A killed `code` phase is still
 * continuable — a shell command simply re-runs — but nothing about it is a
 * "fresh session", so claiming one would put a false statement in the trace
 * and in front of the operator. Every surface (the executor, the registry's
 * gate, the banner, the Companion card) reads this one rule.
 *
 * The kind is required rather than optional: a caller that has not yet found
 * the interrupted phase is asking a different question, and
 * {@link continuableStatus} is the one that answers it. An optional parameter
 * would let that caller receive a strategy silently computed from a phase it
 * never looked at.
 */
export function continueStrategyFor(
  status: RunStatus,
  interruptedKind: PhaseKind | undefined,
): ContinueStrategy | null {
  if (!continuableStatus(status)) return null;
  if (status !== 'killed') return 'reopen_session';
  return interruptedKind === 'agent' ? 'fresh_session' : 'reopen_session';
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
  | 'replan'
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
 * How a checkpointed path stood at phase start.
 *
 * `modified` is tracked-and-dirty, `untracked` is not in the commit at all,
 * and `deleted` was absent from disk. `deleted` does not imply `headSha`
 * carries the path: an added-then-removed (`AD`) or renamed-away (`RD`) path
 * is absent from HEAD too, so restoring one means ensuring it stays absent,
 * not checking it out.
 */
export type PhaseCheckpointFileState = 'modified' | 'untracked' | 'deleted';

/**
 * Why a file's phase-start content is missing from the checkpoint payload.
 *
 * Size is not a reason: a checkpoint captures the dirty set in full. The only
 * shortfall left is a path that genuinely could not be read.
 */
export type PhaseCheckpointOmission = 'unreadable';

/**
 * One path as it stood when the phase began.
 *
 * Content, not just a hash: a hash can only detect that a file drifted, and
 * restoring a dirty tracked file to its phase-start state needs the bytes.
 * `omitted` is what makes a gap legible instead of silent.
 */
export interface PhaseCheckpointFile {
  path: string;
  state: PhaseCheckpointFileState;
  contentHash: string;
  size: number;
  content?: string;
  encoding?: 'utf8' | 'base64';
  omitted?: PhaseCheckpointOmission;
  /**
   * For a rename destination, where it came from. The source is recorded
   * separately as its own `deleted` entry, so a restore puts back one file
   * rather than resurrecting both sides.
   */
  renamedFrom?: string;
}

/**
 * The bulk half of a checkpoint, kept as JSON under the run directory so the
 * SQLite row stays small. Written before the phase runs and never rewritten.
 */
export interface PhaseCheckpointPayload {
  checkpointId: string;
  runId: string;
  phaseId: string;
  phaseName: string;
  generation: number;
  createdAt: string;
  /** Worktree HEAD when the phase began. */
  headSha: string;
  branch: string | null;
  worktreePath: string;
  /**
   * False when the run has no worktree, in which case `worktreePath` is the
   * operator's own checkout and this payload carries their uncommitted work.
   * A restore there writes to the checkout, not to a discardable worktree, so
   * it is a materially different act and split 2 must not treat the two alike.
   */
  isolated: boolean;
  /** The model appointed to this phase, or null for a phase with no agent. */
  model: string | null;
  agent: string | null;
  agentSessionId: string | null;
  /** Session leaf: the agent's last user-message id before the phase began. */
  leafMessageId: string | null;
  /** Handoff files present in the worktree at phase start, worktree-relative. */
  handoffFiles: string[];
  /** Phases whose envelope was already in effect when this phase began. */
  envelopePhases: string[];
  /**
   * The envelope row id behind each of those phases, keyed by phase name.
   *
   * A phase re-entered through `feedbackTo` leaves several envelope rows on one
   * `phase_id`, so the phase name alone cannot say which envelope a generation
   * ran against. Absent for a phase whose row could not be resolved.
   */
  envelopeIds: Record<string, string>;
  files: PhaseCheckpointFile[];
  /**
   * True when the record cannot reproduce phase start: a path's content is
   * missing, or the dirty set itself could not be fully enumerated.
   */
  truncated: boolean;
  /** Paths whose content was not stored, in capture order. */
  omittedPaths: string[];
  /** Bytes of phase-start content actually kept. */
  bytesStored: number;
}

/**
 * A checkpoint's index row. One per phase attempt: a re-entry is a new
 * generation and never overwrites or removes an earlier one.
 */
export interface PhaseCheckpointRow {
  checkpointId: string;
  runId: string;
  phaseId: string;
  phaseName: string;
  phaseKind: PhaseKind;
  /** 1 for the first attempt at this phase, incremented on every re-entry. */
  generation: number;
  headSha: string;
  model: string | null;
  agent: string | null;
  agentSessionId: string | null;
  leafMessageId: string | null;
  fileCount: number;
  untrackedCount: number;
  bytesStored: number;
  truncated: boolean;
  /** False once the payload file is gone, e.g. the run directory was pruned. */
  payloadPresent: boolean;
  /**
   * False when the payload cannot reproduce phase-start byte for byte, so a
   * restore has to refuse rather than claim an exactness it does not have.
   */
  exactRestorePossible: boolean;
  /** Payload location, relative to the run directory. */
  payloadPath: string;
  changeId: number;
  createdAt: string;
}

/**
 * Why a restore was refused. One reason per cause: an operator told "restore
 * failed" learns nothing, and a caller that cannot distinguish "the worktree
 * is gone" from "the record is truncated" cannot offer the right next step.
 */
export type RestoreRefusal =
  | 'run_not_found'
  | 'run_running'
  | 'run_not_terminal'
  | 'run_merged'
  | 'worktree_missing'
  | 'no_checkpoints'
  | 'checkpoint_not_found'
  | 'checkpoint_payload_missing'
  | 'checkpoint_head_missing'
  | 'checkpoint_commit_missing'
  | 'partial_not_accepted'
  | 'branch_mismatch'
  | 'reset_failed';

/**
 * The refusal in the operator's words, shared so every surface says the same
 * thing. A caller may append specifics (which paths, which commits); it must
 * not restate the reason in its own words.
 */
export const RESTORE_REFUSAL_COPY: Record<RestoreRefusal, string> = {
  run_not_found: 'this run is no longer in the trace',
  run_running: 'this run is still running — stop it before restoring a checkpoint',
  run_not_terminal: 'only a killed, failed, or rejected run can be restored',
  run_merged: 'a merged run cannot be restored',
  worktree_missing: 'this run’s worktree is gone, so there is nowhere to restore into',
  no_checkpoints: 'this run recorded no phase checkpoints, so there is nothing to restore to',
  checkpoint_not_found: 'that checkpoint is not one this run recorded',
  checkpoint_payload_missing: 'that checkpoint’s recorded contents are no longer on disk',
  checkpoint_head_missing: 'that checkpoint never recorded the commit its phase started from',
  checkpoint_commit_missing:
    'the commit that checkpoint started from no longer exists in this worktree',
  partial_not_accepted:
    'an exact restore is impossible here, so a partial restore has to be accepted explicitly',
  branch_mismatch:
    'this run’s worktree is no longer on its own branch, so a reset would move another ref',
  reset_failed: 'git refused to move the run branch back to the checkpoint’s commit',
};

/**
 * One checkpoint as a restore target, labelled for a picker.
 *
 * `exactRestorePossible` and `restorable` are deliberately separate: a
 * truncated record can still put most of the tree back, which is a choice for
 * the operator to accept rather than one this layer makes for them.
 */
export interface RestorableCheckpoint {
  checkpointId: string;
  runId: string;
  phaseId: string;
  phaseName: string;
  phaseKind: PhaseKind;
  /** 1 for the first attempt at this phase; a re-entry is a later generation. */
  generation: number;
  createdAt: string;
  headSha: string;
  model: string | null;
  agent: string | null;
  fileCount: number;
  untrackedCount: number;
  bytesStored: number;
  /** False when nothing can be put back at all, exactly or partially. */
  restorable: boolean;
  /** True when the record reproduces phase start byte for byte. */
  exactRestorePossible: boolean;
  /** Why an exact restore is impossible. Absent exactly when it is possible. */
  blocker?: RestoreRefusal;
  /** Paths whose phase-start content was never stored, so drift is only detectable. */
  omittedPaths: string[];
  /** Commits the run branch has taken since; a restore moves them off the branch. */
  commitsSince: number;
  /** Abbreviated shas a restore would move off, newest first, capped. */
  commitsSinceShas: string[];
}

/**
 * Every checkpoint a run recorded, plus whether the run itself may be
 * restored. The two are separate answers: a merged run's checkpoints are still
 * readable history, and saying so is more useful than an empty list.
 */
export interface RestorableCheckpointList {
  runId: string;
  /** Null when the run is eligible; otherwise why it is not. */
  refusal: RestoreRefusal | null;
  /** The refusal in the operator's words, or an empty string when eligible. */
  detail: string;
  checkpoints: RestorableCheckpoint[];
}

export interface RestoreRunInput {
  runId: string;
  checkpointId: string;
  /**
   * Explicit acceptance of a restore that cannot be exact. A truncated
   * checkpoint is refused without it: a caller that did not ask for a partial
   * restore must not be handed one.
   */
  acceptPartial?: boolean;
}

/**
 * An agent whose runtime session pointer a restore dropped, and the
 * conversation it stepped away from.
 *
 * A restore moves the tree out from under every session the run holds, so it
 * is never only the restored phase's own agent: a later phase's hung
 * conversation would otherwise be reopened by the next Continue, which is the
 * exact thing the operator restored to escape.
 */
export interface RestoredAgentSession {
  agent: string;
  /** The abandoned conversation. Kept as evidence, never deleted. */
  previousSessionId: string | null;
}

/** What a completed restore did, in terms an operator can verify against git. */
export interface RestoreRecord {
  checkpointId: string;
  phaseId: string;
  phaseName: string;
  generation: number;
  /** Where the run branch stood before the restore moved it. */
  previousHeadSha: string;
  /** The commit the phase started from, now the branch tip again. */
  headSha: string;
  /**
   * Commits the restore moved off the branch, newest first. They stay
   * reachable through the branch's reflog; nothing here deletes a commit.
   *
   * Capped, so it can be shorter than `droppedCommitCount`. A confirmation
   * counts with the number and quotes with the list.
   */
  droppedCommits: string[];
  /** How many commits the restore moved off, uncapped. */
  droppedCommitCount: number;
  /** Files written back to their phase-start bytes. */
  filesRestored: number;
  /** Paths removed because phase start did not have them. */
  filesRemoved: number;
  /** Paths whose phase-start content was never recorded or could not be written. */
  omittedPaths: string[];
  /** True when the tree is close rather than identical, whether or not a path is named. */
  partial: boolean;
  /**
   * False when the drift to revert could not be listed in full, so paths phase
   * start did not have may still stand and cannot be named.
   */
  driftEnumerated: boolean;
  /**
   * Every agent whose session pointer this restore dropped, so the next
   * Continue opens a new conversation for each rather than reopening one the
   * restored tree no longer matches.
   */
  freshSessions: RestoredAgentSession[];
  /** The run status this restore was performed from. */
  fromStatus: RunStatus;
}

export interface RestoreResult {
  ok: boolean;
  /** One sentence for the operator, refusal or confirmation alike. */
  detail: string;
  /** Present exactly when `ok` is false. */
  refusal?: RestoreRefusal;
  /**
   * Present whenever the worktree was moved: always on success, and also on
   * the one refusal that can happen after the reset — a partial apply the
   * caller did not accept. A refusal that carries a record is a report of what
   * did happen, not a claim that it succeeded.
   */
  restored?: RestoreRecord;
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

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
  /** Per-million-token prices reported by the active model catalog. */
  cost?: ModelCost;
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

export interface StartRunInput {
  projectId: string;
  pipelineId: string;
  request: string;
  /** An orchestrated run's confirmed plan. When present, `pipelineId` is ignored. */
  plan?: GeneratedRunPlan;
}

// ── Orchestrator (generated run plans) ───────────────────────────────────────

/** What the Orchestrator hands back for confirmation. */
export interface GeneratedRunPlan {
  planId: string;
  projectId: string;
  /** The operator's raw prompt, kept verbatim for the trace. */
  prompt: string;
  /** The Orchestrator's rewritten full brief; becomes the run `request`. */
  refinedRequest: string;
  /** Why the pipeline has this shape, operator-facing. */
  rationale: string;
  /** `id: generated-<planId>`, never builtin. */
  pipeline: PipelineDef;
  /** Synthesized agents referenced by the pipeline but absent from the roster. */
  agents: AgentDef[];
  /** Non-blocking warnings from validation/preflight, shown on the card. */
  warnings: ValidationIssue[];
  model: string;
  reasoningEffort: ReasoningEffort;
}

/** One mid-run amendment: replaces the not-yet-run tail of the pipeline. */
export interface PipelineAmendment {
  reason: string;
  /**
   * Phases replacing everything after the failed phase. May insert repair
   * phases, re-order, or extend; completed phases are immutable history.
   */
  phases: PhaseDef[];
  /** Additional synthesized agents the new phases need. */
  agents: AgentDef[];
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

// ── Smith artifacts (agent-callable rich chat cards) ─────────────────────────

/**
 * The artifact kinds Smith may present. A finite union on purpose: Smith
 * selects a kind and supplies typed data; the renderer owns layout, copy,
 * icons, and actions. Adding a kind means a shared type here, validation in
 * `main/smith/present-tools.ts`, a renderer registration in
 * `renderer/view-models/smith-artifact-view.ts`, and tests for both.
 */
export type SmithArtifactKind =
  | 'pipeline_design'
  | 'agent_design'
  | 'envelope_design'
  | 'checklist'
  | 'run_summary'
  | 'entity_comparison'
  | 'change_receipt'
  | 'project_card'
  | 'pr_card'
  | 'settings_diff'
  | 'diagnostics'
  | 'data_table'
  | 'evidence_disclosure'
  | 'readiness_journey'
  | 'provider_status'
  | 'action_receipt';

/**
 * The kinds `smith_present` may emit. `action_receipt` is deliberately absent:
 * a receipt is evidence an action ran, so it is minted by main from the real
 * executor result and never by the model.
 */
export type SmithPresentableArtifactKind = Exclude<SmithArtifactKind, 'action_receipt'>;

/** The protocol version this build reads. Unknown versions fail soft in the UI. */
export const SMITH_ARTIFACT_VERSION = 1;

interface SmithArtifactBase {
  id: string;
  /** Bumped when a kind's data contract changes shape incompatibly. */
  version: number;
  createdAt: number;
  /** The presenting conversation's scope. Absent means the global chat. */
  projectId?: string;
  /** Smith's design rationale/tradeoffs — the one thing prose adds to a card. */
  rationale?: string;
  /** Store-validation warnings that rode along; errors never become artifacts. */
  warnings: ValidationIssue[];
}

/** A read-only pipeline design, rendered as ordered phase cards — never JSON. */
export interface SmithPipelineDesignArtifact extends SmithArtifactBase {
  kind: 'pipeline_design';
  pipeline: PipelineDef;
}

/** A read-only agent design: identity, model, boundary, envelope, prompts. */
export interface SmithAgentDesignArtifact extends SmithArtifactBase {
  kind: 'agent_design';
  agent: AgentDef;
}

export interface EnvelopeUsageAgent {
  name: string;
  role?: string;
}

export interface EnvelopeUsagePhase {
  pipelineId: string;
  pipelineName?: string;
  phaseName: string;
}

export interface EnvelopeUsageDef {
  agents?: (string | EnvelopeUsageAgent)[];
  pipelines?: string[];
  phases?: EnvelopeUsagePhase[];
}

/** A read-only envelope design: base fields plus custom typed fields, usage, and sample output. */
export interface SmithEnvelopeDesignArtifact extends SmithArtifactBase {
  kind: 'envelope_design';
  envelope: EnvelopeDef;
  usage?: EnvelopeUsageDef;
  sampleOutput?: Record<string, unknown>;
}

export type ChecklistItemStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface ChecklistItem {
  id?: string;
  label: string;
  status: ChecklistItemStatus;
  detail?: string;
  /** Expandable evidence, output excerpt, or diagnostics shown behind a disclosure. */
  evidence?: string;
  /** Suggested fix or remediation guidance note. */
  fix?: string;
}

export interface ChecklistDef {
  title: string;
  summary?: string;
  items: ChecklistItem[];
}

/** A read-only checklist report: readiness findings, doctor results, validation, project health. */
export interface SmithChecklistArtifact extends SmithArtifactBase {
  kind: 'checklist';
  checklist: ChecklistDef;
}

/** A lightweight snapshot of one phase in a run's mini waterfall. */
export interface SmithRunSummaryPhase {
  phaseId?: string;
  name: string;
  kind: PhaseKind;
  status: PhaseStatus;
  owner?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  durationMs?: number;
  error?: string | null;
  envelopeSummary?: string | null;
}

/** A read-only snapshot of run progress and outcome: pipeline, phases, duration, outcome. */
export interface SmithRunSummaryArtifact extends SmithArtifactBase {
  kind: 'run_summary';
  runId: string;
  pipelineId: string;
  pipelineName: string;
  request: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string | null;
  durationMs?: number;
  totalTokens?: number;
  isolation?: boolean;
  worktreePath?: string | null;
  branch?: string | null;
  baseRef?: string | null;
  outcomeDetail?: string | null;
  activePhase?: string | null;
  failedPhase?: string | null;
  phases: SmithRunSummaryPhase[];
  prNumber?: number | null;
  prUrl?: string | null;
  issueNumber?: number | null;
  issueUrl?: string | null;
  live?: boolean;
}

export type EntityComparisonKind = 'agent' | 'pipeline' | 'envelope';

/** A read-only semantic comparison between a stored entity and a proposed edit. */
export interface SmithEntityComparisonArtifact extends SmithArtifactBase {
  kind: 'entity_comparison';
  entityKind: EntityComparisonKind;
  name: string;
  /** The current stored definition captured from main at present time. */
  before: AgentDef | PipelineDef | EnvelopeDef;
  /** The proposed definition validated against store rails. */
  after: AgentDef | PipelineDef | EnvelopeDef;
  /** Entity store target when it differs from the presenting conversation scope. */
  targetProjectId?: string;
}

export type ChangeReceiptTarget = 'direct_checkout' | 'isolated_worktree';
export type ChangeReceiptStatus = 'success' | 'failure';

export interface ChangeReceiptCommand {
  command: string;
  exitCode: number | null;
  durationMs?: number;
  passed: boolean;
  timedOut?: boolean;
}

export interface ChangeReceiptDef {
  title?: string;
  target: ChangeReceiptTarget;
  status: ChangeReceiptStatus;
  summary?: string;
  filesChanged?: string[];
  diffstat?: string;
  command?: ChangeReceiptCommand;
  /** Bounded command output or diff excerpt shown behind a disclosure. Capped in main. */
  outputExcerpt?: string;
}

/** A read-only durable receipt for direct checkout edits or command runs. */
export interface SmithChangeReceiptArtifact extends SmithArtifactBase {
  kind: 'change_receipt';
  receipt: ChangeReceiptDef;
}

export interface ProjectCardGithub {
  available: boolean;
  repo?: string;
  detail?: string;
  defaultBranch?: string;
}

export interface ProjectCardDivergence {
  ahead: number;
  behind: number;
  state: BaseSyncState;
  detail?: string;
}

export interface ProjectCardScopes {
  roster: boolean;
  pipelines: boolean;
}

export interface ProjectCardHealth {
  ok: boolean;
  summary?: string;
  failedCount?: number;
  totalCount?: number;
  issues?: string[];
}

export interface ProjectCardDef {
  id?: string;
  name?: string;
  path: string;
  baseRef: string;
  title?: string;
  summary?: string;
  isGit?: boolean;
  github?: ProjectCardGithub;
  commands?: ProjectCommand[];
  setupScript?: string;
  readinessValidated?: boolean;
  readinessSkipped?: boolean;
  scaffold?: boolean;
  divergence?: ProjectCardDivergence;
  scopes?: ProjectCardScopes;
  health?: ProjectCardHealth;
  contextSummary?: string;
}

/** A read-only project card: path, base ref, git/github state, commands, divergence, scopes, health. */
export interface SmithProjectCardArtifact extends SmithArtifactBase {
  kind: 'project_card';
  project: ProjectCardDef;
}

export interface PrCardAction {
  operation: 'create' | 'merge' | 'fix_conflicts';
  status: 'success' | 'failure';
  detail?: string;
}

export interface PrCardDef {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  baseRefName?: string;
  body?: string;
  author?: string;
  isDraft?: boolean;
  checks?: PrChecks;
  mergeable?: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision?: string;
  additions?: number;
  deletions?: number;
  createdAt?: string;
  action?: PrCardAction;
}

/** A read-only PR preview/card: number, title, branches, checks, merge/conflict state, external link. */
export interface SmithPrCardArtifact extends SmithArtifactBase {
  kind: 'pr_card';
  pr: PrCardDef;
}

export interface SettingsDiffChange {
  key: string;
  label: string;
  previous?: unknown;
  next?: unknown;
  scope?: string;
}

export interface SettingsDiffSection {
  section: string;
  label?: string;
  scope?: string;
  changes: SettingsDiffChange[];
}

export interface SettingsDiffDef {
  title?: string;
  summary?: string;
  scope?: 'global' | 'project' | string;
  targetProjectId?: string;
  sections: SettingsDiffSection[];
  openSettingsTarget?: {
    pane?: string;
    section?: string;
  };
}

/** A read-only settings diff: human labels and old/new values grouped by section/scope. */
export interface SmithSettingsDiffArtifact extends SmithArtifactBase {
  kind: 'settings_diff';
  diff: SettingsDiffDef;
}

export interface DiagnosticsDef {
  title?: string;
  summary?: string;
  category?: 'doctor' | 'orphans' | 'maintenance' | 'update' | 'lifecycle' | 'general';
  doctor?: DoctorCheck[];
  orphans?: OrphanWorktree[];
  maintenance?: MaintenanceReport;
  update?: UpdateStatus;
  lifecycleWarning?: string;
  items?: ChecklistItem[];
}

/** A read-only diagnostics/maintenance/update card: doctor checks, orphan worktrees, update status, lifecycle warnings. */
export interface SmithDiagnosticsArtifact extends SmithArtifactBase {
  kind: 'diagnostics';
  diagnostics: DiagnosticsDef;
}

export type DataTableCatalogKind =
  | 'runs'
  | 'projects'
  | 'agents'
  | 'pipelines'
  | 'envelopes'
  | 'prs'
  | 'doctor'
  | 'models'
  | 'custom';

export type TableColumnType = 'text' | 'number' | 'status' | 'badge' | 'date' | 'code' | 'boolean';

export interface TableColumnDef {
  key: string;
  label: string;
  type?: TableColumnType;
  width?: string;
  align?: 'left' | 'center' | 'right';
}

export type TableCellStatusVariant =
  'pass' | 'warn' | 'fail' | 'info' | 'neutral' | 'active' | 'muted';

export interface TableCellStatus {
  variant: TableCellStatusVariant;
  label: string;
}

export type TableCellValue = string | number | boolean | TableCellStatus | null | undefined;

export interface TableRowDef {
  id: string;
  cells: Record<string, TableCellValue>;
  navTarget?: {
    view?: 'runs' | 'inspector' | 'design' | 'prs' | 'settings' | 'smith';
    targetId?: string;
    tab?: 'pipelines' | 'agents' | 'envelopes';
  };
  disabled?: boolean;
}

export interface DataTableEmptyState {
  message: string;
  subtext?: string;
}

export interface DataTableDef {
  title: string;
  catalogKind?: DataTableCatalogKind;
  summary?: string;
  columns: TableColumnDef[];
  rows: TableRowDef[];
  emptyState?: DataTableEmptyState;
  totalCount?: number;
}

/** A read-only bounded data catalog table with typed columns, status chips, empty state, and safe navigation. */
export interface SmithDataTableArtifact extends SmithArtifactBase {
  kind: 'data_table';
  table: DataTableDef;
}

export interface ContextOccupancyDef {
  usedTokens?: number;
  maxTokens?: number;
  percent?: number;
  model?: string;
  compactionThreshold?: number;
}

export type EvidenceItemKind =
  'prompt' | 'command_output' | 'event_tail' | 'excerpt' | 'diff' | 'json' | 'log';

export interface EvidenceItemDef {
  id?: string;
  label: string;
  kind: EvidenceItemKind;
  /** Bounded excerpt or text content. Capped in main. */
  content: string;
  language?: string;
  truncated?: boolean;
  totalLines?: number;
  durationMs?: number;
  exitCode?: number | null;
}

export interface EvidenceDisclosureDef {
  title: string;
  summary?: string;
  runId?: string;
  phaseName?: string;
  occupancy?: ContextOccupancyDef;
  phasePrompt?: {
    systemPrompt?: string;
    userPrompt?: string;
    inputs?: Record<string, string>;
  };
  items: EvidenceItemDef[];
}

/** A read-only context and evidence disclosure: context occupancy meter, phase prompt, capped excerpts. */
export interface SmithEvidenceDisclosureArtifact extends SmithArtifactBase {
  kind: 'evidence_disclosure';
  evidence: EvidenceDisclosureDef;
}

/**
 * The marker as committed on the base ref — the only readiness truth. A marker
 * in the working tree, or a merged PR on its own, proves nothing.
 */
export interface ReadinessJourneyMarker {
  valid: boolean;
  detail: string;
  summary?: string;
  /** Which tree answered: the base ref, or the working checkout as a fallback. */
  source?: 'base-ref' | 'worktree';
  ref?: string;
  commit?: string;
  generatedAt?: string;
}

/** One criterion row, grouped by status in the card. */
export interface ReadinessJourneyCriterion {
  id: string;
  status: ReadinessCriterionStatus;
  notes?: string;
}

/** One live sub-agent transcript row from the remediation session. */
export interface ReadinessJourneyWorkEntry {
  id: string;
  kind: 'text' | 'tool' | 'note' | 'error';
  text: string;
  toolKind?: TranscriptToolKind;
  done?: boolean;
  failed?: boolean;
}

/** The readiness PR and whether it merged. Merging alone is not readiness. */
export interface ReadinessJourneyPr {
  number: number;
  url: string;
  merged: boolean;
  mergeDetail?: string;
}

/**
 * The whole readiness journey in one card: what the authoritative marker says,
 * which criteria group where, what phase remediation reached, the live
 * sub-agent work, PR/merge status, and the `needs_continue` affordances.
 */
export interface ReadinessJourneyDef {
  projectId?: string;
  projectName?: string;
  phase: ReadinessPhase;
  detail?: string;
  marker: ReadinessJourneyMarker;
  criteria: ReadinessJourneyCriterion[];
  stack?: AgentReadyStack;
  /** The remediation checklist summary — an explanation, not the verdict. */
  checklistSummary?: string;
  work?: ReadinessJourneyWorkEntry[];
  pr?: ReadinessJourneyPr;
  /**
   * What the operator can do next, named in the words the readiness flow uses
   * (`Continue`, `Start over`, `Skip`). Labels only: the artifact performs no
   * action, and every one of these routes through `readiness_manage` approval.
   */
  actions?: string[];
}

/** A read-only readiness-journey card: marker, criteria, remediation, PR. */
export interface SmithReadinessJourneyArtifact extends SmithArtifactBase {
  kind: 'readiness_journey';
  journey: ReadinessJourneyDef;
}

export type ProviderStatusConnection = 'connected' | 'authenticating' | 'disconnected' | 'error';

/**
 * One provider row: connection, auth, and whether a direct key exists.
 *
 * Deliberately metadata only. `keyPresent` says a key exists so the card can
 * offer to replace or clear it; the value, a masked prefix, or anything else
 * that narrows it never enters an artifact — a key belongs only in the masked
 * approval card, which is not persisted with the chat.
 */
export interface ProviderStatusEntry {
  id: string;
  label: string;
  connection: ProviderStatusConnection;
  authenticated: boolean;
  /** True when pi holds a direct API key for this provider. Never its value. */
  keyPresent?: boolean;
  /** Accounts as metadata: label, expiry, disabled. Never a token. */
  accounts?: { label: string; expired?: boolean; disabled?: boolean; expiresAt?: string }[];
  loginInFlight?: boolean;
  error?: string;
}

/** The Bridge as the card reports it: serving, or why it is not. */
export interface ProviderStatusBridge {
  running: boolean;
  port?: number;
  baseUrl?: string;
  reason?: string;
  detail?: string;
}

/**
 * Companion status as the card reports it: whether the host serves, on what
 * origin, and which devices are paired.
 *
 * The pairing secret and QR payload are renderer-only private displays. They
 * are absent from this type by construction, so a Companion card cannot leak
 * one into an artifact, the transcript, or persisted chat state.
 */
export interface ProviderStatusCompanion {
  running: boolean;
  origin?: string;
  protocolVersion?: number;
  detail?: string;
  devices?: { deviceId: string; name: string; pairedAt?: string; lastSeenAt?: string | null }[];
}

export interface ProviderStatusDef {
  title?: string;
  summary?: string;
  providers?: ProviderStatusEntry[];
  bridge?: ProviderStatusBridge;
  companion?: ProviderStatusCompanion;
}

/** A read-only provider / Companion status card. Carries no secret, ever. */
export interface SmithProviderStatusArtifact extends SmithArtifactBase {
  kind: 'provider_status';
  status: ProviderStatusDef;
}

/**
 * Where the thing an action affected can be found afterwards. Identifiers and
 * a URL only: a receipt outlives the session that produced it, so it must not
 * carry a closure, a handle, or anything that goes stale in a way a click
 * could act on. The renderer decides what, if anything, is clickable.
 */
export type SmithReceiptLink =
  | { kind: 'url'; label: string; url: string }
  | { kind: 'run'; label: string; projectId: string; runId: string }
  | { kind: 'entity'; label: string; entity: 'agent' | 'pipeline' | 'envelope'; name: string };

/**
 * What an approved action actually did, recorded by main from the executor's
 * own result. Approval is not success: a refused or failed execution produces
 * a receipt too, carrying the executor's words in `failure`.
 */
export interface SmithActionReceipt {
  /** The fixed operation enum the proposal named, e.g. `pr_create`. */
  operation: string;
  /** The proposal's human title, restated so the card reads without the chat. */
  title: string;
  /** What the action ran against, derived from the approved (redacted) args. */
  target: string;
  /** What approving it was stated to do — the summary the operator read. */
  consequences: string;
  /** The risk class the operator approved, kept as the consequence badge. */
  risk: SmithActionRisk;
  outcome: 'succeeded' | 'failed';
  /** How long the executor ran, in ms. Not the time the card waited for a human. */
  durationMs: number;
  /** The executor's own words. Present only when `outcome` is `failed`. */
  failure?: string;
  /** Where the affected object now lives, as identifiers rather than a handle. */
  link?: SmithReceiptLink;
  /** The redacted args the operator approved, restated as the audit trail. */
  args: Record<string, unknown>;
}

/**
 * Durable evidence that an approved action ran. Unlike the design artifacts it
 * is never model-callable: main mints it from the real executor result on the
 * proposal answer path, so the transcript cannot claim an action Foundry did
 * not perform. `createdAt` is the moment execution settled.
 */
export interface SmithActionReceiptArtifact extends SmithArtifactBase {
  kind: 'action_receipt';
  receipt: SmithActionReceipt;
}

/**
 * One rich inline card in the Smith transcript. Artifacts are presentation
 * only: they perform no writes, never occupy the one-slot proposal queue, and
 * carry no executor, secret, or private payload — validated and size-capped at
 * the main boundary before they reach the renderer or persisted chat state.
 */
export type SmithArtifact =
  | SmithPipelineDesignArtifact
  | SmithAgentDesignArtifact
  | SmithEnvelopeDesignArtifact
  | SmithChecklistArtifact
  | SmithRunSummaryArtifact
  | SmithEntityComparisonArtifact
  | SmithChangeReceiptArtifact
  | SmithProjectCardArtifact
  | SmithPrCardArtifact
  | SmithSettingsDiffArtifact
  | SmithDiagnosticsArtifact
  | SmithDataTableArtifact
  | SmithEvidenceDisclosureArtifact
  | SmithReadinessJourneyArtifact
  | SmithProviderStatusArtifact
  | SmithActionReceiptArtifact;

// ── Smith (the entity-smith's approval gate) ─────────────────────────────────

/**
 * Smith may read freely, but every privileged action is classified and shown
 * to the operator before it runs. These labels are deliberately broad enough
 * for a human risk badge and deliberately not executable channel names.
 */
export type SmithActionRisk =
  | 'write'
  | 'destructive'
  | 'credential'
  | 'shell'
  | 'git'
  | 'external'
  | 'network'
  | 'lifecycle'
  | 'maintenance';

/** A secret field rendered and retained only inside the approval card. */
export interface SmithSecretRequest {
  kind: 'api-key';
  label: string;
  placeholder?: string;
}

/** A result visible only to the renderer, never to Smith or persisted chat. */
export interface SmithPrivateDisplay {
  kind: 'companion-pairing';
  payload: {
    protocolVersion: number;
    origin: string;
    desktopId: string;
    desktopName: string;
    secret: string;
    expiresAt: string;
  };
}

interface SmithProposalBase {
  id: string;
  /** The proposing session's scope. Absent means the global conversation. */
  projectId?: string;
  createdAt: string;
}

/**
 * One entity staged for a human to approve before the store is touched. `spec`
 * is validated entity JSON carried as `unknown` because the card only renders
 * it and the main-process queue owns the executor.
 */
export interface SmithEntityProposal extends SmithProposalBase {
  type: 'entity';
  kind: 'agent' | 'pipeline' | 'envelope';
  mode: 'create' | 'edit';
  /** The entity's identifying name (agents/envelopes) or id (pipelines). */
  name: string;
  /**
   * The current stored definition when this proposal overwrites one, captured
   * by main at propose time so the card can show a real before/after rather
   * than trusting the model's memory of the entity.
   */
  previous?: unknown;
  /** The entity JSON, validated but not yet saved. */
  spec: unknown;
  /** Non-blocking warnings the store surfaced; errors would have refused earlier. */
  validation: ValidationIssue[];
  /** True when a stored entity already carries this name/id — approving overwrites it. */
  overwrites: boolean;
  /** Entity store target when it differs from the proposing conversation scope. */
  targetProjectId?: string;
}

/** A fixed privileged application action awaiting inline approval. */
export interface SmithActionProposal extends SmithProposalBase {
  type: 'action';
  operation: string;
  title: string;
  summary: string;
  /** Human-readable, redacted arguments. Never contains credentials or pairing payloads. */
  args: Record<string, unknown>;
  risk: SmithActionRisk;
  secretRequest?: SmithSecretRequest;
}

export type SmithProposal = SmithEntityProposal | SmithActionProposal;

/**
 * The answer a human gives a proposal card. The card sends no `note`: the next
 * chat message is the revision guidance. `note` survives for the shutdown path,
 * which explains itself to a tool call it is unblocking.
 */
export interface SmithProposalAnswer {
  approved: boolean;
  note?: string;
  /**
   * Accepted only for a proposal declaring `secretRequest`. Main consumes it
   * after IPC receipt and must never echo or persist it.
   */
  secret?: string;
}

/** Structured card result; private displays stay renderer-local. */
export type SmithProposalAnswerResult =
  { ok: true; privateDisplay?: SmithPrivateDisplay } | { ok: false; error: string };

/** Main-only executor outcome. `modelResult` is the sole value returned to Smith. */
export type SmithProposalExecutionResult =
  | { ok: true; modelResult: unknown; privateDisplay?: SmithPrivateDisplay }
  | { ok: false; error: string; retryable?: boolean };

// ── Updater ──────────────────────────────────────────────────────────────────

export type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  stage: UpdateStage;
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
}
