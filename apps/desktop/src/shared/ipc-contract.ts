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
  DoctorCheck,
  DryRunPrompt,
  EnvelopeRow,
  EventRow,
  GateResultRow,
  GhStatus,
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

export interface WorktreeAction {
  ok: boolean;
  detail: string;
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
    /** The prompt as sent, read from the run's files rather than the event stream. */
    promptFor(projectId: string, phaseId: string): Promise<string>;
    kill(projectId: string, runId: string): Promise<boolean>;
    archive(projectId: string, runId: string, archived: boolean): Promise<void>;
    mergeWorktree(projectId: string, runId: string): Promise<WorktreeAction>;
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
  };
  interrupts: {
    list(): Promise<PendingInterrupt[]>;
    answer(answer: InterruptAnswer): Promise<boolean>;
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
   */
  on(
    channel:
      | 'runs-changed'
      | 'interrupts-changed'
      | 'settings-changed'
      | 'updater-status'
      | 'detection-progress',
    handler: (data?: unknown) => void,
  ): () => void;
}

export const IPC = {
  settingsGet: 'settings:get',
  settingsPatch: 'settings:patch',
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsSave: 'projects:save',
  projectsRemove: 'projects:remove',
  projectsExport: 'projects:export',
  projectsTryCommand: 'projects:tryCommand',
  projectsSniffCommands: 'projects:sniffCommands',
  projectsAskAgentCommands: 'projects:askAgentCommands',
  projectsCancelDetection: 'projects:cancelDetection',
  projectsDetection: 'projects:detection',
  projectsCheck: 'projects:check',
  projectsReveal: 'projects:reveal',
  rosterList: 'roster:list',
  rosterSave: 'roster:save',
  rosterRename: 'roster:rename',
  rosterRemove: 'roster:remove',
  rosterDuplicate: 'roster:duplicate',
  rosterValidate: 'roster:validate',
  rosterReset: 'roster:reset',
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
  catalogGates: 'catalog:gates',
  catalogTemplateVariables: 'catalog:templateVariables',
  runsStart: 'runs:start',
  runsList: 'runs:list',
  runsDetail: 'runs:detail',
  runsEvents: 'runs:events',
  runsLiveTail: 'runs:liveTail',
  runsPrompt: 'runs:prompt',
  runsKill: 'runs:kill',
  runsArchive: 'runs:archive',
  runsMergeWorktree: 'runs:mergeWorktree',
  runsDiscardWorktree: 'runs:discardWorktree',
  runsOpenWorktree: 'runs:openWorktree',
  runsRevealFiles: 'runs:revealFiles',
  prsStatus: 'prs:status',
  prsList: 'prs:list',
  prsCreate: 'prs:create',
  prsMerge: 'prs:merge',
  interruptsList: 'interrupts:list',
  interruptsAnswer: 'interrupts:answer',
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
} as const;
