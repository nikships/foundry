/**
 * The only thing the renderer can reach. Each method is a named invoke: there
 * is no generic `invoke(channel, ...)` escape hatch, so the renderer's
 * capabilities are exactly the list below and nothing more.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type FoundryApi } from '../shared/ipc-contract.js';

const call = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>;

/** Push events the renderer can subscribe to (everything else is polled). */
const EVENT_CHANNELS = {
  'runs-changed': IPC.eventRunsChanged,
  'interrupts-changed': IPC.eventInterruptsChanged,
  'settings-changed': IPC.eventSettingsChanged,
  'updater-status': IPC.eventUpdaterStatus,
} as const;

/** One-way menu commands; the renderer decides what to show. */
const MENU_CHANNELS = [
  'menu:settings',
  'menu:new-run',
  'menu:add-project',
  'menu:view-runs',
  'menu:view-pipelines',
  'menu:view-roster',
  'menu:view-inspector',
] as const;

const api: FoundryApi = {
  settings: {
    get: () => call(IPC.settingsGet),
    patch: (patch) => call(IPC.settingsPatch, patch),
  },
  projects: {
    list: () => call(IPC.projectsList),
    add: () => call(IPC.projectsAdd),
    save: (project) => call(IPC.projectsSave, project),
    remove: (id) => call(IPC.projectsRemove, id),
    export: (id) => call(IPC.projectsExport, id),
    tryCommand: (id, argv) => call(IPC.projectsTryCommand, id, argv),
    detectCommands: (id, useAgent) => call(IPC.projectsDetectCommands, id, useAgent),
    check: (id) => call(IPC.projectsCheck, id),
    reveal: (path) => call(IPC.projectsReveal, path),
  },
  roster: {
    list: (projectId) => call(IPC.rosterList, projectId),
    save: (agent, projectId) => call(IPC.rosterSave, agent, projectId),
    remove: (name, projectId) => call(IPC.rosterRemove, name, projectId),
    duplicate: (name, projectId) => call(IPC.rosterDuplicate, name, projectId),
    reset: () => call(IPC.rosterReset),
  },
  pipelines: {
    list: (projectId) => call(IPC.pipelinesList, projectId),
    save: (pipeline, projectId) => call(IPC.pipelinesSave, pipeline, projectId),
    remove: (id, projectId) => call(IPC.pipelinesRemove, id, projectId),
    duplicate: (id, projectId) => call(IPC.pipelinesDuplicate, id, projectId),
    validate: (pipeline, projectId) => call(IPC.pipelinesValidate, pipeline, projectId),
    dryRun: (pipelineId, projectId, request) =>
      call(IPC.pipelinesDryRun, pipelineId, projectId, request),
    reset: () => call(IPC.pipelinesReset),
  },
  catalog: {
    models: (vendor, force) => call(IPC.catalogModels, vendor, force),
    tools: (vendor, model) => call(IPC.catalogTools, vendor, model),
    clis: () => call(IPC.catalogClis),
    gates: () => call(IPC.catalogGates),
    templateVariables: () => call(IPC.catalogTemplateVariables),
  },
  runs: {
    start: (input) => call(IPC.runsStart, input),
    list: (projectId, includeArchived) => call(IPC.runsList, projectId, includeArchived),
    detail: (projectId, runId) => call(IPC.runsDetail, projectId, runId),
    events: (projectId, runId, afterRowid) => call(IPC.runsEvents, projectId, runId, afterRowid),
    liveTail: (phaseId) => call(IPC.runsLiveTail, phaseId),
    promptFor: (projectId, phaseId) => call(IPC.runsPrompt, projectId, phaseId),
    kill: (projectId, runId) => call(IPC.runsKill, projectId, runId),
    archive: (projectId, runId, archived) => call(IPC.runsArchive, projectId, runId, archived),
    mergeWorktree: (projectId, runId) => call(IPC.runsMergeWorktree, projectId, runId),
    discardWorktree: (projectId, runId) => call(IPC.runsDiscardWorktree, projectId, runId),
    openWorktree: (projectId, runId) => call(IPC.runsOpenWorktree, projectId, runId),
    revealFiles: (projectId, runId) => call(IPC.runsRevealFiles, projectId, runId),
  },
  interrupts: {
    list: () => call(IPC.interruptsList),
    answer: (answer) => call(IPC.interruptsAnswer, answer),
  },
  doctor: {
    run: () => call(IPC.doctorRun),
  },
  maintenance: {
    orphanWorktrees: () => call(IPC.maintenanceOrphans),
    removeWorktree: (projectId, path) => call(IPC.maintenanceRemoveWorktree, projectId, path),
    applyRetention: () => call(IPC.maintenanceRetention),
    compact: () => call(IPC.maintenanceCompact),
  },
  app: {
    openExternal: (url) => call(IPC.appOpenExternal, url),
    assetUrl: (relPath) => call(IPC.appAssetUrl, relPath),
    version: () => call(IPC.appVersion),
  },
  updater: {
    check: () => call(IPC.updaterCheck),
    download: () => call(IPC.updaterDownload),
    quitAndInstall: () => call(IPC.updaterQuitAndInstall),
    getStatus: () => call(IPC.updaterGetStatus),
  },
  on: (channel, handler) => {
    const ipcChannel = EVENT_CHANNELS[channel];
    const listener = (_event: unknown, data?: unknown): void => handler(data);
    ipcRenderer.on(ipcChannel, listener);
    return () => ipcRenderer.removeListener(ipcChannel, listener);
  },
};

contextBridge.exposeInMainWorld('foundry', api);

contextBridge.exposeInMainWorld('foundryMenu', {
  on(handler: (command: string) => void): () => void {
    const unsubscribers = MENU_CHANNELS.map((channel) => {
      const listener = (): void => handler(channel);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    });
    return () => {
      for (const off of unsubscribers) off();
    };
  },
});
