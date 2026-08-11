/**
 * Per-project Smith PTY sessions. The main process owns each session so it
 * survives the modal closing (a hidden modal is not a killed terminal) — only an
 * explicit kill or app quit ends one.
 *
 * Each session spawns the real `droid` CLI with the project path as cwd and the
 * generated system prompt appended, plus the two injected env vars the helper
 * CLI needs (`FOUNDRY_SMITH_SOCKET`, `FOUNDRY_CLI`). A ring buffer of recent
 * output lets the renderer repaint scrollback when the modal reopens.
 *
 * The Ghostty engine (spec §5) will replace the PTY ownership here with a
 * utilityProcess slot; the `TerminalEngine` seam below is where it slots in.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDef, EnvelopeDef, PipelineDef, ProjectDef, SmithStatus } from '@shared/types.js';
import { spawnEnv } from '../system/env.js';
import { JsonStore } from '../store/json-store.js';
import { writeSystemPrompt } from './system-prompt.js';
import { spawnPtyEngine, type TerminalEngine } from './engine.js';

/** ~2 MB of recent output, so a reopened modal repaints without a live redraw. */
const RING_LIMIT_BYTES = 2 * 1024 * 1024;
/** After this long with no output, a busy session is treated as idle again. */
const ACTIVITY_IDLE_MS = 1500;

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
  ring: string;
  ringBytes: number;
  status: SmithStatus;
  activityTimer: ReturnType<typeof setTimeout> | null;
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
  /** Terminal output for the renderer, keyed by projectId. */
  onData: (projectId: string, data: string) => void;
  /** Status transitions (starting → idle/busy/exited/blocked). */
  onStatusChanged: (status: SmithStatus) => void;
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

  /** Recent output for repainting scrollback when the modal reopens. */
  buffer(projectId: string): string {
    return this.sessions.get(projectId)?.ring ?? '';
  }

  /**
   * Ensures a session exists and returns its status. A missing/invalid project
   * path or an uninstalled droid returns a `blocked` status the modal renders as
   * guidance instead of spawning a dead terminal.
   */
  async open(projectId: string): Promise<SmithStatus> {
    const existing = this.sessions.get(projectId);
    if (existing && existing.status.state !== 'exited') return existing.status;

    const scope = this.deps.scopeFor(projectId);
    if (!scope) return this.blocked(projectId, 'no-project', 'No project selected.');
    if (!scope.project.path || !existsSync(scope.project.path)) {
      return this.blocked(projectId, 'invalid-path', `${scope.project.path} is not reachable.`);
    }

    const droid = await this.deps.droid();
    if (!droid.ok) {
      return this.blocked(
        projectId,
        'droid-missing',
        'droid is not installed or not on PATH. Install it to use Smith.',
      );
    }

    return this.spawn(projectId, scope, droid.path);
  }

  private blocked(projectId: string, reason: SmithStatus['blocked'], detail: string): SmithStatus {
    const status: SmithStatus = { projectId, state: 'blocked', blocked: reason, detail };
    this.deps.onStatusChanged(status);
    return status;
  }

  private spawn(projectId: string, scope: SessionScope, droidPath: string): SmithStatus {
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

    const env = spawnEnv({
      FOUNDRY_SMITH_SOCKET: this.deps.socketPath,
      FOUNDRY_CLI: this.deps.cliPath,
      FOUNDRY_SMITH_PROJECT: projectId,
    });

    const engine = spawnPtyEngine({
      file: droidPath,
      args: args(true),
      cwd: scope.project.path,
      env,
    });

    const session: Session = {
      projectId,
      engine,
      ring: '',
      ringBytes: 0,
      status: { projectId, state: 'starting', resumed: !!storedId },
      activityTimer: null,
    };
    this.sessions.set(projectId, session);

    engine.onData((data) => this.absorb(session, data));
    engine.onExit(({ exitCode }) => this.onExit(session, exitCode, scope, droidPath, args));

    // A spawn is idle until the first byte flips it busy; report starting first.
    this.deps.onStatusChanged(session.status);
    this.setState(session, 'idle');
    return session.status;
  }

  private absorb(session: Session, data: string): void {
    session.ring += data;
    session.ringBytes += Buffer.byteLength(data);
    if (session.ringBytes > RING_LIMIT_BYTES) {
      const overflow = session.ringBytes - RING_LIMIT_BYTES;
      session.ring = session.ring.slice(overflow);
      session.ringBytes = Buffer.byteLength(session.ring);
    }
    this.deps.onData(session.projectId, data);
    this.markBusy(session);
  }

  /** Output means a turn is running; quiet for a beat means idle again. */
  private markBusy(session: Session): void {
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
    scope: SessionScope,
    droidPath: string,
    args: (resume: boolean) => string[],
  ): void {
    if (session.activityTimer) clearTimeout(session.activityTimer);
    // A resume that failed (expired/missing id) is the one exit worth retrying:
    // respawn fresh once, dropping the stored id, so the user gets a live
    // session with a one-line notice rather than a dead terminal.
    const wasResume = args(true).includes('--resume');
    if (wasResume && exitCode !== 0 && this.sessions.get(session.projectId) === session) {
      this.forgetSession(session.projectId);
      this.deps.onData(
        session.projectId,
        '\r\n[foundry] resume failed — starting a fresh session\r\n',
      );
      const engine = spawnPtyEngine({
        file: droidPath,
        args: args(false),
        cwd: scope.project.path,
        env: spawnEnv({
          FOUNDRY_SMITH_SOCKET: this.deps.socketPath,
          FOUNDRY_CLI: this.deps.cliPath,
          FOUNDRY_SMITH_PROJECT: session.projectId,
        }),
      });
      session.engine = engine;
      session.status = { projectId: session.projectId, state: 'idle', resumed: false };
      engine.onData((data) => this.absorb(session, data));
      engine.onExit(({ exitCode: code }) => this.finalizeExit(session, code));
      this.deps.onStatusChanged(session.status);
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

  write(projectId: string, data: string): void {
    this.sessions.get(projectId)?.engine.write(data);
  }

  resize(projectId: string, cols: number, rows: number): void {
    const session = this.sessions.get(projectId);
    if (!session) return;
    session.engine.resize(cols, rows);
    session.status = { ...session.status, cols, rows };
  }

  kill(projectId: string): void {
    const session = this.sessions.get(projectId);
    if (!session) return;
    if (session.activityTimer) clearTimeout(session.activityTimer);
    session.engine.kill();
    this.sessions.delete(projectId);
    this.deps.onStatusChanged({ projectId, state: 'absent' });
  }

  /** Drops the persisted droid session id so the next open spawns fresh. */
  private forgetSession(projectId: string): void {
    this.state.update((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  }

  /**
   * TODO(smith-session-id): droid stores sessions locally; after a first spawn
   * we should resolve the new session's id (newest local session whose cwd
   * matches the project path) and persist it here so a later launch can
   * `--resume`. Left as a stub until droid's local session-store layout is
   * confirmed — see spec §1 "Session id capture" and open question 2. Until
   * then every spawn is fresh and `--resume` only fires if an id was recorded
   * by some other path.
   */
  recordSessionId(projectId: string, droidSessionId: string): void {
    this.state.update((current) => ({ ...current, [projectId]: { droidSessionId } }));
  }

  closeAll(): void {
    for (const [, session] of this.sessions) {
      if (session.activityTimer) clearTimeout(session.activityTimer);
      session.engine.kill();
    }
    this.sessions.clear();
  }
}
