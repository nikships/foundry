/**
 * What every IPC handler needs, assembled once. Scope resolution lives here so
 * "which roster does this project see" is answered in exactly one place: a
 * project either uses the global roster or its own copy, never a merge, because
 * a half-inherited roster makes a pipeline's agent reference ambiguous.
 */

import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AGENT_MARKS_DIR } from './store/agent-marks.js';
import type { AgentDef, AppSettings, PipelineDef, RunRow } from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import { SettingsStore } from './store/settings.js';
import { ProjectStore } from './store/projects.js';
import { RosterStore } from './store/roster.js';
import { PipelineStore } from './store/pipelines.js';
import { EnvelopeStore } from './store/envelopes.js';
import { RunRegistry } from './engine/registry.js';
import { Detections } from './engine/detections.js';
import { Setups } from './engine/setups.js';
import { ReadinessSessions } from './readiness/sessions.js';
import { UpdaterService } from './updater.js';
import { SmithService } from './smith/index.js';
import { saveProposal } from './ipc/smith.js';
import { notifyNeedsInput, notifyOutcome, setDockBadge } from './system/notify.js';
import { setSettingsApiKey, settingsApiKeyForSpawn } from './droid/sdk/auth.js';
import { shutdownDaemonManager } from './droid/sdk/daemon.js';
import { setSpawnEnvExtra } from './system/env.js';

export interface Scope {
  projectId?: string;
  ownRoster?: boolean;
  ownPipelines?: boolean;
}

export class AppContext {
  readonly settings: SettingsStore;
  readonly projects: ProjectStore;
  readonly roster: RosterStore;
  readonly pipelines: PipelineStore;
  readonly envelopes: EnvelopeStore;
  readonly registry: RunRegistry;
  readonly detections: Detections;
  readonly setups: Setups;
  readonly readiness: ReadinessSessions;
  readonly updater: UpdaterService;
  readonly smith: SmithService;
  readonly version: string;

  constructor(
    readonly supportDir: string,
    private readonly assetsRoot: string,
  ) {
    this.settings = new SettingsStore(supportDir);
    // Must land before any droid spawn so the first pipeline sees the key.
    this.syncFactoryAuth();
    this.projects = new ProjectStore(supportDir);
    this.roster = new RosterStore(supportDir);
    this.pipelines = new PipelineStore(supportDir);
    this.envelopes = new EnvelopeStore(supportDir);
    this.version = app.getVersion();
    this.updater = new UpdaterService((channel, payload) => this.broadcast(channel, payload));
    this.detections = new Detections((state) => this.broadcast(IPC.eventDetectionProgress, state));
    this.setups = new Setups((state) => this.broadcast(IPC.eventSetupProgress, state));
    this.readiness = new ReadinessSessions((state) =>
      this.broadcast(IPC.eventReadinessProgress, state),
    );

    this.registry = new RunRegistry({
      appSupportDir: supportDir,
      settings: () => this.settings.get(),
      engineerName: this.settings.get().engineerName,
      onRunFinished: (run: RunRow) => this.onRunFinished(run),
      onInterruptsChanged: () => this.broadcast(IPC.eventInterruptsChanged),
      onRunsChanged: () => {
        setDockBadge(this.registry.liveRunCount(), this.settings.get());
        this.broadcast(IPC.eventRunsChanged);
      },
    });

    this.registry.on('needs-input', (interrupt: { title: string; body: string }) => {
      notifyNeedsInput(interrupt.title, interrupt.body, this.settings.get());
    });

    // Smith is a skill an agent loads in the user's own terminal; the app only
    // owns the socket it calls and the card that gates every write.
    this.smith = new SmithService({
      supportDir,
      broadcast: (channel, payload) => this.broadcast(channel, payload),
      channels: { proposalsChanged: IPC.eventSmithProposalsChanged },
      // The queue awaits a save; store access lives in the IPC layer, so the
      // handler is threaded through here rather than importing a store into the
      // queue.
      save: (proposal) => saveProposal(this, proposal),
      socketCtx: this,
    });
  }

  private onRunFinished(run: RunRow): void {
    notifyOutcome(run, this.settings.get());
    setDockBadge(this.registry.liveRunCount(), this.settings.get());
    this.broadcast(IPC.eventRunsChanged);
  }

  window(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  /**
   * Asset paths are resolved in main so a dev server and a packaged app agree
   * without the renderer knowing where the app lives on disk.
   */
  assetUrl(relPath: string): string {
    const cleaned = relPath.replace(/^\/+/, '');
    // User-uploaded marks live next to roster.json, not in the packaged tree.
    if (cleaned.startsWith(`${AGENT_MARKS_DIR}/`)) {
      const file = cleaned.slice(AGENT_MARKS_DIR.length + 1);
      if (file && file === basename(file) && !file.includes('..')) {
        const full = join(this.supportDir, AGENT_MARKS_DIR, file);
        if (existsSync(full)) return pathToFileURL(full).toString();
      }
      return '';
    }
    const full = join(this.assetsRoot, cleaned);
    if (existsSync(full)) return pathToFileURL(full).toString();
    // An empty string renders as a silently missing image, which looks like a
    // styling bug rather than a packaging one. Say where it looked.
    console.warn(`[assets] missing: ${full}`);
    return '';
  }

  rosterScope(projectId?: string): Scope {
    const project = projectId ? this.projects.get(projectId) : null;
    return { projectId, ownRoster: !!project?.ownRoster };
  }

  pipelineScope(projectId?: string): Scope {
    const project = projectId ? this.projects.get(projectId) : null;
    return { projectId, ownPipelines: !!project?.ownPipelines };
  }

  rosterFor(projectId?: string): AgentDef[] {
    return this.roster.list(this.rosterScope(projectId));
  }

  pipelinesFor(projectId?: string): PipelineDef[] {
    return this.pipelines.list(this.pipelineScope(projectId));
  }

  commandNames(projectId?: string): string[] {
    if (!projectId) return [];
    return this.projects.get(projectId)?.commands.map((c) => c.name) ?? [];
  }

  currentSettings(): AppSettings {
    return this.settings.get();
  }

  /**
   * Push the Settings API key into daemon auth and every child env. Call on
   * launch and whenever the stored key changes; a live daemon is dropped so
   * the next turn reconnects with the new credential.
   */
  syncFactoryAuth(): void {
    setSettingsApiKey(this.settings.get().factoryApiKey);
    setSpawnEnvExtra(settingsApiKeyForSpawn());
  }

  dispose(): void {
    this.registry.closeAll();
    this.detections.cancelAll();
    this.setups.cancelAll();
    this.readiness.cancelAll();
    this.smith.dispose();
    // Best-effort: disconnect + SIGTERM the app-owned daemon. --parent-pid is
    // the crash backstop; this is the clean quit path. Fire-and-forget so
    // dispose stays sync for before-quit.
    void shutdownDaemonManager();
  }
}
