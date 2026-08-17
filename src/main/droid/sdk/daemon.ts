/**
 * DaemonManager — one local `droid daemon` for the app process.
 *
 * Lazily spawns on first ensure(), binds 127.0.0.1 inside 37600–37699
 * (preferred port from AppSettings.daemonPort, scan-up on busy), authenticates
 * via resolveDaemonAuth, and holds a single ConnectedDroid multiplexed across
 * agent sessions. Spawn/connect/auth failure returns `{ok:false, reason}` so
 * callers can fall back to subprocess — a run never dies because the daemon
 * did not come up.
 *
 * `--parent-pid` is the crash backstop; shutdown() is the clean path
 * (disconnect + SIGTERM). Never writes ~/.factory.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  connectToDaemon as sdkConnectToDaemon,
  type ConnectedDroid,
  type ConnectedDroidSession,
  type ConnectToDaemonOptions,
} from '@factory/droid-sdk';
import type {
  AskUserRequestParams,
  AskUserResult,
  RequestPermissionHandlerResult,
  RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import { spawnEnv } from '../../system/env.js';
import { isAlive, killTree } from '../../system/procs.js';
import {
  resolveDaemonAuth,
  type DaemonAuthCredential,
  type ResolveDaemonAuthOptions,
} from './auth.js';
import {
  failClosedAskUserHandler,
  failClosedPermissionHandler,
  type DaemonHandle,
  type DaemonSessionsFacade,
  type DaemonStreamMessage,
} from './daemon-session.js';
import type { DroidNotification } from '../protocol.js';
import type { ContextBreakdown } from '@shared/types.js';

export {
  DaemonSession,
  DAEMON_AUTONOMY,
  failClosedAskUserHandler,
  failClosedPermissionHandler,
} from './daemon-session.js';
export type {
  DaemonHandle,
  DaemonSessionOptions,
  DaemonSessionsFacade,
  DaemonStreamMessage,
} from './daemon-session.js';

/** Mission-bounded daemon port band. */
export const DAEMON_PORT_MIN = 37_600;
export const DAEMON_PORT_MAX = 37_699;
export const DEFAULT_DAEMON_PORT = 37_643;

/** How long ensure() waits for the child to accept TCP after spawn. */
export const DAEMON_HEALTH_TIMEOUT_MS = 10_000;

export type DaemonUnavailableReason =
  | 'auth_missing'
  | 'auth_rejected'
  | 'spawn_failed'
  | 'connect_failed'
  | 'port_exhausted'
  | 'health_timeout';

export type DaemonEnsureResult =
  | { ok: true; droid: DaemonConnection; port: number; pid: number; command: string }
  | { ok: false; reason: DaemonUnavailableReason; detail: string };

/**
 * Surface DaemonManager + DaemonSession need from a ConnectedDroid. Tests
 * inject a fake; production uses the real SDK connection with fail-closed
 * connection-level handlers and a sessions facade.
 */
export interface DaemonConnection {
  disconnect(): void;
  /** Present once connected; DaemonSession multiplexes agent sessions over it. */
  sessions?: DaemonSessionsFacade;
}

export type ConnectToDaemonFn = (
  options: Pick<ConnectToDaemonOptions, 'url' | 'auth' | 'onError' | 'onAuthenticationError'>,
) => Promise<DaemonConnection>;

export interface DaemonProcessInfo {
  pid: number;
  port: number;
  command: string;
}

export type DaemonSpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
) => ChildProcess;

export interface DaemonManagerOptions {
  droidPath: string;
  /** Preferred port from AppSettings.daemonPort; scan-up within the band if busy. */
  port: number;
  /** Defaults to `process.pid` so the daemon dies with the app. */
  parentPid?: number;
  /** Test seam: replace the real SDK connect. */
  connect?: ConnectToDaemonFn;
  /** Test seam: replace credential resolution. */
  resolveAuth?: (opts?: ResolveDaemonAuthOptions) => DaemonAuthCredential | null;
  /** Invoked once when the daemon child is first recorded (wire to tracer.recordProcess). */
  onProcess?: (info: DaemonProcessInfo) => void;
  /** Observability for tests that assert we never spawn without auth. */
  onSpawnAttempt?: (argv: string[]) => void;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  /** Test seam: replace child spawn (defaults to node:child_process spawn). */
  spawn?: DaemonSpawnFn;
}

let singleton: DaemonManager | null = null;

/** App-lifetime singleton. Created on first call; subsequent calls reuse it. */
export function getDaemonManager(opts?: DaemonManagerOptions): DaemonManager {
  if (!singleton) {
    if (!opts) throw new Error('DaemonManager is not initialised');
    singleton = new DaemonManager(opts);
  }
  return singleton;
}

/** Disconnect + SIGTERM; clears the singleton. Safe when never started. */
export async function shutdownDaemonManager(): Promise<void> {
  if (!singleton) return;
  await singleton.shutdown();
  singleton = null;
}

/** Test-only: drop the singleton reference (call shutdown on the instance first). */
export function __resetDaemonManagerForTests(): void {
  singleton = null;
}

export class DaemonManager {
  private child: ChildProcess | null = null;
  private droid: DaemonConnection | null = null;
  private activePort: number | null = null;
  private activeCommand: string | null = null;
  private argv: string[] = [];
  private recorded = false;
  private ensuring: Promise<DaemonEnsureResult> | null = null;

  constructor(private readonly opts: DaemonManagerOptions) {}

  /** The live connection, or null when unavailable / shut down. */
  get connection(): DaemonConnection | null {
    return this.droid;
  }

  get pid(): number | undefined {
    return this.child?.pid ?? undefined;
  }

  get port(): number | null {
    return this.activePort;
  }

  /** Argv of the running (or last) daemon spawn — for tracer.recordProcess. */
  spawnArgs(): string[] {
    return [...this.argv];
  }

  /**
   * Lazily start the daemon and authenticate. Concurrent callers share one
   * in-flight attempt. Failures never throw — they return `{ok:false}`.
   */
  ensure(): Promise<DaemonEnsureResult> {
    if (this.droid && this.child?.pid && isAlive(this.child.pid)) {
      return Promise.resolve({
        ok: true,
        droid: this.droid,
        port: this.activePort!,
        pid: this.child.pid,
        command: this.activeCommand ?? this.argv.join(' '),
      });
    }
    if (this.ensuring) return this.ensuring;
    this.ensuring = this.start().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  /** disconnect + SIGTERM. Idempotent. */
  async shutdown(): Promise<void> {
    const droid = this.droid;
    this.droid = null;
    try {
      droid?.disconnect();
    } catch {
      // Disconnect errors must not block the kill.
    }

    const child = this.child;
    this.child = null;
    const pid = child?.pid;
    if (pid && isAlive(pid)) {
      killTree(pid, 'SIGTERM');
      const deadline = Date.now() + 3_000;
      while (isAlive(pid) && Date.now() < deadline) await sleep(50);
      if (isAlive(pid)) killTree(pid, 'SIGKILL');
    }
    this.activePort = null;
    this.activeCommand = null;
    this.argv = [];
    this.recorded = false;
  }

  private async start(): Promise<DaemonEnsureResult> {
    // Drop a half-open previous attempt before retrying.
    await this.shutdown();

    const auth = (this.opts.resolveAuth ?? resolveDaemonAuth)();
    if (!auth) {
      return {
        ok: false,
        reason: 'auth_missing',
        detail:
          'no Factory API key in Settings, no FACTORY_API_KEY, and no decryptable stored auth' +
          ' (turn on Settings → Agent CLI → Airgap mode to run BYOK models without one)',
      };
    }

    const preferred = clampPort(this.opts.port);
    const port = await findFreePort(preferred);
    if (port === null) {
      return {
        ok: false,
        reason: 'port_exhausted',
        detail: `no free port in ${DAEMON_PORT_MIN}-${DAEMON_PORT_MAX} from ${preferred}`,
      };
    }

    const parentPid = this.opts.parentPid ?? process.pid;
    const args = [
      'daemon',
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--parent-pid',
      String(parentPid),
    ];
    this.argv = [this.opts.droidPath, ...args];
    this.opts.onSpawnAttempt?.(this.argv);

    let child: ChildProcess;
    try {
      const spawnFn = this.opts.spawn ?? spawn;
      child = spawnFn(this.opts.droidPath, args, {
        env: spawnEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'spawn_failed',
        detail: errorMessage(error),
      };
    }

    this.child = child;
    const spawnError = await waitForSpawnError(child);
    if (spawnError) {
      this.child = null;
      return { ok: false, reason: 'spawn_failed', detail: spawnError };
    }
    if (!child.pid) {
      this.child = null;
      return { ok: false, reason: 'spawn_failed', detail: 'daemon child has no pid' };
    }

    const healthy = await waitForListen(
      port,
      this.opts.healthTimeoutMs ?? DAEMON_HEALTH_TIMEOUT_MS,
      this.opts.healthPollMs ?? 100,
    );
    if (!healthy) {
      await this.killChildOnly();
      return {
        ok: false,
        reason: 'health_timeout',
        detail: `daemon did not accept connections on 127.0.0.1:${port} within timeout`,
      };
    }

    const connect = this.opts.connect ?? defaultConnect;
    try {
      const droid = await connect({
        url: `ws://127.0.0.1:${port}`,
        auth: { apiKey: auth.apiKey },
      });
      this.droid = droid;
      this.activePort = port;
      this.activeCommand = this.argv.join(' ');
      if (!this.recorded) {
        this.recorded = true;
        this.opts.onProcess?.({
          pid: child.pid,
          port,
          command: this.activeCommand,
        });
      }
      return {
        ok: true,
        droid,
        port,
        pid: child.pid,
        command: this.activeCommand,
      };
    } catch (error) {
      await this.killChildOnly();
      if (isAuthRejected(error)) {
        return {
          ok: false,
          reason: 'auth_rejected',
          detail: errorMessage(error) || 'daemon authentication rejected',
        };
      }
      return {
        ok: false,
        reason: 'connect_failed',
        detail: errorMessage(error) || 'failed to connect to daemon',
      };
    }
  }

  private async killChildOnly(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.droid = null;
    this.activePort = null;
    const pid = child?.pid;
    if (pid && isAlive(pid)) {
      killTree(pid, 'SIGTERM');
      const deadline = Date.now() + 2_000;
      while (isAlive(pid) && Date.now() < deadline) await sleep(40);
      if (isAlive(pid)) killTree(pid, 'SIGKILL');
    }
  }
}

async function defaultConnect(
  options: Pick<ConnectToDaemonOptions, 'url' | 'auth' | 'onError' | 'onAuthenticationError'>,
): Promise<DaemonConnection> {
  // Connection-level handlers are a fail-closed safety net only. Per-session
  // handlers attached at sessions.create/resume fully override them and receive
  // only their own session's asks (spike V6). Anything that still reaches here
  // — missing handler, missing/mismatched associatedSessionIds — is denied.
  const droid: ConnectedDroid = await sdkConnectToDaemon({
    ...options,
    permissionHandler: failClosedPermissionHandler,
    askUserHandler: failClosedAskUserHandler,
  });
  return adaptConnectedDroid(droid);
}

/**
 * Wrap the SDK ConnectedDroid so DaemonSession sees a stable facade, including
 * raw notification subscription (tapped off the session controller the public
 * ConnectedDroidSession type does not expose).
 */
export function adaptConnectedDroid(droid: ConnectedDroid): DaemonConnection {
  const sessions: DaemonSessionsFacade = {
    // SdkMcpServer is accepted at runtime by create/resume; the public daemon
    // option type only lists wire shapes. Cast at the boundary.
    create: async (options) =>
      adaptHandle(
        await droid.sessions.create(options as Parameters<ConnectedDroid['sessions']['create']>[0]),
      ),
    resume: async (sessionId, options) =>
      adaptHandle(
        await droid.sessions.resume(
          sessionId,
          options as Parameters<ConnectedDroid['sessions']['resume']>[1],
        ),
      ),
    updateSettings: (sessionId, params) => droid.sessions.updateSettings(sessionId, params),
    getContextBreakdown: async (sessionId) => {
      const raw = await droid.sessions.getContextBreakdown(sessionId);
      return raw as ContextBreakdown;
    },
    getRewindInfo: async (sessionId, messageId) => {
      const info = await droid.sessions.getRewindInfo(sessionId, messageId);
      return {
        availableFiles: info.availableFiles.map((file) => ({
          filePath: file.filePath,
          contentHash: file.contentHash,
          size: file.size,
        })),
        createdFiles: info.createdFiles.map((file) => ({ filePath: file.filePath })),
        evictedFiles: info.evictedFiles.map((file) => ({
          filePath: file.filePath,
          reason: file.reason,
        })),
      };
    },
  };
  return {
    disconnect: () => droid.disconnect(),
    sessions,
  };
}

function adaptHandle(session: ConnectedDroidSession): DaemonHandle {
  return {
    id: session.id,
    settings: session.settings as Readonly<Record<string, unknown>>,
    cwd: session.cwd,
    stream: (prompt, options) =>
      session.stream(prompt, options) as AsyncIterable<DaemonStreamMessage>,
    interrupt: () => session.interrupt(),
    compact: async (customInstructions) => {
      const outcome = await session.compact(customInstructions);
      return {
        newSessionId: outcome.newSessionId,
        removedCount: outcome.removedCount,
      };
    },
    rewind: async (params) => {
      const outcome = await session.rewind(params);
      return {
        newSessionId: outcome.newSessionId,
        restoredCount: outcome.restoredCount,
        deletedCount: outcome.deletedCount,
        failedRestoreCount: outcome.failedRestoreCount,
        failedDeleteCount: outcome.failedDeleteCount,
      };
    },
    detach: () => session.detach(),
    close: () => session.close(),
    subscribeNotifications: (handler) => subscribeSessionNotifications(session, handler),
  };
}

/**
 * ConnectedDroidSession does not expose onNotification. The runtime handle
 * keeps a `controller` EventEmitter that fans out `sessionNotification` with
 * the inner payload — the same shape EventFolder.absorb expects. Pin the
 * access so a future SDK that hides the field fails loudly at subscribe time
 * rather than silently dropping the trace stream.
 */
function subscribeSessionNotifications(
  session: ConnectedDroidSession,
  handler: (n: DroidNotification) => void,
): () => void {
  const controller = readSessionController(session);
  if (!controller) return () => undefined;
  const listener = (event: unknown): void => {
    if (!event || typeof event !== 'object') return;
    const payload = event as { sessionId?: string; notification?: DroidNotification };
    if (payload.sessionId !== session.id || !payload.notification) return;
    handler(payload.notification);
  };
  controller.on('sessionNotification', listener);
  return () => controller.off('sessionNotification', listener);
}

interface SessionController {
  on(event: string, listener: (event: unknown) => void): void;
  off(event: string, listener: (event: unknown) => void): void;
}

function readSessionController(session: ConnectedDroidSession): SessionController | null {
  if (!('controller' in session)) return null;
  const controller = (session as { controller?: unknown }).controller;
  if (!controller || typeof controller !== 'object') return null;
  const candidate = controller as Partial<SessionController>;
  if (typeof candidate.on !== 'function' || typeof candidate.off !== 'function') return null;
  return candidate as SessionController;
}

// Re-export handler param types used by tests that assert wire replies.
export type {
  AskUserRequestParams,
  AskUserResult,
  RequestPermissionHandlerResult,
  RequestPermissionRequestParams,
};

function clampPort(port: number): number {
  if (!Number.isFinite(port)) return DEFAULT_DAEMON_PORT;
  const n = Math.round(port);
  if (n < DAEMON_PORT_MIN) return DAEMON_PORT_MIN;
  if (n > DAEMON_PORT_MAX) return DAEMON_PORT_MAX;
  return n;
}

async function findFreePort(preferred: number): Promise<number | null> {
  for (let port = preferred; port <= DAEMON_PORT_MAX; port++) {
    if (!(await isPortOpen(port))) return port;
  }
  return null;
}

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host });
    const done = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(200, () => done(false));
  });
}

async function waitForListen(port: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await sleep(pollMs);
  }
  return isPortOpen(port);
}

function waitForSpawnError(child: ChildProcess): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (detail: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(detail);
    };
    child.once('error', (err) => finish(errorMessage(err)));
    // A successful spawn emits 'spawn' (node 15+); fall back to a short tick.
    child.once('spawn', () => finish(null));
    setTimeout(() => finish(null), 50);
  });
}

function isAuthRejected(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const reason = (error as { reason?: unknown }).reason;
  return reason === 'auth_rejected';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
