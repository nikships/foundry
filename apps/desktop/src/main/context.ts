/**
 * What every IPC handler needs, assembled once. Scope resolution lives here so
 * "which roster does this project see" is answered in exactly one place: a
 * project either uses the global roster or its own copy, never a merge, because
 * a half-inherited roster makes a pipeline's agent reference ambiguous.
 */

import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentDef, AppSettings, PipelineDef, RunRow } from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import { SettingsStore } from './store/settings.js';
import { ProjectStore } from './store/projects.js';
import { RosterStore } from './store/roster.js';
import { PipelineStore } from './store/pipelines.js';
import { RunRegistry } from './engine/registry.js';
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

  broadcast(channel: string): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel);
    }
  }

  /**
   * Asset paths are resolved in main so a dev server and a packaged app agree
   * without the renderer knowing where the app lives on disk.
   */
  assetUrl(relPath: string): string {
    const full = join(this.assetsRoot, relPath.replace(/^\/+/, ''));
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
  }
}
