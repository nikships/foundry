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
  InterruptAnswer,
  MaintenanceReport,
  ModelInfo,
  OrphanWorktree,
  PendingInterrupt,
  PhaseRow,
  PipelineDef,
  ProjectDef,
  RunRow,
  StartRunInput,
  ToolInfo,
  ValidationIssue,
} from './types.js';

export interface SaveResult<T> {
  ok: boolean;
  issues: ValidationIssue[];
  value?: T;
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

export interface WorktreeAction {
  ok: boolean;
  detail: string;
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
    detectCommands(id: string, useAgent?: boolean): Promise<DetectCommandsResult>;
    check(id: string): Promise<DoctorCheck[]>;
    reveal(path: string): Promise<void>;
  };
  roster: {
    list(projectId?: string): Promise<AgentDef[]>;
    save(agent: AgentDef, projectId?: string): Promise<SaveResult<AgentDef[]>>;
    remove(name: string, projectId?: string): Promise<AgentDef[]>;
    duplicate(name: string, projectId?: string): Promise<AgentDef | null>;
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
    start(input: StartRunInput): Promise<{ ok: boolean; runId?: string; issues: ValidationIssue[] }>;
    list(projectId: string, includeArchived: boolean): Promise<RunRow[]>;
    detail(projectId: string, runId: string): Promise<RunDetail>;
    events(projectId: string, runId: string, afterRowid: number): Promise<EventPage>;
    liveTail(phaseId: string): Promise<string>;
    /** The prompt as sent, read from the run's files rather than the event stream. */
    promptFor(projectId: string, phaseId: string): Promise<string>;
    kill(projectId: string, runId: string): Promise<boolean>;
    archive(projectId: string, runId: string, archived: boolean): Promise<void>;
    mergeWorktree(projectId: string, runId: string): Promise<WorktreeAction>;
    discardWorktree(projectId: string, runId: string): Promise<WorktreeAction>;
    openWorktree(projectId: string, runId: string): Promise<void>;
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
  };
  /** Push channels are deliberately few: everything else is polled. */
  on(channel: 'runs-changed' | 'interrupts-changed' | 'settings-changed', handler: () => void): () => void;
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
  projectsDetectCommands: 'projects:detectCommands',
  projectsCheck: 'projects:check',
  projectsReveal: 'projects:reveal',
  rosterList: 'roster:list',
  rosterSave: 'roster:save',
  rosterRemove: 'roster:remove',
  rosterDuplicate: 'roster:duplicate',
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
  eventRunsChanged: 'event:runs-changed',
  eventInterruptsChanged: 'event:interrupts-changed',
  eventSettingsChanged: 'event:settings-changed',
} as const;
