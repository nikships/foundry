/**
 * The session registry against a fake engine: what spawns, what blocks, and
 * how resume + session-id discovery behave. The engine seam is exactly what
 * the real Ghostty engine implements, so these pin the registry's side of the
 * contract without an Electron runtime.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef, ProjectDef, SmithStatus } from '../src/shared/types.js';
import { __setResolvedEnvForTest } from '../src/main/system/env.js';
import type { GhosttySpawnOptions, TerminalEngine } from '../src/main/smith/engine.js';
import { SmithRegistry, type DiscoveredSession } from '../src/main/smith/registry.js';

class FakeEngine implements TerminalEngine {
  killed = false;
  redraws = 0;
  private activity: (() => void) | null = null;
  private exit: ((event: { exitCode: number }) => void) | null = null;

  constructor(readonly opts: GhosttySpawnOptions) {}

  text(): void {}
  onActivity(handler: () => void): void {
    this.activity = handler;
  }
  onExit(handler: (event: { exitCode: number }) => void): void {
    this.exit = handler;
  }
  redraw(): void {
    this.redraws += 1;
  }
  kill(): void {
    this.killed = true;
  }

  emitActivity(): void {
    this.activity?.();
  }
  emitExit(exitCode: number): void {
    this.exit?.({ exitCode });
  }
}

const webContents = {} as GhosttySpawnOptions['webContents'];

function project(path: string): ProjectDef {
  return {
    id: 'proj-1',
    name: 'Acme',
    path,
    baseRef: 'main',
    isolation: true,
    mergePolicy: 'ask',
    commands: [],
    protectedPaths: [],
    ownRoster: false,
    ownPipelines: false,
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('SmithRegistry', () => {
  let dir: string;
  let engines: FakeEngine[];
  let statuses: SmithStatus[];
  let discovered: DiscoveredSession[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smith-registry-'));
    engines = [];
    statuses = [];
    discovered = [];
    __setResolvedEnvForTest({ path: '/usr/bin:/bin', via: 'fallback' });
  });

  afterEach(() => {
    vi.useRealTimers();
    __setResolvedEnvForTest(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function registry(overrides: Partial<ConstructorParameters<typeof SmithRegistry>[0]> = {}) {
    return new SmithRegistry({
      supportDir: dir,
      cliPath: '/app/foundry-cli.js',
      socketPath: join(dir, 'foundry.sock'),
      scopeFor: () => ({
        project: project(dir),
        agents: [] as AgentDef[],
        pipelines: [],
        envelopes: [],
      }),
      droid: async () => ({ ok: true, path: '/usr/local/bin/droid' }),
      onStatusChanged: (status) => statuses.push(status),
      engineAvailable: () => true,
      spawnEngine: (opts) => {
        const engine = new FakeEngine(opts);
        engines.push(engine);
        return engine;
      },
      webContents: () => webContents,
      discoverSessions: async () => discovered,
      ...overrides,
    });
  }

  it('blocks with engine-missing when the ghostty addon is unavailable', async () => {
    const r = registry({ engineAvailable: () => false });
    const status = await r.open('proj-1');
    expect(status.state).toBe('blocked');
    expect(status.blocked).toBe('engine-missing');
    expect(engines).toHaveLength(0);
  });

  it('spawns droid with the project slot and per-session env in the request', async () => {
    const r = registry();
    const status = await r.open('proj-1');
    expect(status.state).toBe('idle');
    expect(engines).toHaveLength(1);
    const opts = engines[0].opts;
    expect(opts.file).toBe('/usr/local/bin/droid');
    expect(opts.slot).toBe('smith:proj-1');
    expect(opts.args).toContain('--append-system-prompt-file');
    expect(opts.args).not.toContain('--resume');
    expect(opts.extraEnv.FOUNDRY_SMITH_SOCKET).toBe(join(dir, 'foundry.sock'));
    expect(opts.extraEnv.FOUNDRY_CLI).toBe('/app/foundry-cli.js');
    expect(opts.extraEnv.FOUNDRY_SMITH_PROJECT).toBe('proj-1');
    expect(opts.extraEnv.PATH).toBe('/usr/bin:/bin');
  });

  it('reopening a live session redraws instead of respawning', async () => {
    const r = registry();
    await r.open('proj-1');
    const again = await r.open('proj-1');
    expect(engines).toHaveLength(1);
    expect(engines[0].redraws).toBe(1);
    expect(again.state).toBe('idle');
  });

  it('flips busy on activity and back to idle when frames go quiet', async () => {
    vi.useFakeTimers();
    const r = registry();
    await r.open('proj-1');
    engines[0].emitActivity();
    expect(r.status('proj-1').state).toBe('busy');
    vi.advanceTimersByTime(2_000);
    expect(r.status('proj-1').state).toBe('idle');
  });

  it('records the discovered droid session id and resumes with it next spawn', async () => {
    vi.useFakeTimers();
    discovered = [{ id: 'sess-new', createdTime: new Date() }];
    const r = registry();
    await r.open('proj-1');
    await vi.advanceTimersByTimeAsync(6_000);

    // Session ends; the next open resumes with the recorded id.
    engines[0].emitExit(0);
    await r.open('proj-1');
    expect(engines).toHaveLength(2);
    expect(engines[1].opts.args).toContain('--resume');
    expect(engines[1].opts.args).toContain('sess-new');
  });

  it('ignores store sessions that predate the spawn (not ours)', async () => {
    vi.useFakeTimers();
    discovered = [{ id: 'sess-old', createdTime: new Date(Date.now() - 60_000) }];
    const r = registry();
    await r.open('proj-1');
    await vi.advanceTimersByTimeAsync(60_000);

    engines[0].emitExit(0);
    await r.open('proj-1');
    expect(engines[1].opts.args).not.toContain('--resume');
  });

  it('a resume that dies fast respawns fresh once and drops the stored id', async () => {
    vi.useFakeTimers();
    discovered = [{ id: 'sess-dead', createdTime: new Date() }];
    const r = registry();
    await r.open('proj-1');
    await vi.advanceTimersByTimeAsync(6_000);
    engines[0].emitExit(0);

    // Resume attempt: dies immediately (exit 1 per the engine's heuristic).
    await r.open('proj-1');
    expect(engines[1].opts.args).toContain('--resume');
    engines[1].emitExit(1);

    // Fresh respawn without --resume, still the same session slot.
    expect(engines).toHaveLength(3);
    expect(engines[2].opts.args).not.toContain('--resume');
    expect(r.status('proj-1').state).toBe('idle');
    expect(r.status('proj-1').detail).toMatch(/started fresh/i);
  });

  it('a non-resume exit finalizes as exited without respawning', async () => {
    const r = registry();
    await r.open('proj-1');
    engines[0].emitExit(0);
    expect(engines).toHaveLength(1);
    expect(r.status('proj-1').state).toBe('exited');
  });

  it('kill ends the engine and reports absent', async () => {
    const r = registry();
    await r.open('proj-1');
    r.kill('proj-1');
    expect(engines[0].killed).toBe(true);
    expect(r.status('proj-1').state).toBe('absent');
    expect(statuses.at(-1)?.state).toBe('absent');
  });
});
