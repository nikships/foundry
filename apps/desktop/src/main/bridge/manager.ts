/**
 * BridgeManager — one local CLIProxyAPI child for the app process.
 *
 * The Bridge is what turns an operator's Claude/ChatGPT/Gemini/Kimi/Grok
 * subscription into an OpenAI- or Anthropic-shaped endpoint pi can call. It is
 * started at app launch through `ensure()`, binds 127.0.0.1 inside 37700–37799
 * (scan-up on busy), writes its own merged config and auth directory under
 * Foundry's support dir, and reports ready only after the port accepts a
 * connection.
 *
 * Once `ensure()` has been asked to keep the Bridge up, the manager supervises
 * it for the rest of the app lifetime: an unexpected exit or a dead listen
 * socket schedules a respawn with backoff, and a watchdog probes the port so a
 * silent hang does not leave agents on a dead proxy. `shutdown()` is the only
 * path that stops that supervision — a quit must still leave no orphan.
 *
 * Concurrent `ensure()` calls share one in-flight attempt, spawn and health are
 * injected seams so a test drives the real object, and failure returns
 * `{ok:false, reason}` rather than throwing — a Bridge that will not start must
 * degrade the model list, not crash the app.
 *
 * Ownership is worth stating: the Bridge is app-scoped while traces are
 * per-project and per-run. Its `processes` row is therefore written with a null
 * run id — see `BRIDGE_PROCESS_NAME` below.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnEnv } from '../system/env.js';
import { isAlive, terminate } from '../system/procs.js';
import { renderBridgeConfig, BRIDGE_HOST } from './config.js';
import { bridgeAuthDir, bridgeBinaryPath, bridgeConfigPath, bridgeStateDir } from './paths.js';

/** The loopback port band this app claims for the Bridge. */
export const BRIDGE_PORT_MIN = 37_700;
export const BRIDGE_PORT_MAX = 37_799;
export const DEFAULT_BRIDGE_PORT = 37_717;

/** How long ensure() waits for the child to accept TCP after spawn. */
export const BRIDGE_HEALTH_TIMEOUT_MS = 15_000;

/** First delay before an unexpected-exit respawn. Doubles up to the max. */
export const BRIDGE_RESPAWN_BASE_MS = 500;

/** Cap on respawn backoff so a flapping child is still recovered promptly. */
export const BRIDGE_RESPAWN_MAX_MS = 30_000;

/** How often a supervised Bridge is probed while the app wants it up. */
export const BRIDGE_WATCHDOG_MS = 5_000;

/** Retained stderr from the child, for the exit warning. */
const STDERR_TAIL_CHARS = 4_000;

/**
 * The `name` every Bridge `processes` row carries.
 *
 * The row is written with a **null** run id, because the Bridge outlives every
 * run and belongs to none. That is not a cosmetic choice: `processes.run_id`
 * has a foreign key to `runs`, so a synthetic id would be rejected outright,
 * and every per-run query (`WHERE run_id = ?`, including retention's delete and
 * the kill-by-run path) skips a null. What still reaches the row is the
 * relaunch sweep's unfiltered `openProcesses()`, which is exactly the caller
 * that should: a Bridge orphaned by a crash gets its row closed.
 */
export const BRIDGE_PROCESS_NAME = 'bridge';

export type BridgeUnavailableReason =
  'binary_missing' | 'spawn_failed' | 'port_exhausted' | 'health_timeout';

export interface BridgeStatus {
  running: boolean;
  port: number | null;
  pid: number | null;
  /** Present when the last start attempt failed. */
  reason?: BridgeUnavailableReason;
  detail?: string;
}

export type BridgeEnsureResult =
  | { ok: true; port: number; pid: number; baseUrl: string; command: string }
  | { ok: false; reason: BridgeUnavailableReason; detail: string };

export type BridgeSpawnFn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
) => ChildProcess;

export interface BridgeProcessInfo {
  pid: number;
  port: number;
  command: string;
}

export interface BridgeExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface BridgeManagerOptions {
  /** Foundry's Application Support directory; config and auth live under it. */
  supportDir: string;
  /** Preferred port; scan-up within the band when busy. */
  port?: number;
  /** Test seam: the vendored binary's path (defaults to the resolved one). */
  binaryPath?: string | null;
  /** Test seam: replace child spawn. */
  spawn?: BridgeSpawnFn;
  /** Test seam: replace the TCP health probe. */
  isPortOpen?: (port: number) => Promise<boolean>;
  healthTimeoutMs?: number;
  healthPollMs?: number;
  /** Test seam: first respawn delay after an unexpected exit. */
  respawnBaseMs?: number;
  /** Test seam: respawn backoff ceiling. */
  respawnMaxMs?: number;
  /** Test seam: watchdog interval while supervised. */
  watchdogMs?: number;
  debug?: boolean;
  /** Invoked once when the child is first recorded (wire to tracer.recordProcess). */
  onProcess?: (info: BridgeProcessInfo) => void;
  /**
   * Invoked when a child this manager reported through `onProcess` has been
   * killed, so its row can be closed. Paired with `onProcess`: exactly one call
   * per reported child, and none for a child that was never reported.
   */
  onProcessEnd?: () => void;
  /**
   * Invoked whenever a child becomes healthy — the first start and every
   * supervised respawn. The service regenerates models.json here so a port
   * change after scan-up cannot leave the picker pointing at a dead endpoint.
   */
  onBecameReady?: (info: BridgeProcessInfo) => void;
  /** Invoked when a supervised child exits without `shutdown()` / `killChild`. */
  onUnexpectedExit?: (info: BridgeExitInfo) => void;
  /** Observability for tests asserting what argv the Bridge is started with. */
  onSpawnAttempt?: (argv: string[]) => void;
}

export class BridgeManager {
  private child: ChildProcess | null = null;
  private activePort: number | null = null;
  private argv: string[] = [];
  /** The pid whose `processes` row is open, so a restart cannot leave two. */
  private recordedPid: number | null = null;
  private ensuring: Promise<BridgeEnsureResult> | null = null;
  private lastFailure: { reason: BridgeUnavailableReason; detail: string } | null = null;
  /**
   * Set by `ensure()` and cleared only by `shutdown()`. While true, unexpected
   * exits and a failed listen probe schedule a respawn rather than staying down.
   */
  private wanted = false;
  private respawnAttempt = 0;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private stderrTail = '';

  constructor(private readonly opts: BridgeManagerOptions) {}

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get port(): number | null {
    return this.activePort;
  }

  /** The URL pi's models point at, or null when the Bridge is not up. */
  get baseUrl(): string | null {
    return this.activePort ? `http://${BRIDGE_HOST}:${this.activePort}` : null;
  }

  get running(): boolean {
    const pid = this.child?.pid;
    return !!pid && isAlive(pid);
  }

  /** Where CLIProxyAPI writes one JSON file per authenticated account. */
  get authDir(): string {
    return bridgeAuthDir(this.opts.supportDir);
  }

  /** Argv of the running (or last) spawn — for tracer.recordProcess. */
  spawnArgs(): string[] {
    return [...this.argv];
  }

  status(): BridgeStatus {
    if (this.running) {
      return { running: true, port: this.activePort, pid: this.child?.pid ?? null };
    }
    return {
      running: false,
      port: null,
      pid: null,
      ...(this.lastFailure ?? {}),
    };
  }

  /**
   * The vendored binary, or null when it was never fetched or failed its
   * checksum. Auth flows need it too, so it is resolved once here.
   */
  binary(): string | null {
    return this.opts.binaryPath !== undefined ? this.opts.binaryPath : bridgeBinaryPath();
  }

  /**
   * Start the Bridge and keep it up for the rest of the app lifetime.
   * Concurrent callers share one in-flight attempt, so two paths cannot
   * produce two children. Never throws.
   */
  ensure(): Promise<BridgeEnsureResult> {
    this.wanted = true;
    this.armWatchdog();
    if (this.running && this.activePort && this.child?.pid) {
      return Promise.resolve(this.ready(this.activePort, this.child.pid));
    }
    if (this.ensuring) return this.ensuring;
    this.clearRespawnTimer();
    this.ensuring = this.start().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  /** Stop supervision, then SIGTERM / SIGKILL. Idempotent. */
  async shutdown(): Promise<void> {
    this.wanted = false;
    this.clearRespawnTimer();
    this.clearWatchdog();
    await this.killChild();
    this.argv = [];
  }

  private async start(): Promise<BridgeEnsureResult> {
    // Drop a half-open previous attempt before retrying. killChild nulls
    // `this.child` first so the previous exit handler does not schedule a
    // respawn for an intentional stop.
    await this.killChild();

    const binary = this.binary();
    if (!binary) {
      return this.fail(
        'binary_missing',
        'run `npm run fetch:bridge` (a failed checksum leaves nothing on disk)',
      );
    }

    const preferred = clampPort(this.opts.port ?? DEFAULT_BRIDGE_PORT);
    const probe = this.opts.isPortOpen ?? isPortOpen;
    const port = await findFreePort(preferred, probe);
    if (port === null) {
      return this.fail(
        'port_exhausted',
        `no free port in ${BRIDGE_PORT_MIN}-${BRIDGE_PORT_MAX} from ${preferred}`,
      );
    }

    const configPath = this.writeConfig(port);
    const args = ['-config', configPath];
    this.argv = [binary, ...args];
    this.opts.onSpawnAttempt?.(this.argv);

    let child: ChildProcess;
    try {
      const spawnFn = this.opts.spawn ?? spawn;
      child = spawnFn(binary, args, {
        env: spawnEnv(),
        // Pipes stay attached so an unexpected exit can be diagnosed from the
        // child's own stderr. The Bridge stays in Foundry's process group
        // (`detached: false`) so a quit reaps it rather than leaving a proxy
        // that still holds subscription credentials on a loopback port.
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (error) {
      return this.fail('spawn_failed', errorMessage(error));
    }

    this.child = child;
    this.stderrTail = '';
    this.attachStderr(child);
    const spawnError = await waitForSpawnError(child);
    if (spawnError) {
      this.child = null;
      return this.fail('spawn_failed', spawnError);
    }
    if (!child.pid) {
      this.child = null;
      return this.fail('spawn_failed', 'bridge child has no pid');
    }

    const healthy = await waitForListen(
      port,
      probe,
      this.opts.healthTimeoutMs ?? BRIDGE_HEALTH_TIMEOUT_MS,
      this.opts.healthPollMs ?? 100,
    );
    if (!healthy) {
      await this.killChild();
      return this.fail(
        'health_timeout',
        `the Bridge did not accept connections on ${BRIDGE_HOST}:${port} within timeout`,
      );
    }

    this.activePort = port;
    this.lastFailure = null;
    this.respawnAttempt = 0;
    // Every healthy child gets its own row and exit handler. A respawn must not
    // skip recording because the previous close raced the new pid.
    if (this.recordedPid !== null && this.recordedPid !== child.pid) {
      this.closeRecordedRow();
    }
    if (this.recordedPid !== child.pid) {
      this.recordedPid = child.pid;
      this.opts.onProcess?.({ pid: child.pid, port, command: this.argv.join(' ') });
    }
    child.once('exit', (code, signal) => this.handleChildExit(child, code, signal));
    this.opts.onBecameReady?.({ pid: child.pid, port, command: this.argv.join(' ') });
    return this.ready(port, child.pid);
  }

  private handleChildExit(
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    // Intentional stops null `this.child` before signalling, so the exit of a
    // killed child is not treated as a crash that needs a respawn.
    const unexpected = this.child === child;
    if (unexpected) {
      this.child = null;
      this.activePort = null;
    }
    if (this.recordedPid === child.pid) this.closeRecordedRow();
    if (!unexpected || !this.wanted) return;

    const info: BridgeExitInfo = { code, signal, stderr: this.stderrTail.trim() };
    this.opts.onUnexpectedExit?.(info);
    console.warn(
      `[bridge] exited unexpectedly (code=${code ?? 'none'} signal=${signal ?? 'none'})` +
        (info.stderr ? `; stderr: ${truncate(info.stderr, 500)}` : ''),
    );
    this.scheduleRespawn();
  }

  private attachStderr(child: ChildProcess): void {
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.stderrTail = `${this.stderrTail}${text}`.slice(-STDERR_TAIL_CHARS);
    });
    // Avoid buffering forever if nobody reads stdout.
    child.stdout?.resume();
  }

  private scheduleRespawn(): void {
    if (!this.wanted || this.respawnTimer || this.ensuring) return;
    const base = this.opts.respawnBaseMs ?? BRIDGE_RESPAWN_BASE_MS;
    const max = this.opts.respawnMaxMs ?? BRIDGE_RESPAWN_MAX_MS;
    const delay = Math.min(base * 2 ** this.respawnAttempt, max);
    this.respawnAttempt += 1;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (!this.wanted) return;
      void this.ensure().then((result) => {
        if (!result.ok) this.scheduleRespawn();
      });
    }, delay);
  }

  private armWatchdog(): void {
    if (this.watchdogTimer) return;
    const interval = this.opts.watchdogMs ?? BRIDGE_WATCHDOG_MS;
    this.watchdogTimer = setInterval(() => {
      void this.watch();
    }, interval);
  }

  private async watch(): Promise<void> {
    if (!this.wanted || this.ensuring || this.respawnTimer) return;
    if (this.running && this.activePort !== null) {
      const probe = this.opts.isPortOpen ?? isPortOpen;
      if (await probe(this.activePort)) return;
      console.warn(
        `[bridge] watchdog: ${BRIDGE_HOST}:${this.activePort} is not accepting connections; restarting`,
      );
    } else if (this.running) {
      return;
    }
    // Wanted but not serving: recover without waiting for the next agent turn.
    void this.ensure();
  }

  private clearRespawnTimer(): void {
    if (!this.respawnTimer) return;
    clearTimeout(this.respawnTimer);
    this.respawnTimer = null;
  }

  private clearWatchdog(): void {
    if (!this.watchdogTimer) return;
    clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private ready(port: number, pid: number): BridgeEnsureResult {
    return {
      ok: true,
      port,
      pid,
      baseUrl: `http://${BRIDGE_HOST}:${port}`,
      command: this.argv.join(' '),
    };
  }

  /**
   * Write the merged config for this port. The auth directory is created here
   * too: CLIProxyAPI will create it itself, but the auth watcher wants
   * something to watch before the first login.
   */
  private writeConfig(port: number): string {
    const stateDir = bridgeStateDir(this.opts.supportDir);
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(this.authDir, { recursive: true });
    const path = bridgeConfigPath(this.opts.supportDir);
    writeFileSync(
      path,
      renderBridgeConfig({ port, authDir: this.authDir, debug: this.opts.debug }),
      // The config names the auth directory holding OAuth material; there is no
      // reason for any other user on the machine to read it.
      { mode: 0o600 },
    );
    return path;
  }

  private fail(reason: BridgeUnavailableReason, detail: string): BridgeEnsureResult {
    this.lastFailure = { reason, detail };
    return { ok: false, reason, detail };
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.activePort = null;
    const pid = child?.pid;
    if (!pid) {
      this.closeRecordedRow();
      return;
    }
    const gone = await terminate(pid);
    // A pid that survived SIGKILL is still holding its port, and closing its
    // row would hide it from the one sweep that could reclaim it.
    if (gone) this.closeRecordedRow();
  }

  /** Closes the open row, if any. Idempotent: at most one call per child. */
  private closeRecordedRow(): void {
    if (this.recordedPid === null) return;
    this.recordedPid = null;
    this.opts.onProcessEnd?.();
  }
}

function clampPort(port: number): number {
  if (!Number.isFinite(port)) return DEFAULT_BRIDGE_PORT;
  return Math.min(Math.max(Math.round(port), BRIDGE_PORT_MIN), BRIDGE_PORT_MAX);
}

async function findFreePort(
  preferred: number,
  probe: (port: number) => Promise<boolean>,
): Promise<number | null> {
  for (let port = preferred; port <= BRIDGE_PORT_MAX; port++) {
    if (!(await probe(port))) return port;
  }
  return null;
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: BRIDGE_HOST });
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

async function waitForListen(
  port: number,
  probe: (port: number) => Promise<boolean>,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe(port)) return true;
    await sleep(pollMs);
  }
  return probe(port);
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
    child.once('spawn', () => finish(null));
    setTimeout(() => finish(null), 50);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}
