/**
 * The one contract both processes import. Main owns the implementations; the
 * renderer only ever sees these shapes across `ipc.ts`.
 */

// ── Pipelines (data, not scripts) ────────────────────────────────────────────

export type PhaseKind = 'agent' | 'code' | 'engineer';
export type PhaseStatus = 'queued' | 'running' | 'success' | 'fail' | 'skipped';
export type RunStatus = 'running' | 'accepted' | 'rejected' | 'failed' | 'killed';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high';
export type AutonomyLevel = 'low' | 'medium' | 'high';
export type EnvelopeKind = 'generic' | 'plan' | 'build' | 'scout' | 'review' | 'document';

/**
 * Which agent CLI drives a phase. Chosen per agent, so one pipeline can plan on
 * one vendor and build on another.
 */
export type CliVendor = 'droid' | 'claude' | 'codex' | 'junie' | 'grok';

export const CLI_VENDOR_IDS: CliVendor[] = ['droid', 'claude', 'codex', 'junie', 'grok'];

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
  envelope?: EnvelopeKind;
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
}

// ── Roster ───────────────────────────────────────────────────────────────────

export interface CustomEnvelopeField {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  required: boolean;
  description?: string;
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
  envelope: EnvelopeKind;
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
  defaultAutonomy: AutonomyLevel;
  defaultModel: string;
  defaultReasoningEffort: ReasoningEffort;
  pollCadenceMs: number;
  turnTimeoutMs: number;
  envelopeRetries: number;
  gateRetries: number;
  notifications: { accepted: boolean; rejected: boolean; failed: boolean; needsInput: boolean };
  dockBadge: boolean;
  appearance: 'system' | 'dark';
  retentionDays: number | null;
  onboarded: boolean;
  /** Visual brand. Prism is the default; both packs ship in `assets/brands/*`. */
  brand: BrandId;
}

export type BrandId = 'prism' | 'murmur';
export const BRAND_IDS: BrandId[] = ['prism', 'murmur'];
export const BRAND_LABELS: Record<BrandId, string> = { prism: 'Prism', murmur: 'Murmur' };

export type MergePolicy = 'auto' | 'ask' | 'never';

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
  /** Per-project allowlist of commands auto-approved for droid's ask_user. */
  allowedCommands: string[];
  ownRoster: boolean;
  ownPipelines: boolean;
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
  merged: boolean;
  archived: boolean;
  mode: 'rpc' | 'oneshot';
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
  mode: 'rpc' | 'oneshot';
  color: string;
  contextTokens: number;
  contextWindow: number;
  createdAt: string;
  lastUsedAt: string;
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

export interface PendingInterrupt {
  interruptId: string;
  runId: string;
  phaseId: string | null;
  kind: 'engineer' | 'permission';
  title: string;
  body: string;
  /** Engineer phases accept edited text; permission asks are yes/no + remember. */
  options: { id: string; label: string; kind: 'approve' | 'reject' | 'edit' }[];
  command?: string;
  createdAt: string;
}

export interface InterruptAnswer {
  interruptId: string;
  decision: 'approve' | 'reject';
  text?: string;
  remember?: boolean;
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

// ── Updater ──────────────────────────────────────────────────────────────────

export type UpdateStage = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdateStatus {
  stage: UpdateStage;
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
}
