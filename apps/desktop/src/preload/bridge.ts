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
  'settings-changed': IPC.eventSettingsChanged,
  'updater-status': IPC.eventUpdaterStatus,
  'detection-progress': IPC.eventDetectionProgress,
  'setup-progress': IPC.eventSetupProgress,
  'orchestrator-progress': IPC.eventOrchestratorProgress,
  'smith-proposals-changed': IPC.eventSmithProposalsChanged,
  'smith-progress': IPC.eventSmithProgress,
  'bridge-changed': IPC.eventBridgeChanged,
  'companion-changed': IPC.eventCompanionChanged,
} as const;

/** One-way menu commands; the renderer decides what to show. */
const MENU_CHANNELS = [
  'menu:settings',
  'menu:new-run',
  'menu:add-project',
  'menu:view-runs',
  'menu:view-inspector',
  'menu:view-design',
  'menu:view-prs',
  'menu:design-pipelines',
  'menu:design-agents',
  'menu:design-envelopes',
] as const;

const api: FoundryApi = {
  settings: {
    get: () => call(IPC.settingsGet),
    patch: (patch) => call(IPC.settingsPatch, patch),
  },
  projects: {
    list: () => call(IPC.projectsList),
    add: () => call(IPC.projectsAdd),
    githubAccount: () => call(IPC.projectsGithubAccount),
    chooseParentDir: () => call(IPC.projectsChooseParentDir),
    createGithub: (input) => call(IPC.projectsCreateGithub, input),
    save: (project) => call(IPC.projectsSave, project),
    remove: (id) => call(IPC.projectsRemove, id),
    export: (id) => call(IPC.projectsExport, id),
    tryCommand: (id, argv) => call(IPC.projectsTryCommand, id, argv),
    sniffCommands: (id) => call(IPC.projectsSniffCommands, id),
    askAgentCommands: (id) => call(IPC.projectsAskAgentCommands, id),
    cancelDetection: (detectionId) => call(IPC.projectsCancelDetection, detectionId),
    detection: (detectionId) => call(IPC.projectsDetection, detectionId),
    setupScriptGet: (id) => call(IPC.projectsSetupScriptGet, id),
    setupScriptSave: (id, script) => call(IPC.projectsSetupScriptSave, id, script),
    setupScriptSniff: (id) => call(IPC.projectsSetupScriptSniff, id),
    setupScriptTry: (id, script) => call(IPC.projectsSetupScriptTry, id, script),
    setupScriptAskAgent: (id) => call(IPC.projectsSetupScriptAskAgent, id),
    setupProgress: (setupId) => call(IPC.projectsSetupProgress, setupId),
    setupCancel: (setupId) => call(IPC.projectsSetupCancel, setupId),
    check: (id) => call(IPC.projectsCheck, id),
    reveal: (path) => call(IPC.projectsReveal, path),
    scopeCopies: (id) => call(IPC.projectsScopeCopies, id),
    baseSyncInspect: (id) => call(IPC.projectsBaseSyncInspect, id),
    baseSync: (id) => call(IPC.projectsBaseSync, id),
  },
  readiness: {
    inspect: (projectId) => call(IPC.readinessInspect, projectId),
    evaluate: (projectId, opts) => call(IPC.readinessEvaluate, projectId, opts),
    makeReady: (projectId) => call(IPC.readinessMakeReady, projectId),
    cancel: (projectId) => call(IPC.readinessCancel, projectId),
    get: (projectId) => call(IPC.readinessGet, projectId),
    skip: (projectId) => call(IPC.readinessSkip, projectId),
    retry: (projectId) => call(IPC.readinessRetry, projectId),
    confirmMerge: (projectId) => call(IPC.readinessConfirmMerge, projectId),
    dismiss: (projectId) => call(IPC.readinessDismiss, projectId),
  },
  roster: {
    list: (projectId) => call(IPC.rosterList, projectId),
    staleBuiltins: (projectId) => call(IPC.rosterStaleBuiltins, projectId),
    save: (agent, projectId) => call(IPC.rosterSave, agent, projectId),
    rename: (from, to, projectId) => call(IPC.rosterRename, from, to, projectId),
    remove: (name, projectId) => call(IPC.rosterRemove, name, projectId),
    duplicate: (name, projectId) => call(IPC.rosterDuplicate, name, projectId),
    validate: (agent) => call(IPC.rosterValidate, agent),
    preview: (agent) => call(IPC.rosterPreview, agent),
    reset: (name, projectId) => call(IPC.rosterReset, name, projectId),
    uploadMark: (bytesB64, mime) => call(IPC.rosterUploadMark, bytesB64, mime),
    removeMark: (emblem) => call(IPC.rosterRemoveMark, emblem),
  },
  envelopes: {
    list: () => call(IPC.envelopesList),
    save: (def) => call(IPC.envelopesSave, def),
    remove: (name) => call(IPC.envelopesRemove, name),
    duplicate: (name) => call(IPC.envelopesDuplicate, name),
    usage: (name) => call(IPC.envelopesUsage, name),
    validate: (def) => call(IPC.envelopesValidate, def),
    preview: (name) => call(IPC.envelopesPreview, name),
  },
  pipelines: {
    list: (projectId) => call(IPC.pipelinesList, projectId),
    staleBuiltins: (projectId) => call(IPC.pipelinesStaleBuiltins, projectId),
    save: (pipeline, projectId) => call(IPC.pipelinesSave, pipeline, projectId),
    remove: (id, projectId) => call(IPC.pipelinesRemove, id, projectId),
    duplicate: (id, projectId) => call(IPC.pipelinesDuplicate, id, projectId),
    validate: (pipeline, projectId) => call(IPC.pipelinesValidate, pipeline, projectId),
    dryRun: (pipelineId, projectId, request) =>
      call(IPC.pipelinesDryRun, pipelineId, projectId, request),
    reset: (id, projectId) => call(IPC.pipelinesReset, id, projectId),
  },
  catalog: {
    gates: () => call(IPC.catalogGates),
    templateVariables: () => call(IPC.catalogTemplateVariables),
    agentModels: () => call(IPC.catalogAgentModels),
  },
  bridge: {
    state: () => call(IPC.bridgeState),
    connect: (provider) => call(IPC.bridgeConnect, provider),
    disconnect: (provider) => call(IPC.bridgeDisconnect, provider),
    cancelLogin: (provider) => call(IPC.bridgeCancelLogin, provider),
    setApiKey: (providerId, apiKey) => call(IPC.bridgeSetApiKey, providerId, apiKey),
    clearApiKey: (providerId) => call(IPC.bridgeClearApiKey, providerId),
    storedKeys: () => call(IPC.bridgeStoredKeys),
  },
  linear: {
    state: () => call(IPC.linearState),
    setApiKey: (apiKey) => call(IPC.linearSetApiKey, apiKey),
    test: () => call(IPC.linearTest),
    clearApiKey: () => call(IPC.linearClearApiKey),
    issues: (query) => call(IPC.linearIssues, query),
    workflowStates: (teamId) => call(IPC.linearWorkflowStates, teamId),
    startRun: (input) => call(IPC.linearStartRun, input),
  },
  runs: {
    start: (input) => call(IPC.runsStart, input),
    resume: (projectId, runId) => call(IPC.runsResume, projectId, runId),
    list: (projectId, includeArchived) => call(IPC.runsList, projectId, includeArchived),
    detail: (projectId, runId) => call(IPC.runsDetail, projectId, runId),
    events: (projectId, runId, afterChangeId) =>
      call(IPC.runsEvents, projectId, runId, afterChangeId),
    liveTail: (phaseId) => call(IPC.runsLiveTail, phaseId),
    contextBreakdown: (projectId, runId, agent) =>
      call(IPC.runsContextBreakdown, projectId, runId, agent),
    promptFor: (projectId, phaseId) => call(IPC.runsPrompt, projectId, phaseId),
    kill: (projectId, runId) => call(IPC.runsKill, projectId, runId),
    archive: (projectId, runId, archived) => call(IPC.runsArchive, projectId, runId, archived),
    mergeWorktree: (projectId, runId) => call(IPC.runsMergeWorktree, projectId, runId),
    fixMerge: (projectId, runId) => call(IPC.runsFixMerge, projectId, runId),
    discardWorktree: (projectId, runId) => call(IPC.runsDiscardWorktree, projectId, runId),
    openWorktree: (projectId, runId) => call(IPC.runsOpenWorktree, projectId, runId),
    revealFiles: (projectId, runId) => call(IPC.runsRevealFiles, projectId, runId),
    plan: (projectId, runId) => call(IPC.runsPlan, projectId, runId),
    exportPlan: (projectId, runId, selection) =>
      call(IPC.runsExportPlan, projectId, runId, selection),
    restorableCheckpoints: (projectId, runId) =>
      call(IPC.runsRestorableCheckpoints, projectId, runId),
    restoreCheckpoint: (projectId, input) => call(IPC.runsRestoreCheckpoint, projectId, input),
  },
  orchestrator: {
    plan: (projectId, prompt, model, reasoningEffort) =>
      call(IPC.orchestratorPlan, projectId, prompt, model, reasoningEffort),
    cancel: (planId) => call(IPC.orchestratorCancel, planId),
  },
  prs: {
    status: (projectId) => call(IPC.prsStatus, projectId),
    list: (projectId) => call(IPC.prsList, projectId),
    create: (projectId, runId, title, body) => call(IPC.prsCreate, projectId, runId, title, body),
    merge: (projectId, prNumber, method) => call(IPC.prsMerge, projectId, prNumber, method),
    fixConflicts: (projectId, prNumber) => call(IPC.prsFixConflicts, projectId, prNumber),
  },
  smith: {
    send: (projectId, text, screen) => call(IPC.smithSend, projectId, text, screen),
    cancel: (projectId) => call(IPC.smithCancel, projectId),
    newChat: (projectId) => call(IPC.smithNewChat, projectId),
    state: (projectId) => call(IPC.smithState, projectId),
    setModel: (projectId, model) => call(IPC.smithSetModel, projectId, model),
    setReasoningEffort: (projectId, effort) => call(IPC.smithSetReasoningEffort, projectId, effort),
    proposalsList: () => call(IPC.smithProposalsList),
    answerProposal: (id, answer) => call(IPC.smithAnswerProposal, id, answer),
  },
  companion: {
    state: () => call(IPC.companionState),
    start: () => call(IPC.companionStart),
    stop: () => call(IPC.companionStop),
    pairingPayload: (opts) => call(IPC.companionPairingPayload, opts),
    unpair: (deviceId) => call(IPC.companionUnpair, deviceId),
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
    quit: () => call(IPC.appQuit),
    relaunch: () => call(IPC.appRelaunch),
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
