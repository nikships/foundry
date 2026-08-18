/**
 * BridgeManager: lazy spawn bound to 127.0.0.1 inside 37700–37799, scan-up on a
 * busy port, coalesced concurrent ensures, no orphan after a failed start, and
 * the app-scoped `processes` row.
 *
 * The child is a scripted stand-in rather than the vendored CLIProxyAPI binary:
 * a checkout that has not run `npm run fetch:bridge` has no binary, and a real
 * one would want an account. The stand-in reads the same generated config the
 * real binary is given, so the port and host under test are the ones Foundry
 * actually wrote.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_PORT_MAX,
  BRIDGE_PORT_MIN,
  BRIDGE_PROCESS_NAME,
  BridgeManager,
  DEFAULT_BRIDGE_PORT,
} from '../src/main/bridge/manager.js';
import { bridgeAuthDir, bridgeConfigPath } from '../src/main/bridge/paths.js';
import { isAlive } from '../src/main/system/procs.js';

const managers: BridgeManager[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (managers.length) await managers.pop()?.shutdown();
  while (servers.length) {
    const server = servers.pop();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function supportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-bridge-'));
  dirs.push(dir);
  return dir;
}

function track(manager: BridgeManager): BridgeManager {
  managers.push(manager);
  return manager;
}

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/**
 * A stand-in that behaves like the vendored binary in the ways the manager
 * depends on: it reads `-config <path>`, binds the port and host that file
 * names, and exits on SIGTERM.
 */
function scriptedBridgeSpawn(): (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
) => ReturnType<typeof nodeSpawn> {
  return (_command, args, options) => {
    const configPath = args[args.indexOf('-config') + 1];
    if (!configPath) throw new Error(`scripted bridge: no -config in ${args.join(' ')}`);
    const config = readFileSync(configPath, 'utf8');
    const port = Number(/^port:\s*(\d+)$/m.exec(config)?.[1]);
    const host = /^host:\s*"([^"]+)"$/m.exec(config)?.[1];
    if (!Number.isFinite(port) || !host) {
      throw new Error(`scripted bridge: unreadable config at ${configPath}`);
    }
    const script = `
      const net = require('net');
      const server = net.createServer((socket) => socket.end());
      server.listen(${port}, ${JSON.stringify(host)});
      server.on('error', (err) => { console.error(err.message); process.exit(1); });
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    `;
    return nodeSpawn(process.execPath, ['-e', script], options);
  };
}

describe('BridgeManager', () => {
  it('starts the vendored binary on 127.0.0.1 inside the bridge port band', async () => {
    const dir = supportDir();
    const recorded: { pid: number; port: number; command: string }[] = [];
    const manager = track(
      new BridgeManager({
        supportDir: dir,
        binaryPath: '/scripted/cli-proxy-api',
        spawn: scriptedBridgeSpawn(),
        onProcess: (info) => recorded.push(info),
        healthTimeoutMs: 10_000,
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.port).toBeGreaterThanOrEqual(BRIDGE_PORT_MIN);
    expect(result.port).toBeLessThanOrEqual(BRIDGE_PORT_MAX);
    expect(result.baseUrl).toBe(`http://127.0.0.1:${result.port}`);
    expect(isAlive(result.pid)).toBe(true);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.pid).toBe(result.pid);
  }, 20_000);

  it('writes a localhost-only config naming Foundry’s own auth directory', async () => {
    const dir = supportDir();
    const manager = track(
      new BridgeManager({
        supportDir: dir,
        binaryPath: '/scripted/cli-proxy-api',
        spawn: scriptedBridgeSpawn(),
        healthTimeoutMs: 10_000,
      }),
    );
    const result = await manager.ensure();
    expect(result.ok).toBe(true);

    const config = readFileSync(bridgeConfigPath(dir), 'utf8');
    expect(config).toContain('host: "127.0.0.1"');
    expect(config).toContain('allow-remote: false');
    expect(config).toContain(bridgeAuthDir(dir));
    // Never the user's own ~/.cli-proxy-api: an app that logged in there would
    // rewrite the accounts their own tools use.
    expect(config).not.toContain('.cli-proxy-api');
  }, 20_000);

  it('scans up within the band when the preferred port is taken', async () => {
    try {
      await listenOn(DEFAULT_BRIDGE_PORT);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    }
    const manager = track(
      new BridgeManager({
        supportDir: supportDir(),
        port: DEFAULT_BRIDGE_PORT,
        binaryPath: '/scripted/cli-proxy-api',
        spawn: scriptedBridgeSpawn(),
        healthTimeoutMs: 10_000,
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.port).toBeGreaterThan(DEFAULT_BRIDGE_PORT);
    expect(result.port).toBeLessThanOrEqual(BRIDGE_PORT_MAX);
  }, 20_000);

  it('coalesces concurrent ensures into one child', async () => {
    let spawns = 0;
    const scripted = scriptedBridgeSpawn();
    const manager = track(
      new BridgeManager({
        supportDir: supportDir(),
        binaryPath: '/scripted/cli-proxy-api',
        spawn: (command, args, options) => {
          spawns += 1;
          return scripted(command, args, options);
        },
        healthTimeoutMs: 10_000,
      }),
    );

    const [a, b, c] = await Promise.all([manager.ensure(), manager.ensure(), manager.ensure()]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(spawns).toBe(1);
    expect(new Set([a.pid, b.pid, c.pid]).size).toBe(1);
  }, 20_000);

  it('reports the Bridge as unavailable when the binary was never fetched', async () => {
    const attempts: string[][] = [];
    const manager = track(
      new BridgeManager({
        supportDir: supportDir(),
        binaryPath: null,
        onSpawnAttempt: (argv) => attempts.push(argv),
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('binary_missing');
    expect(result.detail).toContain('fetch:bridge');
    // Nothing is spawned, so a missing binary costs no child and no port.
    expect(attempts).toEqual([]);
    expect(manager.status().running).toBe(false);
  });

  it('leaves no child behind when the port never opens', async () => {
    const pids: number[] = [];
    const manager = track(
      new BridgeManager({
        supportDir: supportDir(),
        binaryPath: '/scripted/cli-proxy-api',
        // A child that starts and never listens: the failure mode a wrong
        // config or a refused bind produces.
        spawn: (_command, _args, options) => {
          const child = nodeSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options);
          if (child.pid) pids.push(child.pid);
          return child;
        },
        isPortOpen: async () => false,
        healthTimeoutMs: 300,
        healthPollMs: 50,
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('health_timeout');

    const deadline = Date.now() + 5_000;
    while (pids.some((pid) => isAlive(pid)) && Date.now() < deadline) await sleep(50);
    expect(pids.filter((pid) => isAlive(pid))).toEqual([]);
  }, 20_000);

  it('reports spawn_failed rather than throwing when the binary cannot run', async () => {
    const manager = track(
      new BridgeManager({
        supportDir: supportDir(),
        binaryPath: '/nonexistent/path/to/cli-proxy-api',
        healthTimeoutMs: 1_000,
      }),
    );
    const result = await manager.ensure();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('spawn_failed');
    expect(manager.status().reason).toBe('spawn_failed');
  }, 20_000);

  it('kills the child on shutdown, so a quit leaves no proxy holding the port', async () => {
    const manager = track(
      new BridgeManager({
        supportDir: supportDir(),
        binaryPath: '/scripted/cli-proxy-api',
        spawn: scriptedBridgeSpawn(),
        healthTimeoutMs: 10_000,
      }),
    );

    const result = await manager.ensure();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await manager.shutdown();
    const deadline = Date.now() + 5_000;
    while (isAlive(result.pid) && Date.now() < deadline) await sleep(50);
    expect(isAlive(result.pid)).toBe(false);
    expect(manager.status().running).toBe(false);
  }, 20_000);

  it('names its process row so the relaunch sweep can identify an orphan', () => {
    expect(BRIDGE_PROCESS_NAME).toBe('bridge');
  });
});
