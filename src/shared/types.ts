/**
 * The one contract both processes import. Main owns the implementations; the
 * renderer only ever sees these shapes across `ipc.ts`.
 */

// ── Pipelines (data, not scripts) ────────────────────────────────────────────

export type PhaseKind = 'agent' | 'code' | 'engineer';
export type PhaseStatus = 'queued' | 'running' | 'success' | 'fail' | 'skipped';
export type RunStatus = 'running' | 'accepted' | 'rejected' | 'failed' | 'killed';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type EnvelopeKind = 'generic' | 'brief' | 'plan' | 'build' | 'scout' | 'review' | 'document';

/** The seven built-in envelope kinds. Custom envelopes are named strings outside this set. */
export const BUILTIN_ENVELOPE_KINDS: readonly EnvelopeKind[] = [
  'generic',
  'brief',
  'plan',
  'build',
  'scout',
  'review',
  'document',
] as const;

/** One-line blurbs for picker UIs. Keep in sync with `engine/envelopes.ts` schemas. */
export const BUILTIN_ENVELOPE_BLURBS: Record<EnvelopeKind, string> = {
  generic: 'Base reply: status, summary, artifacts, notes',
  brief: 'Rewritten request with constraints and acceptance criteria',
  plan: 'Approach plus a commit message for the next step',
  build: 'Changed files and the commit message for the work',
  scout: 'Findings from reading the repo, one per entry',
  review: 'Approve or block, with per-requirement findings',
  document: 'Path of the doc written and the files it covers',
};

/**
 * Which agent CLI drives a phase.
 */
export type CliVendor = 'droid';

export const CLI_VENDOR_IDS: CliVendor[] = ['droid'];

/**
 * What the renderer is allowed to know about a CLI. The adapter itself stays in
 * the main process, because it holds functions and argv, neither of which
 * survives the structured-clone bridge.
 */
export interface CliDescriptor {
  id: CliVendor;
  label: string;
  binary: string;
  docsUrl: string;
  authEnvVars: string[];
  /** True only for droid, the one vendor with mid-turn tool visibility. */
  supportsRpc: boolean;
  /** What this CLI cannot do that droid can, shown next to the picker. */
  caveats: string[];
}

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
  /** Prompt template id resolved from the agent record. */
  template: string;
  /** Declared inputs: `request`, `envelope:<phase>`, `handoff_files`, `feedback`. */
  inputs: string[];
}

export interface PhaseDef {
  name: string;
  kind: PhaseKind;
  /** A phase name identifies; a description explains. Both are required. */
  description: string;
  agent?: string;
  /** Built-in EnvelopeKind or a custom envelope name from the shared library. */
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
  /** Absent on rosters written before multi-CLI support; read as `droid`. */
  cli?: CliVendor;
  model: string;
  reasoningEffort: ReasoningEffort;
  systemPrompt: string;
  userPrompt: string;
  writes: WriteBoundary;
  /** Built-in EnvelopeKind or a custom envelope name from the shared library. */
  envelope: string;
  customFields?: CustomEnvelopeField[];
  /** Empty = droid's default tool set for that model. */
  tools?: string[];
  disabledTools?: string[];
  color: string;
  emblem?: string;
  builtin?: boolean;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export interface CliConfig {
  /** Absolute path or bare name; resolved once per install by a PATH lookup. */
  path: string;
  /**
   * Flags appended verbatim to every turn for this CLI. The escape hatch for a
   * vendor that grows an option Foundry does not model yet, so an operator is
   * never blocked on a release of this app.
   */
  extraArgs: string[];
}

export interface AppSettings {
  /** One entry per vendor. An agent names the vendor; this says where it lives. */
  clis: Record<CliVendor, CliConfig>;
  /** The vendor a newly created agent starts on. */
  defaultCli: CliVendor;
  /**
   * Which CLI answers "Ask AI to find commands". `default` follows `defaultCli`,
   * so an operator who never opens this setting still gets a working button.
   */
  detectCli: CliVendor | 'default';
  /** Model for detection. `inherit` lets the chosen CLI pick its own. */
  detectModel: string;
  /** Recorded on every run so a trace says who asked for it. */
  engineerName: string;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  pollCadenceMs: number;
  turnTimeoutMs: number;
  envelopeRetries: number;
  gateRetries: number;
  /**
   * How full an agent's context may get before the engine compacts it between
   * phases, as a fraction of the model's window.
   */
  compactionThreshold: number;
  /**
   * After this many failed corrections in a phase, the engine rewinds the SDK
   * session (and restores phase-start files) instead of appending another
   * correction turn. `0` disables rewind entirely.
   */
  rewindAfterCorrections: number;
  /**
   * How droid agent sessions talk to the CLI. `daemon` (default) multiplexes
   * over one app-owned `droid daemon`; `subprocess` forces a ProcessTransport
   * SdkSession per agent. Daemon start/auth failure falls back to subprocess
   * automatically — a run never fails because the daemon did not come up.
   */
  transport: 'daemon' | 'subprocess';
  /**
   * Preferred local port for the app-owned `droid daemon`. Must sit inside
   * 37600–37699; when busy the manager scans up within that band.
   */
  daemonPort: number;
  notifications: { accepted: boolean; rejected: boolean; failed: boolean; needsInput: boolean };
  dockBadge: boolean;
  appearance: 'system' | 'dark';
  retentionDays: number | null;
  onboarded: boolean;
}

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
   * Shell script run at the worktree root via `sh -c` after every
   * `git worktree add`. Installs deps so agents find their binaries.
   * Empty means nothing to run.
   */
  setupScript?: string;
  addedAt: string;
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
  merged: boolean;
  archived: boolean;
  mode: 'daemon' | 'rpc' | 'oneshot';
  startedAt: string;
  endedAt: string | null;
  totalTokens: number;
  totalCost: number;
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
  cli: CliVendor;
  /** The vendor's own session id, whatever it calls one. */
  droidSessionId: string | null;
  mode: 'daemon' | 'rpc' | 'oneshot';
  color: string;
  contextTokens: number;
  contextWindow: number;
  createdAt: string;
  lastUsedAt: string;
}

/**
 * What is actually occupying an agent's context window, as droid accounts for
 * it. The occupancy figures are droid's own estimate and can differ from
 * `AgentSessionRow.contextTokens` by a token or two: they are two reads of a
 * moving number, so a view shows one of them, never a difference between them.
 */
export interface ContextBreakdown {
  modelId: string;
  modelDisplayName: string;
  contextBudget: number;
  usedTokens: number;
  freeTokens: number;
  lastCallCompactionTokens?: number;
  categories: { name: string; tokens: number; colorKey: string }[];
  skills: { name: string; location: string; tokens: number }[];
  mcpServers: { name: string; toolCount: number; tokens: number }[];
  droids: { name: string; location: string; tokens: number }[];
}

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
  credits: number;
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

export interface ToolInfo {
  id: string;
  llmId: string;
  displayName: string;
  description: string;
  category: string;
  defaultAllowed: boolean;
}

export interface DoctorCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /**
   * A failure that stops onboarding. Only the default CLI and git qualify: an
   * uninstalled fourth CLI is a fact about the machine, not a broken setup, and
   * blocking on one would make the app unusable to anyone who wants a subset.
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

// ── Updater ──────────────────────────────────────────────────────────────────

export type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  stage: UpdateStage;
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
}
