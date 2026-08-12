/**
 * The IPC channel names and their payload types, imported by both sides so a
 * renaming cannot silently break a call. The renderer never touches disk, git,
 * or droid: everything it can do is in this list.
 */

import type {
  AgentDef,
  AgentSessionRow,
  AppSettings,
  CliDescriptor,
  CliVendor,
  ContextBreakdown,
  DoctorCheck,
  DryRunPrompt,
  EnvelopeDef,
  EnvelopeRow,
  EventRow,
  GateResultRow,
  GhStatus,
  GithubAccount,
  HostInvocableInventory,
  InterruptAnswer,
  MaintenanceReport,
  ModelInfo,
  OrphanWorktree,
  PendingInterrupt,
  PhaseRow,
  PipelineDef,
  PrMergeMethod,
  ProjectDef,
  PullRequest,
  RunRow,
  SmithLaunchInfo,
  SmithProposal,
  SmithProposalAnswer,
  StartRunInput,
  ToolInfo,
  UpdateStatus,
  ValidationIssue,
} from './types.js';

export interface SaveResult<T> {
  ok: boolean;
  issues: ValidationIssue[];
  value?: T;
}

/**
 * Renaming a shipped agent forks rather than renames: the roster restores any
 * absent built-in on read, so an in-place rename would resurrect the old name
 * on the next launch. `forked` tells the caller which of the two happened.
 */
export interface RenameResult {
  ok: boolean;
  issues: ValidationIssue[];
  agents?: AgentDef[];
  forked?: boolean;
}

export interface RunDetail {
  run: RunRow | null;
  phases: PhaseRow[];
  envelopes: EnvelopeRow[];
  gates: GateResultRow[];
  sessions: AgentSessionRow[];
  live: boolean;
}

export interface EventPage {
  events: EventRow[];
  /** Walks EventRow.changeId, so updated rows are re-served, not just new ones. */
  cursor: number;
}

/**
 * Why an agent has no context breakdown to show. A breakdown comes off the
 * agent's own session, so absence is normal in specific ways — the reason
 * travels rather than the copy, so the renderer says it in its own words
 * instead of expanding onto an empty panel.
 */
export type ContextBreakdownReason =
  'not_live' | 'not_started' | 'no_session_context' | 'unanswered';

export interface ContextBreakdownResult {
  breakdown: ContextBreakdown | null;
  /** Absent exactly when `breakdown` is present. */
  reason?: ContextBreakdownReason;
  /** Read from the live session rather than the snapshot a turn left behind. */
  live?: boolean;
  /** When that snapshot was taken. Absent for a live read. */
  capturedAt?: string;
}

export interface TryCommandResult {
  exitCode: number | null;
  passed: boolean;
  outputTail: string;
  durationMs: number;
}

/**
 * A detected command is a proposal, never a write. `verified` carries the
 * result of actually running it, so the human confirms evidence rather than a
 * guess.
 */
export interface DetectedCommand {
  name: string;
  argv: string[];
  source: string;
  verified: boolean;
  exitCode: number | null;
  outputTail: string;
  durationMs: number;
}

export interface DetectCommandsResult {
  commands: DetectedCommand[];
  /** Which path answered, so the UI can say why nothing came back. */
  via: 'manifest' | 'agent' | 'none';
  detail: string;
}

/** One line of an agent detection's live transcript. */
export interface DetectionEntry {
  id: string;
  kind: 'text' | 'tool' | 'note' | 'error';
  text: string;
  toolKind?: 'command' | 'read' | 'edit' | 'search' | 'other';
  done?: boolean;
  failed?: boolean;
  at: number;
}

/**
 * A command the agent proposed. Verification is streamed, so `verify` moves
 * `pending → running → pass|fail` while the panel is open.
 */
export interface DetectionProposal {
  name: string;
  argv: string[];
  source: string;
  verify: 'pending' | 'running' | 'pass' | 'fail';
  exitCode?: number | null;
  outputTail?: string;
  durationMs?: number;
  /** The binary was not found, which is a PATH problem, not a failing command. */
  notFound?: boolean;
}

export interface DetectionState {
  detectionId: string;
  projectId: string;
  status: 'running' | 'verifying' | 'done' | 'cancelled' | 'failed';
  /** Which CLI and model actually ran, which may differ from what was asked. */
  cli: CliVendor;
  model: string;
  entries: DetectionEntry[];
  proposals: DetectionProposal[];
  /** Proposals that were not usable, each with the reason it was dropped. */
  rejected: { raw: unknown; reason: string }[];
  /** The agent's reply verbatim, so an unparseable answer stays diagnosable. */
  rawReply: string;
  detail: string;
  startedAt: number;
  endedAt?: number;
}

/** One line of the setup-script generation transcript. Reuses the same union. */
export type SetupEntry = DetectionEntry;

export interface SetupState {
  setupId: string;
  projectId: string;
  status: 'running' | 'done' | 'cancelled' | 'failed';
  cli: CliVendor;
  model: string;
  entries: SetupEntry[];
  script: string;
  rawReply: string;
  detail: string;
  startedAt: number;
  endedAt?: number;
}

export interface SetupSniffResult {
  script: string;
  detail: string;
  sources: string[];
}

export interface WorktreeAction {
  ok: boolean;
  detail: string;
}

/**
 * Everything creating a repository needs and nothing else. Owner is optional
 * because the signed-in login is the answer for most people, and a question
 * whose answer is already known is not worth a step.
 */
export interface NewRepoInput {
  /** Repo name only; the owner travels separately so it can be defaulted. */
  name: string;
  owner?: string;
  visibility: 'private' | 'public';
  description?: string;
  /** Where the clone lands: the new repo becomes `${parentDir}/${name}`. */
  parentDir: string;
}

export interface NewRepoResult {
  ok: boolean;
  /** gh's own words when it refused, so the reason is diagnosable. */
  detail: string;
  /** Present only on success: the project is already registered. */
  project?: ProjectDef;
  url?: string;
  nameWithOwner?: string;
  path?: string;
}

/** The outcome of a gh action, with the PR's coordinates when one exists. */
export interface PrAction {
  ok: boolean;
  detail: string;
  number?: number;
  url?: string;
}

export interface PrList {
  ok: boolean;
  detail: string;
  prs: PullRequest[];
}

export interface FoundryApi {
  settings: {
    get(): Promise<AppSettings>;
    patch(patch: Partial<AppSettings>): Promise<SaveResult<AppSettings>>;
  };
  projects: {
    list(): Promise<ProjectDef[]>;
    add(): Promise<ProjectDef | null>;
    /** Who gh is signed in as, so the create flow can name the owner up front. */
    githubAccount(): Promise<GithubAccount>;
    /** Folder picker for where a new repo should be cloned. Null when cancelled. */
    chooseParentDir(): Promise<string | null>;
    /**
     * Creates the repo on GitHub through the operator's own gh, clones it, and
     * registers the clone as a project. Foundry holds no GitHub token.
     */
    createGithub(input: NewRepoInput): Promise<NewRepoResult>;
    save(project: ProjectDef): Promise<SaveResult<ProjectDef[]>>;
    remove(id: string): Promise<ProjectDef[]>;
    export(id: string): Promise<string | null>;
    tryCommand(id: string, argv: string[]): Promise<TryCommandResult>;
    /** Manifest sniffing only: free, no model, no process. */
    sniffCommands(id: string): Promise<DetectCommandsResult>;
    /**
     * Always spawns an agent. Returns as soon as the session exists; progress
     * arrives on `detection-progress` and the final state is in `detection`.
     */
    askAgentCommands(id: string): Promise<{ detectionId: string } | { error: string }>;
    cancelDetection(detectionId: string): Promise<boolean>;
    /** The current state of a detection, for a panel reopened mid-run. */
    detection(detectionId: string): Promise<DetectionState | null>;
    /** Shell script for the worktree bootstrap, lives in app data per project. */
    setupScriptGet(id: string): Promise<string>;
    setupScriptSave(id: string, script: string): Promise<SaveResult<ProjectDef[]>>;
    setupScriptSniff(id: string): Promise<SetupSniffResult>;
    setupScriptTry(id: string, script: string): Promise<TryCommandResult>;
    setupScriptAskAgent(id: string): Promise<{ setupId: string } | { error: string }>;
    setupProgress(setupId: string): Promise<SetupState | null>;
    setupCancel(setupId: string): Promise<boolean>;
    check(id: string): Promise<DoctorCheck[]>;
    reveal(path: string): Promise<void>;
  };
  roster: {
    list(projectId?: string): Promise<AgentDef[]>;
    save(agent: AgentDef, projectId?: string): Promise<SaveResult<AgentDef[]>>;
    /**
     * A name change is its own operation, not a save under a new key: `save`
     * upserts by name, so renaming through it appends rather than renames.
     */
    rename(from: string, to: string, projectId?: string): Promise<RenameResult>;
    remove(name: string, projectId?: string): Promise<AgentDef[]>;
    duplicate(name: string, projectId?: string): Promise<AgentDef | null>;
    validate(agent: AgentDef): Promise<ValidationIssue[]>;
    reset(): Promise<AgentDef[]>;
  };
  envelopes: {
    list(): Promise<EnvelopeDef[]>;
    save(def: EnvelopeDef): Promise<SaveResult<EnvelopeDef[]>>;
    remove(name: string): Promise<EnvelopeDef[]>;
    duplicate(name: string): Promise<EnvelopeDef | null>;
    /** Who still names this envelope, so a delete confirm can warn precisely. */
    usage(name: string): Promise<{
      agents: string[];
      phases: { pipeline: string; phase: string }[];
    }>;
    /** Issues plus the live JSON example the agent will be shown. */
    validate(def: EnvelopeDef): Promise<{ issues: ValidationIssue[]; example: string }>;
    /**
     * JSON example for a built-in kind or custom name — same path the agent sees.
     * Used by the Settings inspect pane for built-ins.
     */
    preview(name: string): Promise<string>;
  };
  pipelines: {
    list(projectId?: string): Promise<PipelineDef[]>;
    save(pipeline: PipelineDef, projectId?: string): Promise<SaveResult<PipelineDef[]>>;
    remove(id: string, projectId?: string): Promise<PipelineDef[]>;
    duplicate(id: string, projectId?: string): Promise<PipelineDef | null>;
    validate(pipeline: PipelineDef, projectId?: string): Promise<ValidationIssue[]>;
    /** Renders the exact prompts a run would send, spending nothing. */
    dryRun(pipelineId: string, projectId: string, request: string): Promise<DryRunPrompt[]>;
    reset(): Promise<PipelineDef[]>;
  };
  catalog: {
    /** Models the given CLI can reach. Each vendor answers for itself. */
    models(vendor: CliVendor, force?: boolean): Promise<ModelInfo[]>;
    tools(vendor: CliVendor, model?: string): Promise<ToolInfo[]>;
    /**
     * What the operator has installed on the host: skills, custom Droids, and
     * MCP servers, for per-agent opt-in on the roster. Read-only — there is no
     * channel that writes any of them, because Foundry never edits the host
     * install to satisfy a selection.
     */
    invocables(): Promise<HostInvocableInventory>;
    /** What each CLI is, where it lives, and what it cannot do. */
    clis(): Promise<CliDescriptor[]>;
    gates(): Promise<{ id: string; description: string }[]>;
    templateVariables(): Promise<{ token: string; description: string }[]>;
  };
  runs: {
    start(
      input: StartRunInput,
    ): Promise<{ ok: boolean; runId?: string; issues: ValidationIssue[] }>;
    list(projectId: string, includeArchived: boolean): Promise<RunRow[]>;
    detail(projectId: string, runId: string): Promise<RunDetail>;
    events(projectId: string, runId: string, afterChangeId: number): Promise<EventPage>;
    liveTail(phaseId: string): Promise<string>;
    /**
     * What is filling an agent's context: read off the live session, or the
     * snapshot its last turn left behind once the run has finished. Always
     * answers — an absent breakdown carries the reason instead of throwing.
     */
    contextBreakdown(
      projectId: string,
      runId: string,
      agent: string,
    ): Promise<ContextBreakdownResult>;
    /** The prompt as sent, read from the run's files rather than the event stream. */
    promptFor(projectId: string, phaseId: string): Promise<string>;
    kill(projectId: string, runId: string): Promise<boolean>;
    archive(projectId: string, runId: string, archived: boolean): Promise<void>;
    mergeWorktree(projectId: string, runId: string): Promise<WorktreeAction>;
    /**
     * When the base moved or the merge conflicts, an agent rebases the run
     * branch inside its worktree; code verifies the result and merges. One
     * click from a refused merge to a landed one.
     */
    fixMerge(projectId: string, runId: string): Promise<WorktreeAction>;
    discardWorktree(projectId: string, runId: string): Promise<WorktreeAction>;
    openWorktree(projectId: string, runId: string): Promise<void>;
    /** Opens the run's folder of raw records (prompts, stream.jsonl, logs). */
    revealFiles(projectId: string, runId: string): Promise<void>;
  };
  prs: {
    /** Cheap enough to gate the UI on: gh presence, auth, and remote resolve. */
    status(projectId: string): Promise<GhStatus>;
    list(projectId: string): Promise<PrList>;
    /** Pushes the run's branch and opens a PR against the run's base ref. */
    create(projectId: string, runId: string, title: string, body: string): Promise<PrAction>;
    /**
     * Merges on GitHub, then settles locally: a foundry run branch has its
     * worktree removed and its run marked merged, and the base ref is
     * fast-forwarded to match the remote.
     */
    merge(projectId: string, prNumber: number, method: PrMergeMethod): Promise<PrAction>;
    /**
     * A conflicting PR whose head is a foundry run branch still has its
     * worktree: an agent rebases it onto the freshly fetched base there, and
     * code force-with-lease pushes the result so the PR becomes mergeable.
     */
    fixConflicts(projectId: string, prNumber: number): Promise<PrAction>;
  };
  interrupts: {
    list(): Promise<PendingInterrupt[]>;
    answer(answer: InterruptAnswer): Promise<boolean>;
  };
  smith: {
    /**
     * Everything needed to start a session in the user's own terminal: resolved
     * CLI and skill paths, the bootstrap line, and the chosen terminal.
     */
    launchInfo(projectId: string): Promise<SmithLaunchInfo>;
    /** Opens the project directory in the preferred terminal. */
    openTerminal(projectId: string): Promise<{ ok: boolean; error?: string }>;
    /** The one pending proposal, or an empty list. Only ever one at a time. */
    proposalsList(): Promise<SmithProposal[]>;
    /** Approve or reject the pending proposal, unblocking the waiting CLI. */
    proposalAnswer(id: string, answer: SmithProposalAnswer): Promise<boolean>;
  };
  doctor: {
    run(): Promise<DoctorCheck[]>;
  };
  maintenance: {
    orphanWorktrees(): Promise<OrphanWorktree[]>;
    removeWorktree(projectId: string, path: string): Promise<WorktreeAction>;
    applyRetention(): Promise<MaintenanceReport>;
    compact(): Promise<void>;
  };
  app: {
    openExternal(url: string): Promise<void>;
    assetUrl(relPath: string): Promise<string>;
    version(): Promise<string>;
    quit(): Promise<void>;
    relaunch(): Promise<void>;
  };
  updater: {
    check(): Promise<UpdateStatus>;
    download(): Promise<UpdateStatus>;
    quitAndInstall(): Promise<void>;
    getStatus(): Promise<UpdateStatus>;
  };
  /**
   * Push channels are deliberately few: everything else is polled.
   *
   * `detection-progress` is pushed rather than polled because a detection is
   * not a run: it has no trace rows and therefore no `change_id` cursor to walk.
   * `setup-progress` is the same shape for the worktree bootstrap generator.
   */
  on(
    channel:
      | 'runs-changed'
      | 'interrupts-changed'
      | 'settings-changed'
      | 'updater-status'
      | 'detection-progress'
      | 'setup-progress'
      | 'smith-proposals-changed',
    handler: (data?: unknown) => void,
  ): () => void;
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsGithubAccount: 'projects:githubAccount',
  projectsChooseParentDir: 'projects:chooseParentDir',
  projectsCreateGithub: 'projects:createGithub',
  projectsSave: 'projects:save',
  projectsRemove: 'projects:remove',
  projectsExport: 'projects:export',
  projectsTryCommand: 'projects:tryCommand',
  projectsSniffCommands: 'projects:sniffCommands',
  projectsAskAgentCommands: 'projects:askAgentCommands',
  projectsCancelDetection: 'projects:cancelDetection',
  projectsDetection: 'projects:detection',
  projectsSetupScriptGet: 'projects:setupScriptGet',
  projectsSetupScriptSave: 'projects:setupScriptSave',
  projectsSetupScriptSniff: 'projects:setupScriptSniff',
  projectsSetupScriptTry: 'projects:setupScriptTry',
  projectsSetupScriptAskAgent: 'projects:setupScriptAskAgent',
  projectsSetupProgress: 'projects:setupProgress',
  projectsSetupCancel: 'projects:setupCancel',
  projectsCheck: 'projects:check',
  projectsReveal: 'projects:reveal',
  rosterList: 'roster:list',
  rosterSave: 'roster:save',
  rosterRename: 'roster:rename',
  rosterRemove: 'roster:remove',
  rosterDuplicate: 'roster:duplicate',
  rosterValidate: 'roster:validate',
  rosterReset: 'roster:reset',
  envelopesList: 'envelopes:list',
  envelopesSave: 'envelopes:save',
  envelopesRemove: 'envelopes:remove',
  envelopesDuplicate: 'envelopes:duplicate',
  envelopesUsage: 'envelopes:usage',
  envelopesValidate: 'envelopes:validate',
  envelopesPreview: 'envelopes:preview',
  pipelinesList: 'pipelines:list',
  pipelinesSave: 'pipelines:save',
  pipelinesRemove: 'pipelines:remove',
  pipelinesDuplicate: 'pipelines:duplicate',
  pipelinesValidate: 'pipelines:validate',
  pipelinesDryRun: 'pipelines:dryRun',
  pipelinesReset: 'pipelines:reset',
  catalogModels: 'catalog:models',
  catalogClis: 'catalog:clis',
  catalogTools: 'catalog:tools',
  catalogInvocables: 'catalog:invocables',
  catalogGates: 'catalog:gates',
  catalogTemplateVariables: 'catalog:templateVariables',
  runsStart: 'runs:start',
  runsList: 'runs:list',
  runsDetail: 'runs:detail',
  runsEvents: 'runs:events',
  runsLiveTail: 'runs:liveTail',
  runsContextBreakdown: 'runs:contextBreakdown',
  runsPrompt: 'runs:prompt',
  runsKill: 'runs:kill',
  runsArchive: 'runs:archive',
  runsMergeWorktree: 'runs:mergeWorktree',
  runsFixMerge: 'runs:fixMerge',
  runsDiscardWorktree: 'runs:discardWorktree',
  runsOpenWorktree: 'runs:openWorktree',
  runsRevealFiles: 'runs:revealFiles',
  prsStatus: 'prs:status',
  prsList: 'prs:list',
  prsCreate: 'prs:create',
  prsMerge: 'prs:merge',
  prsFixConflicts: 'prs:fixConflicts',
  interruptsList: 'interrupts:list',
  interruptsAnswer: 'interrupts:answer',
  smithLaunchInfo: 'smith:launchInfo',
  smithOpenTerminal: 'smith:openTerminal',
  smithProposalsList: 'smith:proposalsList',
  smithProposalAnswer: 'smith:proposalAnswer',
  doctorRun: 'doctor:run',
  maintenanceOrphans: 'maintenance:orphans',
  maintenanceRemoveWorktree: 'maintenance:removeWorktree',
  maintenanceRetention: 'maintenance:retention',
  maintenanceCompact: 'maintenance:compact',
  appOpenExternal: 'app:openExternal',
  appAssetUrl: 'app:assetUrl',
  appVersion: 'app:version',
  appQuit: 'app:quit',
  appRelaunch: 'app:relaunch',
  updaterCheck: 'updater:check',
  updaterDownload: 'updater:download',
  updaterQuitAndInstall: 'updater:quitAndInstall',
  updaterGetStatus: 'updater:getStatus',
  eventRunsChanged: 'event:runs-changed',
  eventInterruptsChanged: 'event:interrupts-changed',
  eventSettingsChanged: 'event:settings-changed',
  eventUpdaterStatus: 'event:updater-status',
  eventDetectionProgress: 'event:detection-progress',
  eventSetupProgress: 'event:setup-progress',
  eventSmithProposalsChanged: 'event:smith-proposals-changed',
} as const;
