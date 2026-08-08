/**
 * What every IPC handler needs, assembled once. Scope resolution lives here so
 * "which roster does this project see" is answered in exactly one place: a
 * project either uses the global roster or its own copy, never a merge, because
 * a half-inherited roster makes a pipeline's agent reference ambiguous.
 */

import { app, BrowserWindow, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentDef, AppSettings, BrandId, PipelineDef, RunRow } from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import { SettingsStore } from './store/settings.js';
import { ProjectStore } from './store/projects.js';
import { RosterStore } from './store/roster.js';
import { PipelineStore } from './store/pipelines.js';
import { RunRegistry } from './engine/registry.js';
import { UpdaterService } from './updater.js';
import { notifyNeedsInput, notifyOutcome, setDockBadge } from './system/notify.js';

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
  readonly registry: RunRegistry;
  readonly updater: UpdaterService;
  readonly version: string;

  constructor(
    readonly supportDir: string,
    private readonly assetsRoot: string,
  ) {
    this.settings = new SettingsStore(supportDir);
    this.projects = new ProjectStore(supportDir);
    this.roster = new RosterStore(supportDir);
    this.pipelines = new PipelineStore(supportDir);
    this.version = app.getVersion();
    this.updater = new UpdaterService((channel, payload) => this.broadcast(channel, payload));

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
      rememberCommand: (projectId, command) => this.rememberCommand(projectId, command),
    });

    this.registry.on('needs-input', (interrupt: { title: string; body: string }) => {
      notifyNeedsInput(interrupt.title, interrupt.body, this.settings.get());
    });
  }

  private onRunFinished(run: RunRow): void {
    notifyOutcome(run, this.settings.get());
    setDockBadge(this.registry.liveRunCount(), this.settings.get());
    this.broadcast(IPC.eventRunsChanged);
  }

  /** "Always allow" from a permission sheet is a project-level setting change. */
  private rememberCommand(projectId: string, command: string): void {
    const project = this.projects.get(projectId);
    if (!project || project.allowedCommands.includes(command)) return;
    this.projects.save({ ...project, allowedCommands: [...project.allowedCommands, command] });
    this.broadcast(IPC.eventSettingsChanged);
  }

  window(): BrowserWindow | null {
    return BrowserWindow.getAllWindows()[0] ?? null;
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  }

  private brandedCandidates(relPath: string): string[] {
    const normalized = relPath.replace(/^\/+/, '');
    const brand = this.settings.get().brand as BrandId | undefined;
    const needsBrand =
      normalized.startsWith('agents/') ||
      normalized.startsWith('concepts/') ||
      normalized.startsWith('scenes/') ||
      normalized.startsWith('icon/');
    if (needsBrand && (brand === 'prism' || brand === 'murmur')) {
      return [join(this.assetsRoot, 'brands', brand, normalized), join(this.assetsRoot, normalized)];
    }
    return [join(this.assetsRoot, normalized)];
  }

  /**
   * Asset paths are resolved in main so a dev server and a packaged app agree
   * without the renderer knowing where the app lives on disk.
   */
  assetUrl(relPath: string): string {
    for (const full of this.brandedCandidates(relPath.replace(/^\/+/, ''))) {
      if (existsSync(full)) return pathToFileURL(full).toString();
    }
    const full = join(this.assetsRoot, relPath.replace(/^\/+/, ''));
    // An empty string renders as a silently missing image, which looks like a
    // styling bug rather than a packaging one. Say where it looked.
    console.warn(`[assets] missing: ${full}`);
    return '';
  }

  /**
   * Try to hot-swap the dock/taskbar icon for the current brand. Returns true
   * if Electron accepted a new image, false otherwise (renderer should show a
   * relaunch prompt).
   */
  applyBrandDockIcon(): boolean {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return false;
    const brand = this.settings.get().brand as BrandId | undefined;
    if (brand !== 'prism' && brand !== 'murmur') return false;
    const iconPath = join(this.assetsRoot, 'brands', brand, 'icon', 'app-icon-1024.png');
    const fallback = join(this.assetsRoot, 'icon', 'app-icon-1024.png');
    const chosen = existsSync(iconPath) ? iconPath : fallback;
    if (!existsSync(chosen)) return false;
    try {
      const image = nativeImage.createFromPath(chosen);
      if (image.isEmpty()) return false;
      // setIcon works on Windows/Linux; on macOS the canonical API is dock.setIcon
      if (process.platform === 'darwin' && app.dock) {
        app.dock.setIcon(image);
        return true;
      }
      // Non-mac fallback (also harmless on mac as a second signal)
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.setIcon(image);
      }
      // On Windows app.setIcon isn't needed; BrowserWindow covers it.
      return true;
    } catch {
      return false;
    }
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
  }
}
