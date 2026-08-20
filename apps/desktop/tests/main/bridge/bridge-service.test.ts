/**
 * BridgeService: the sequence that makes a login feel finished — start, read
 * accounts, write models.json, refresh pi exactly once per committed write.
 *
 * The refresh count is the interesting assertion. An auth directory emits
 * several events for one login, and a service that refreshed per event would
 * rebuild pi's catalog repeatedly while the operator watches a spinner.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeService } from '../../../src/main/bridge/service.js';
import { piStateDir } from '../../../src/main/pi/runtime.js';

const services: BridgeService[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (services.length) await services.pop()?.shutdown();
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function supportDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-bridge-service-'));
  dirs.push(dir);
  return dir;
}

/** Binds whatever port the generated config names, then waits for SIGTERM. */
function scriptedBridgeSpawn(): (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe']; detached: boolean },
) => ReturnType<typeof nodeSpawn> {
  return (_command, args, options) => {
    const configPath = args[args.indexOf('-config') + 1] as string;
    const config = readFileSync(configPath, 'utf8');
    const port = Number(/^port:\s*(\d+)$/m.exec(config)?.[1]);
    return nodeSpawn(
      process.execPath,
      [
        '-e',
        `const net=require('net');const s=net.createServer(c=>c.end());s.listen(${port},'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`,
      ],
      options,
    );
  };
}

function writeAccount(authDir: string, file: string, type: string): void {
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, file), JSON.stringify({ type, email: `${type}@example.com` }));
}

/**
 * Vitest runs files in parallel and every Bridge suite binds inside the same
 * 37700–37799 band. The manager probes a port and then spawns, so two files
 * scanning up from the same offset can both be told a port is free and one
 * child loses the bind. Each suite takes its own slice: this one the middle,
 * `bridge-process-row` the top, `bridge-manager` the default at the bottom
 * (its scan-up test needs that specific port).
 */
const PORT_BASE = 37_750;
let nextPort = PORT_BASE;

function build(dir: string, refreshes: string[]): BridgeService {
  const service = new BridgeService({
    supportDir: dir,
    port: nextPort++,
    manager: {
      binaryPath: '/scripted/cli-proxy-api',
      spawn: scriptedBridgeSpawn(),
      healthTimeoutMs: 10_000,
    },
    refreshModels: async (supportDirArg) => {
      refreshes.push(supportDirArg);
    },
  });
  services.push(service);
  return service;
}

function modelsJson(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(piStateDir(dir), 'models.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('BridgeService', () => {
  it('writes models for the accounts already on disk when it starts', async () => {
    const dir = supportDir();
    const refreshes: string[] = [];
    const service = build(dir, refreshes);
    // A login completed in a previous session: the file is there before the
    // Bridge ever runs, and starting must pick it up rather than wait for an
    // event that already happened.
    writeAccount(join(dir, 'bridge', 'auth'), 'claude.json', 'claude');

    const result = await service.ensure();
    expect(result.ok).toBe(true);

    expect(modelsJson(dir).providers).toHaveProperty('bridge-claude');
    expect(refreshes).toEqual([dir]);
  }, 20_000);

  it('refreshes pi once per committed write, not once per regenerate call', async () => {
    const dir = supportDir();
    const refreshes: string[] = [];
    const service = build(dir, refreshes);
    writeAccount(join(dir, 'bridge', 'auth'), 'kimi.json', 'kimi');

    await service.ensure();
    expect(refreshes).toHaveLength(1);

    // Nothing changed on disk, so these produce identical bytes and no refresh.
    await service.regenerate();
    await service.regenerate();
    expect(refreshes).toHaveLength(1);

    // A new account does change the file, and earns exactly one more refresh.
    writeAccount(join(dir, 'bridge', 'auth'), 'grok.json', 'grok');
    await service.regenerate();
    expect(refreshes).toHaveLength(2);
    expect(modelsJson(dir).providers).toHaveProperty('bridge-grok');
  }, 20_000);

  it('reports every provider, connected or not, so Settings can offer a login', async () => {
    const dir = supportDir();
    const service = build(dir, []);
    writeAccount(join(dir, 'bridge', 'auth'), 'codex.json', 'codex');
    await service.ensure();

    const snapshot = service.snapshot();
    expect(snapshot.status.running).toBe(true);
    expect(snapshot.providers.map((p) => p.id)).toEqual([
      'claude',
      'codex',
      'gemini',
      'kimi',
      'grok',
    ]);
    expect(snapshot.providers.find((p) => p.id === 'codex')?.authenticated).toBe(true);
    expect(snapshot.providers.find((p) => p.id === 'claude')?.authenticated).toBe(false);
  }, 20_000);

  it('drops a provider’s models on disconnect', async () => {
    const dir = supportDir();
    const service = build(dir, []);
    writeAccount(join(dir, 'bridge', 'auth'), 'claude.json', 'claude');
    await service.ensure();
    expect(modelsJson(dir).providers).toHaveProperty('bridge-claude');

    const result = await service.disconnect('claude');
    expect(result.ok).toBe(true);
    expect(modelsJson(dir).providers).not.toHaveProperty('bridge-claude');
    expect(service.snapshot().providers.find((p) => p.id === 'claude')?.accounts).toEqual([]);
  }, 20_000);

  it('says so rather than failing when there was nothing to disconnect', async () => {
    const service = build(supportDir(), []);
    await service.ensure();
    expect(await service.disconnect('grok')).toEqual({
      ok: false,
      detail: 'there was no account to sign out of',
    });
  }, 20_000);

  it('refuses to start a login when the Bridge itself is unavailable', async () => {
    const dir = supportDir();
    const service = new BridgeService({ supportDir: dir, manager: { binaryPath: null } });
    services.push(service);

    const result = await service.connect('claude');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('unavailable');
  });

  it('writes no models while the Bridge has no port to point them at', async () => {
    const dir = supportDir();
    const refreshes: string[] = [];
    const service = new BridgeService({
      supportDir: dir,
      manager: { binaryPath: null },
      refreshModels: async () => {
        refreshes.push('refreshed');
      },
    });
    services.push(service);
    writeAccount(join(dir, 'bridge', 'auth'), 'claude.json', 'claude');

    expect((await service.ensure()).ok).toBe(false);
    await service.regenerate();
    // A models.json pointing at a Bridge that is not serving would offer models
    // whose every request is refused.
    expect(() => modelsJson(dir)).toThrow();
    expect(refreshes).toEqual([]);
  });
});
