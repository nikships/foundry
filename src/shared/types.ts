/**
 * The one contract both processes import. Main owns the implementations; the
 * renderer only ever sees these shapes across `ipc.ts`.
 */

// ── Pipelines (data, not scripts) ────────────────────────────────────────────

export type PhaseKind = 'agent' | 'code' | 'engineer';
export type PhaseStatus = 'queued' | 'running' | 'success' | 'fail' | 'skipped';
export type RunStatus = 'running' | 'accepted' | 'rejected' | 'failed' | 'killed';
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type EnvelopeKind =
  'generic' | 'brief' | 'plan' | 'build' | 'scout' | 'review' | 'document' | 'pr';

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
  pr: 'Bounded title and a non-empty markdown pull-request body',
};

/** Hard schema bound for `pr.title`. Style guidance is tighter (≤72). */
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
  /**
   * Narrows the agent's tool surface for this phase only. A phase can subtract
   * from what the agent may reach and never add to it: a `full` phase under a
   * `read-only` agent is still read-only. Absent means the agent's own policy
   * stands.
   */
  toolProfile?: ToolProfile;
  /** Allowlist for a `custom` phase profile, and a narrowing on its own. */
  tools?: string[];
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
  /**
   * How wide this agent's system tool surface is. Absent reads as `full`, so a
   * roster written before profiles existed — and every built-in — behaves
   * exactly as it did. `custom` takes its allowlist from `tools`.
   */
  toolProfile?: ToolProfile;
  /**
   * Which host-installed invocables this agent may reach. Absent or empty means
   * none: a Foundry agent inherits nothing from the operator's `~/.factory`
   * unless it was named here. Selection is per-agent and per-session; the host
   * install is never edited to satisfy it.
   */
  invocables?: AgentInvocables;
  color: string;
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
 * How much of the CLI's own tool surface an agent or a phase may reach.
 *
 * The three named profiles are defined against the categories the CLI reports
 * for its live tool list, not against a list of tool names, so a tool that
 * ships later — or arrives from an MCP server mid-session — is classified
 * rather than missed:
 *
 *  - `full`     — everything the model would have had anyway. The default.
 *  - `read-only`— reading only. No edits, no commands.
 *  - `review`   — reading plus running commands, so a reviewer can execute the
 *                 tests it is judging, but cannot change the tree.
 *  - `custom`   — exactly the ids named in `tools`, and nothing else.
 */
export type ToolProfile = 'full' | 'read-only' | 'review' | 'custom';

/**
 * A tool policy as authored: a profile, plus the allowlist `custom` needs.
 *
 * A phase carries the same shape as an agent, and a phase's policy can only
 * ever narrow the agent's — see `effectiveDisabledToolIds`.
 */
export interface ToolPolicySpec {
  profile?: ToolProfile;
  /** Tool ids for `custom`. Ignored by the other profiles. */
  allow?: string[];
}

/**
 * Per-agent opt-in to host-installed skills, custom Droids, and MCP servers,
 * plus the operator's own Foundry-defined MCP servers.
 *
 * Every list is an allowlist of ids, and the default for all four is empty —
 * the whole point of the type is that a new agent starts with nothing. The
 * lists name inventory ids, not paths: what an id resolves to is main's
 * business (see `readHostInvocables`), so a moved install does not rewrite a
 * roster.
 */
export interface AgentInvocables {
  /** Host skill ids (the directory name under `~/.factory/skills`). */
  skills: string[];
  /** Host custom Droid ids (the file stem under `~/.factory/droids`). */
  droids: string[];
  /** Server names from the host's own `~/.factory/mcp.json`. */
  hostMcpServers: string[];
  /** `UserMcpServer.id`s from `AppSettings.mcpServers`. */
  userMcpServers: string[];
}

/** One host-installed skill, as read off disk for the roster picker. */
export interface HostSkillInfo {
  id: string;
  name: string;
  description: string;
  /** Absolute path to the skill directory, shown so an operator can audit it. */
  location: string;
}

/** One host-installed custom Droid. */
export interface HostDroidInfo {
  id: string;
  name: string;
  description: string;
  location: string;
}

/** One MCP server defined in the host's `~/.factory/mcp.json`. */
export interface HostMcpServerInfo {
  /** The key under `mcpServers`, which is also the server name on the wire. */
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  /** `command` for stdio, `url` for http/sse — for display only. */
  detail: string;
  /** True when the host file marks it disabled; it is never offered as enabled. */
  disabled: boolean;
}

/**
 * Everything the operator has installed on the host, read-only. Foundry offers
 * these for per-agent selection and never creates, edits, or deletes them.
 */
export interface HostInvocableInventory {
  skills: HostSkillInfo[];
  droids: HostDroidInfo[];
  mcpServers: HostMcpServerInfo[];
  /** Absolute path of the host config dir the inventory was read from. */
  factoryDir: string;
  /** Present when a part of the inventory could not be read. */
  warnings: string[];
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

export type UserMcpServer =
  | {
      id: string;
      name: string;
      disabled: boolean;
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { id: string; name: string; disabled: boolean; type: 'http'; url: string }
  | { id: string; name: string; disabled: boolean; type: 'sse'; url: string };

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
  /**
   * Roster name used when a pipeline (or later UI) needs a PR writer.
   * Defaults to the shipped `pr_writer` builtin.
   */
  prAgent: string;
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
  /** Which terminal emulator "Open in terminal" hands a directory to. */
  terminalApp: TerminalAppId;
  appearance: 'system' | 'dark';
  retentionDays: number | null;
  onboarded: boolean;
  mcpServers: UserMcpServer[];
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
}

/** Terminal.app first: it is the only one guaranteed to be installed. */
export const TERMINAL_APPS: readonly TerminalAppInfo[] = [
  { id: 'terminal', label: 'Terminal', appName: 'Terminal' },
  { id: 'iterm', label: 'iTerm2', appName: 'iTerm' },
  { id: 'ghostty', label: 'Ghostty', appName: 'Ghostty' },
  { id: 'warp', label: 'Warp', appName: 'Warp' },
  { id: 'alacritty', label: 'Alacritty', appName: 'Alacritty' },
  { id: 'kitty', label: 'kitty', appName: 'kitty' },
] as const;

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
  /** The project the session would scope to; null means no project is selected. */
  project: { id: string; name: string; path: string; exists: boolean } | null;
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
