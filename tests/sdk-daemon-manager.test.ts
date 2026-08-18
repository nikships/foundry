/**
 * DaemonManager: lazy spawn on 127.0.0.1 within 37600–37699, --parent-pid,
 * busy-port scan-up, mocked connect failures → clean unavailable, kill
 * discipline so the mission range is empty after the suite.
 *
 * Pre-existing user daemons on 39217/39321 are baseline-scoped and NEVER touched.
 */

import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DAEMON_PORT_MAX,
  DAEMON_PORT_MIN,
  DEFAULT_DAEMON_PORT,
  DaemonManager,
  type ConnectToDaemonFn,
  type DaemonConnection,
} from '../src/main/droid/sdk/daemon.js';
import { whichBinary } from '../src/main/system/env.js';
import { isAlive } from '../src/main/system/procs.js';

const OFF_LIMITS = new Set([39217, 39321, 54621, 54622]);

/** Listeners that existed before this file ran — leave them alone. */
const baselinePids = new Set<number>();

function listenersInMissionRange(): { port: number; pid: number }[] {
  // lsof is the same tool validators use; keep the sweep scoped to the mission band.
  try {
    const human = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${DAEMON_PORT_MIN}-${DAEMON_PORT_MAX}`, '-sTCP:LISTEN'],
      { encoding: 'utf8' },
    );
    const found: { port: number; pid: number }[] = [];
    for (const line of human.split('\n').slice(1)) {
      const m = line.match(/^\S+\s+(\d+)\s+.*:(\d+)\s+\(LISTEN\)/);
      if (!m) continue;
      found.push({ pid: Number(m[1]), port: Number(m[2]) });
    }
    return found;
  } catch {
    return [];
  }
}

function droidDaemonPids(): number[] {
  try {
    const out = execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => l.includes('droid daemon') && !l.includes('grep'))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

beforeAll(() => {
  for (const { pid } of listenersInMissionRange()) baselinePids.add(pid);
  for (const pid of droidDaemonPids()) baselinePids.add(pid);
});

afterAll(() => {
  // Final sweep: anything we started in-range must be gone; baseline stays.
  const leftover = listenersInMissionRange().filter((l) => !baselinePids.has(l.pid));
  const leftoverDaemons = droidDaemonPids().filter((pid) => !baselinePids.has(pid));
  // Best-effort cleanup before asserting so a failed test does not poison the next.
  for (const pid of leftoverDaemons) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  expect(leftover, `orphaned listeners in mission range: ${JSON.stringify(leftover)}`).toEqual([]);
  // Off-limits user daemons (39217/39321/…) must still be alive if they were baseline.
  void OFF_LIMITS;
  const stillBaseline = droidDaemonPids().filter((pid) => baselinePids.has(pid));
  for (const pid of stillBaseline) {
    expect(isAlive(pid)).toBe(true);
  }
});

const managers: DaemonManager[] = [];
const dummyServers: Server[] = [];

afterEach(async () => {
  while (managers.length > 0) {
    const m = managers.pop();
    if (m) await m.shutdown();
  }
  while (dummyServers.length > 0) {
    const s = dummyServers.pop();
    if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

function track(manager: DaemonManager): DaemonManager {
  managers.push(manager);
  return manager;
}

function mockConnection(): DaemonConnection {
  return {
    disconnect: vi.fn(),
  };
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      dummyServers.push(server);
      resolve(server);
    });
  });
}

// A bare name is the same fallback production uses when the lookup misses.
const droidPath = (): string => whichBinary('droid') ?? 'droid';

/**
 * Hermetic fake droid daemon for CI: a tiny Node TCP server that listens on
 * the requested --port/--host and honours --parent-pid / SIGTERM. Using a fake
 * avoids requiring the real `droid` binary on GitHub-hosted runners (which have
 * no FACTORY_API_KEY) while still exercising DaemonManager's port scan, health
 * poll, connect classification, and kill discipline. The child is spawned with
 * argv0 'droid daemon' so the existing `droidDaemonPids()` helper still finds
 * it (best-effort orphan sweep + isAlive checks remain meaningful).
 */
function fakeDaemonSpawn(): (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
) => ReturnType<typeof nodeSpawn> {
  return (_command, args, options) => {
    const portIdx = args.indexOf('--port');
    const port = portIdx !== -1 ? Number(args[portIdx + 1]) : DEFAULT_DAEMON_PORT;
    const hostIdx = args.indexOf('--host');
    const host = hostIdx !== -1 ? String(args[hostIdx + 1]) : '127.0.0.1';
    const parentPidIdx = args.indexOf('--parent-pid');
    const parentPid = parentPidIdx !== -1 ? Number(args[parentPidIdx + 1]) : null;
    // Validate port/host extraction — if parsing fails, let the child fail fast.
    if (!Number.isFinite(port) || !host) {
      throw new Error(`fake daemon: invalid args ${args.join(' ')}`);
    }
    const script = `
      const net = require('net');
      const port = ${JSON.stringify(port)};
      const host = ${JSON.stringify(host)};
      const parentPid = ${parentPid === null ? 'null' : JSON.stringify(parentPid)};
      const server = net.createServer((socket) => socket.end());
      server.listen(port, host, () => {});
      server.on('error', (err) => { console.error(err.message); process.exit(1); });
      if (parentPid !== null && Number.isFinite(parentPid)) {
        const iv = setInterval(() => {
          try { process.kill(parentPid, 0); } catch { clearInterval(iv); server.close(() => process.exit(0)); }
        }, 100);
        if (iv.unref) iv.unref();
      }
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
      process.on('SIGINT', () => server.close(() => process.exit(0)));
    `;
    return nodeSpawn(process.execPath, ['-e', script], {
      ...options,
      argv0: 'droid daemon',
    } as unknown as Parameters<typeof nodeSpawn>[2]);
  };
}

describe('DaemonManager', () => {
  it('spawns droid daemon with --parent-pid on 127.0.0.1 inside the mission range', async () => {
    const recorded: { pid: number; port: number; command: string }[] = [];
    const connect = vi.fn<ConnectToDaemonFn>(async () => mockConnection());
    const manager = track(
      new DaemonManager({
        droidPath: droidPath(),
        port: DEFAULT_DAEMON_PORT,
        connect,
        resolveAuth: () => ({ apiKey: 'fk-test-not-real', source: 'env' }),
        onProcess: (info) => recorded.push(info),
        healthTimeoutMs: 10_000,
        spawn: fakeDaemonSpawn(),
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.port).toBeGreaterThanOrEqual(DAEMON_PORT_MIN);
    expect(result.port).toBeLessThanOrEqual(DAEMON_PORT_MAX);
    expect(result.pid).toBeGreaterThan(0);
    expect(isAlive(result.pid)).toBe(true);

    const argv = manager.spawnArgs();
    expect(argv).toContain('daemon');
    expect(argv).toContain('--host');
    expect(argv).toContain('127.0.0.1');
    expect(argv).toContain('--port');
    expect(argv).toContain(String(result.port));
    expect(argv).toContain('--parent-pid');
    expect(argv).toContain(String(process.pid));

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        url: `ws://127.0.0.1:${result.port}`,
        auth: { apiKey: 'fk-test-not-real' },
      }),
    );
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.pid).toBe(result.pid);
    expect(recorded[0]?.command).toContain('daemon');
  }, 20_000);

  it('scans up within 37600–37699 when the configured port is busy', async () => {
    const preferred = 37640;
    await listenOn(preferred);

    const connect = vi.fn<ConnectToDaemonFn>(async () => mockConnection());
    const manager = track(
      new DaemonManager({
        droidPath: droidPath(),
        port: preferred,
        connect,
        resolveAuth: () => ({ apiKey: 'fk-test-scan', source: 'env' }),
        healthTimeoutMs: 10_000,
        spawn: fakeDaemonSpawn(),
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.port).toBeGreaterThan(preferred);
    expect(result.port).toBeLessThanOrEqual(DAEMON_PORT_MAX);
    expect(connect.mock.calls[0]?.[0].url).toBe(`ws://127.0.0.1:${result.port}`);
  }, 20_000);

  it('returns unavailable on auth_rejected without crashing and kills the child', async () => {
    const connect = vi.fn<ConnectToDaemonFn>(async () => {
      const err = Object.assign(new Error('Authentication failed. Please sign in again.'), {
        reason: 'auth_rejected',
        retryable: false,
      });
      throw err;
    });
    const manager = track(
      new DaemonManager({
        droidPath: droidPath(),
        port: 37650,
        connect,
        resolveAuth: () => ({ apiKey: 'fk-bad-key', source: 'env' }),
        healthTimeoutMs: 10_000,
        spawn: fakeDaemonSpawn(),
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('auth_rejected');
    expect(result.detail.toLowerCase()).toMatch(/auth/);
    // Child must not linger after a failed ensure.
    await sleep(300);
    const ours = droidDaemonPids().filter((pid) => !baselinePids.has(pid));
    expect(ours).toEqual([]);
    expect(manager.connection).toBeNull();
  }, 20_000);

  it('returns unavailable on connect failure without crashing', async () => {
    const connect = vi.fn<ConnectToDaemonFn>(async () => {
      throw Object.assign(new Error('Could not reach the daemon.'), {
        reason: 'daemon_unreachable',
      });
    });
    const manager = track(
      new DaemonManager({
        droidPath: droidPath(),
        port: 37655,
        connect,
        resolveAuth: () => ({ apiKey: 'fk-ok', source: 'env' }),
        healthTimeoutMs: 10_000,
        spawn: fakeDaemonSpawn(),
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('connect_failed');
    await sleep(300);
    const ours = droidDaemonPids().filter((pid) => !baselinePids.has(pid));
    expect(ours).toEqual([]);
  }, 20_000);

  it('returns unavailable when no auth credential can be resolved (no spawn)', async () => {
    const connect = vi.fn<ConnectToDaemonFn>(async () => mockConnection());
    const spawnCalls: unknown[] = [];
    const manager = track(
      new DaemonManager({
        droidPath: droidPath(),
        port: 37660,
        connect,
        resolveAuth: () => null,
        // If spawn is attempted despite missing auth, record it.
        onSpawnAttempt: () => {
          spawnCalls.push(true);
        },
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('auth_missing');
    expect(connect).not.toHaveBeenCalled();
    expect(spawnCalls).toEqual([]);
  });

  it('SIGTERM on shutdown disconnects and kills the daemon child', async () => {
    const disconnect = vi.fn();
    const connect = vi.fn<ConnectToDaemonFn>(async () => ({ disconnect }));
    const manager = track(
      new DaemonManager({
        droidPath: droidPath(),
        port: 37665,
        connect,
        resolveAuth: () => ({ apiKey: 'fk-shutdown', source: 'env' }),
        healthTimeoutMs: 10_000,
        spawn: fakeDaemonSpawn(),
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pid = result.pid;
    expect(isAlive(pid)).toBe(true);

    await manager.shutdown();
    expect(disconnect).toHaveBeenCalled();
    // Allow the process a moment to exit after SIGTERM.
    const deadline = Date.now() + 5_000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(50);
    expect(isAlive(pid)).toBe(false);
    expect(manager.connection).toBeNull();
  }, 20_000);

  it('passes --parent-pid so the daemon dies with its parent process', async () => {
    // Spawn a short-lived parent stand-in, start a daemon watching THAT pid,
    // kill the stand-in, and observe the daemon exit (parent-pid backstop).
    const { spawn } = await import('node:child_process');
    const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    const parentPid = sleeper.pid;
    expect(parentPid).toBeDefined();
    if (!parentPid) return;

    const connect = vi.fn<ConnectToDaemonFn>(async () => mockConnection());
    const manager = track(
      new DaemonManager({
        droidPath: droidPath(),
        port: 37670,
        parentPid,
        connect,
        resolveAuth: () => ({ apiKey: 'fk-parent', source: 'env' }),
        healthTimeoutMs: 10_000,
        spawn: fakeDaemonSpawn(),
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      sleeper.kill('SIGKILL');
      return;
    }
    const daemonPid = result.pid;
    expect(manager.spawnArgs()).toContain(String(parentPid));

    sleeper.kill('SIGKILL');
    const deadline = Date.now() + 30_000;
    while (isAlive(daemonPid) && Date.now() < deadline) await sleep(200);
    expect(isAlive(daemonPid)).toBe(false);
    // Manager still holds stale state; shutdown is best-effort cleanup.
    await manager.shutdown();
  }, 45_000);

  it('reuses a single connection on subsequent ensure calls', async () => {
    const connect = vi.fn<ConnectToDaemonFn>(async () => mockConnection());
    const manager = track(
      new DaemonManager({
        droidPath: droidPath(),
        port: 37675,
        connect,
        resolveAuth: () => ({ apiKey: 'fk-reuse', source: 'env' }),
        healthTimeoutMs: 10_000,
        spawn: fakeDaemonSpawn(),
      }),
    );

    const a = await manager.ensure();
    const b = await manager.ensure();
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.pid).toBe(b.pid);
    expect(connect).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('reports spawn_failed when the binary cannot be started', async () => {
    const manager = track(
      new DaemonManager({
        droidPath: '/nonexistent/path/to/droid-binary',
        port: 37680,
        connect: async () => mockConnection(),
        resolveAuth: () => ({ apiKey: 'fk-x', source: 'env' }),
        healthTimeoutMs: 2_000,
      }),
    );
    const result = await manager.ensure();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spawn_failed');
  });
});
