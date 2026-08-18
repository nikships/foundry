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
import { IPC, type DetectionState, type SetupState } from '@shared/ipc-contract.js';
import { SettingsStore } from './store/settings.js';
import { ProjectStore } from './store/projects.js';
import { RosterStore } from './store/roster.js';
import { PipelineStore } from './store/pipelines.js';
import { EnvelopeStore } from './store/envelopes.js';
import { RunRegistry } from './engine/registry.js';
import { createDetections, type DetectStart } from './engine/detect-session.js';
import { createSetups, type SetupStart } from './engine/setup-session.js';
import { ReadinessSessions } from './readiness/sessions.js';
import type { PanelRegistry } from './session/index.js';
import { piOneShots } from './pi/pi-oneshot.js';
import type { OneShotFactory } from './pi/oneshot.js';
import { UpdaterService } from './updater.js';
import { SmithService } from './smith/index.js';
import { saveProposal } from './ipc/smith.js';
import { notifyNeedsInput, notifyOutcome, setDockBadge } from './system/notify.js';
import { getBridgeService, shutdownBridgeService, type BridgeService } from './bridge/service.js';

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
  readonly detections: PanelRegistry<DetectStart, DetectionState>;
  readonly setups: PanelRegistry<SetupStart, SetupState>;
  readonly readiness: ReadinessSessions;
  readonly updater: UpdaterService;
  readonly smith: SmithService;
  readonly bridge: BridgeService;
  readonly version: string;
  /**
   * How every non-run agent turn is opened — detection, setup, the run-start
   * command fill, the rebase repair, the readiness fix. One factory rather than
   * five constructions, so a call site states what it needs (a directory, an
   * access level) and never where the runtime keeps its state.
   */
  readonly oneShot: OneShotFactory;

  constructor(
    readonly supportDir: string,
    private readonly assetsRoot: string,
  ) {
    this.settings = new SettingsStore(supportDir);
    this.projects = new ProjectStore(supportDir);
    this.roster = new RosterStore(supportDir);
    this.pipelines = new PipelineStore(supportDir);
    this.envelopes = new EnvelopeStore(supportDir);
    this.version = app.getVersion();
    // Constructed, not started: the Bridge spawns on the first `ensure()`, so
    // an operator who runs on their own API keys never pays for a child.
    this.bridge = getBridgeService({
      supportDir,
      port: this.settings.get().bridgePort,
      onModelsChanged: () => this.broadcast(IPC.eventBridgeChanged),
    });
    this.updater = new UpdaterService((channel, payload) => this.broadcast(channel, payload));
    this.oneShot = piOneShots(supportDir);
    this.detections = createDetections(this.oneShot, (state) =>
      this.broadcast(IPC.eventDetectionProgress, state),
    );
    this.setups = createSetups(this.oneShot, (state) =>
      this.broadcast(IPC.eventSetupProgress, state),
    );
    this.readiness = new ReadinessSessions(this.oneShot, (state) =>
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
      projectById: (id) => this.projects.get(id),
      saveProject: (next) => this.projects.save(next),
      notifySettings: () => this.broadcast(IPC.eventSettingsChanged),
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

  dispose(): void {
    this.registry.closeAll();
    this.detections.cancelAll();
    this.setups.cancelAll();
    this.readiness.cancelAll();
    this.smith.dispose();
    // Agent turns run in this process, so quitting ends them; the Bridge is the
    // one child left, and it has no parent-pid backstop of its own. This is the
    // only thing standing between a quit and an orphaned proxy holding the port.
    // Fire-and-forget so dispose stays sync for before-quit.
    void shutdownBridgeService();
  }
}
