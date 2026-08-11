/**
 * Per-project Smith sessions. The main process owns each session so it
 * survives the modal closing (a hidden modal is not a killed terminal) — only
 * an explicit kill or app quit ends one.
 *
 * Each session spawns the real `droid` CLI inside a headless Ghostty
 * (`engine.ts`) with the project path as cwd and the generated system prompt
 * appended, plus the env vars the helper CLI needs (`FOUNDRY_SMITH_SOCKET`,
 * `FOUNDRY_CLI`). Ghostty owns the PTY and repaints the renderer's canvas
 * itself, so there is no output ring buffer here — a reopened modal gets a
 * `redraw()` kick and the live screen reappears.
 *
 * Session ids: droid persists sessions under `~/.factory/sessions`. After a
 * fresh spawn the registry resolves the new session's id (newest session whose
 * cwd matches the project path, created after our spawn) via the droid SDK's
 * local store reader and records it, so a later app launch can `droid
 * --resume` it. A resume that dies immediately retries fresh once.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectDef, SmithStatus, SmithTheme } from '@shared/types.js';
import type { AgentDef, EnvelopeDef, PipelineDef } from '@shared/types.js';
import { smithSlot } from '@shared/ipc-contract.js';
import { localDroidSessions } from '../droid/sdk/local-sessions.js';
import { spawnEnv } from '../system/env.js';
import { JsonStore } from '../store/json-store.js';
import { writeSystemPrompt } from './system-prompt.js';
import type { GhosttySpawnOptions, TerminalEngine } from './engine.js';

/** After this long with no presented frame, a busy session is idle again. */
const ACTIVITY_IDLE_MS = 1500;

/**
 * When a fresh spawn's droid session id is looked up in the local store.
 * droid creates the session file quickly but not instantly, and the modal
 * being open is no guarantee the user typed anything yet — so a few widening
 * attempts, then give up (the next fresh spawn tries again).
 */
const DISCOVERY_DELAYS_MS = [5_000, 15_000, 45_000];
/** Tolerated skew between our clock and the session file's birthtime. */
const DISCOVERY_SKEW_MS = 2_000;

/** Persisted per-project droid session id, for `--resume` across app launches. */
type SessionState = Record<string, { droidSessionId?: string }>;

interface SessionScope {
  project: ProjectDef;
  agents: AgentDef[];
  pipelines: PipelineDef[];
  envelopes: EnvelopeDef[];
}

interface Session {
  projectId: string;
  engine: TerminalEngine;
  status: SmithStatus;
  activityTimer: ReturnType<typeof setTimeout> | null;
  discoveryTimers: ReturnType<typeof setTimeout>[];
}

/** The slice of the droid session store the discovery needs. */
export interface DiscoveredSession {
  id: string;
  createdTime: Date;
}

export interface SmithRegistryDeps {
  /** App support dir; the Smith subtree lives under `<supportDir>/smith`. */
  supportDir: string;
  /** Absolute path to the running helper binary, injected as `$FOUNDRY_CLI`. */
  cliPath: string;
  /** Absolute socket path, injected as `$FOUNDRY_SMITH_SOCKET`. */
  socketPath: string;
  /** Resolves everything the system prompt and spawn need for a project. */
  scopeFor: (projectId: string) => SessionScope | null;
  /** Verifies droid is installed; reused doctor check. Resolves the binary path. */
  droid: () => Promise<{ ok: boolean; path: string }>;
  /** Status transitions (starting → idle/busy/exited/blocked). */
  onStatusChanged: (status: SmithStatus) => void;
  /** True when the vendored Ghostty addon can run here. There is no fallback. */
  engineAvailable: () => boolean;
  /** Spawns the engine; separated from the module so tests can fake it. */
  spawnEngine: (opts: GhosttySpawnOptions) => TerminalEngine;
  /** The window the terminal paints into; null when no window exists. */
  webContents: () => GhosttySpawnOptions['webContents'] | null;
  /** Reads droid's local session store, newest first. Overridable in tests. */
  discoverSessions?: (cwd: string) => Promise<DiscoveredSession[]>;
}

export class SmithRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly state: JsonStore<SessionState>;

  constructor(private readonly deps: SmithRegistryDeps) {
    this.state = new JsonStore<SessionState>(
      join(deps.supportDir, 'smith', 'sessions.json'),
      () => ({}),
    );
  }

  private smithDir(): string {
    return join(this.deps.supportDir, 'smith');
  }

  /** Status without spawning: what the sidebar dot and the modal read on mount. */
  status(projectId: string): SmithStatus {
    const session = this.sessions.get(projectId);
    if (session) return session.status;
    return { projectId, state: 'absent' };
  }

  /**
   * Ensures a session exists and returns its status. A missing/invalid project
   * path, an uninstalled droid, or an unavailable terminal engine returns a
   * `blocked` status the modal renders as guidance instead of a dead terminal.
   * Reopening an existing session kicks a redraw so the remounted canvas
   * repaints from live state.
   */
  async open(projectId: string, theme?: SmithTheme): Promise<SmithStatus> {
    const existing = this.sessions.get(projectId);
    if (existing && existing.status.state !== 'exited') {
      existing.engine.redraw();
      return existing.status;
    }

    const scope = this.deps.scopeFor(projectId);
    if (!scope) return this.blocked(projectId, 'no-project', 'No project selected.');
    if (!scope.project.path || !existsSync(scope.project.path)) {
      return this.blocked(projectId, 'invalid-path', `${scope.project.path} is not reachable.`);
    }

    if (!this.deps.engineAvailable()) {
      return this.blocked(
        projectId,
        'engine-missing',
        'The embedded terminal engine failed to load. Smith needs the bundled Ghostty addon (macOS arm64).',
      );
    }
    const webContents = this.deps.webContents();
    if (!webContents) {
      return this.blocked(projectId, 'engine-missing', 'No window to attach the terminal to.');
    }

    const droid = await this.deps.droid();
    if (!droid.ok) {
      return this.blocked(
        projectId,
        'droid-missing',
        'droid is not installed or not on PATH. Install it to use Smith.',
      );
    }

    return this.spawn(projectId, scope, droid.path, webContents, theme);
  }

  private blocked(projectId: string, reason: SmithStatus['blocked'], detail: string): SmithStatus {
    const status: SmithStatus = { projectId, state: 'blocked', blocked: reason, detail };
    this.deps.onStatusChanged(status);
    return status;
  }

  private spawn(
    projectId: string,
    scope: SessionScope,
    droidPath: string,
    webContents: NonNullable<ReturnType<SmithRegistryDeps['webContents']>>,
    theme?: SmithTheme,
  ): SmithStatus {
    const promptPath = writeSystemPrompt(this.smithDir(), {
      project: scope.project,
      agents: scope.agents,
      pipelines: scope.pipelines,
      envelopes: scope.envelopes,
      cliPath: this.deps.cliPath,
    });

    const storedId = this.state.read()[projectId]?.droidSessionId;
    const args = (resume: boolean): string[] => [
      ...(resume && storedId ? ['--resume', storedId] : []),
      '--append-system-prompt-file',
      promptPath,
    ];

    const spawnOpts = (resume: boolean): GhosttySpawnOptions => ({
      file: droidPath,
      args: args(resume),
      cwd: scope.project.path,
      extraEnv: {
        // The engine's utilityProcess inherits the GUI launch environment, so
        // the shell-resolved PATH must ride along for droid to find its tools.
        PATH: spawnEnv().PATH ?? '',
        FOUNDRY_SMITH_SOCKET: this.deps.socketPath,
        FOUNDRY_CLI: this.deps.cliPath,
        FOUNDRY_SMITH_PROJECT: projectId,
      },
      webContents,
      slot: smithSlot(projectId),
      theme,
    });

    const resuming = !!storedId;
    const engine = this.deps.spawnEngine(spawnOpts(true));
    const session: Session = {
      projectId,
      engine,
      status: { projectId, state: 'starting', resumed: resuming },
      activityTimer: null,
      discoveryTimers: [],
    };
    this.sessions.set(projectId, session);

    engine.onActivity(() => this.markBusy(session));
    engine.onExit(({ exitCode }) =>
      this.onExit(session, exitCode, scope.project.path, spawnOpts, resuming),
    );

    this.deps.onStatusChanged(session.status);
    this.setState(session, 'idle');
    // A resumed session already has its id recorded; a fresh one needs it
    // discovered from droid's local store for the next `--resume`.
    if (!resuming) this.scheduleDiscovery(session, scope.project.path);
    return session.status;
  }

  /** A presented frame means output happened; quiet for a beat means idle. */
  private markBusy(session: Session): void {
    if (this.sessions.get(session.projectId) !== session) return;
    if (session.status.state === 'exited' || session.status.state === 'blocked') return;
    if (session.status.state !== 'busy') this.setState(session, 'busy');
    if (session.activityTimer) clearTimeout(session.activityTimer);
    session.activityTimer = setTimeout(() => {
      if (this.sessions.get(session.projectId) === session) this.setState(session, 'idle');
    }, ACTIVITY_IDLE_MS);
  }

  private setState(session: Session, state: SmithStatus['state']): void {
    if (session.status.state === state) return;
    session.status = { ...session.status, state };
    this.deps.onStatusChanged(session.status);
  }

  private onExit(
    session: Session,
    exitCode: number,
    projectPath: string,
    spawnOpts: (resume: boolean) => GhosttySpawnOptions,
    wasResume: boolean,
  ): void {
    this.clearTimers(session);
    // A resume that died immediately (expired/missing id) is the one exit
    // worth retrying: respawn fresh once, dropping the stored id, so the user
    // gets a live session rather than a dead terminal.
    if (wasResume && exitCode !== 0 && this.sessions.get(session.projectId) === session) {
      this.forgetSession(session.projectId);
      const engine = this.deps.spawnEngine(spawnOpts(false));
      session.engine = engine;
      session.status = {
        projectId: session.projectId,
        state: 'idle',
        resumed: false,
        detail: 'Previous session could not be resumed — started fresh.',
      };
      engine.onActivity(() => this.markBusy(session));
      engine.onExit(({ exitCode: code }) => {
        this.clearTimers(session);
        this.finalizeExit(session, code);
      });
      this.deps.onStatusChanged(session.status);
      this.scheduleDiscovery(session, projectPath);
      return;
    }
    this.finalizeExit(session, exitCode);
  }

  private finalizeExit(session: Session, exitCode: number): void {
    session.status = {
      projectId: session.projectId,
      state: 'exited',
      detail: `droid exited (${exitCode})`,
    };
    this.deps.onStatusChanged(session.status);
  }

  kill(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (!session) return;
    this.clearTimers(session);
    session.engine.kill();
    this.sessions.delete(projectId);
    this.deps.onStatusChanged({ projectId, state: 'absent' });
  }

  /* ── droid session-id discovery ─────────────────────────────────────── */

  /**
   * droid writes its session under `~/.factory/sessions/<sanitized-cwd>/` as
   * `<id>.jsonl` shortly after spawn. Resolve the newest session for this
   * project created after our spawn and persist its id for `--resume`. The
   * created-after guard keeps a session the user started in their own
   * terminal (before ours) from being claimed as Smith's.
   */
  private scheduleDiscovery(session: Session, projectPath: string): void {
    const spawnedAt = Date.now();
    const discover = this.deps.discoverSessions ?? localDroidSessions;
    const attempt = async (): Promise<void> => {
      if (this.sessions.get(session.projectId) !== session) return;
      if (this.state.read()[session.projectId]?.droidSessionId) return;
      let found: DiscoveredSession | undefined;
      try {
        const sessions = await discover(projectPath);
        found = sessions.find((s) => s.createdTime.getTime() >= spawnedAt - DISCOVERY_SKEW_MS);
      } catch {
        return; // Store unreadable; a later attempt or spawn tries again.
      }
      if (found && this.sessions.get(session.projectId) === session) {
        this.recordSessionId(session.projectId, found.id);
      }
    };
    session.discoveryTimers = DISCOVERY_DELAYS_MS.map((delay) =>
      setTimeout(() => void attempt(), delay),
    );
  }

  recordSessionId(projectId: string, droidSessionId: string): void {
    this.state.update((current) => ({ ...current, [projectId]: { droidSessionId } }));
  }

  /** Drops the persisted droid session id so the next open spawns fresh. */
  private forgetSession(projectId: string): void {
    this.state.update((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  }

  private clearTimers(session: Session): void {
    if (session.activityTimer) clearTimeout(session.activityTimer);
    session.activityTimer = null;
    for (const timer of session.discoveryTimers) clearTimeout(timer);
    session.discoveryTimers = [];
  }

  closeAll(): void {
    for (const [, session] of this.sessions) {
      this.clearTimers(session);
      session.engine.kill();
    }
    this.sessions.clear();
  }
}
