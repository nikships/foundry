/**
 * The Bridge's `processes` row is app-scoped, and that has consequences the
 * schema enforces rather than the code.
 *
 * `processes.run_id` has a foreign key to `runs` with `foreign_keys = ON`, so
 * an invented run id would be rejected outright. Null is the shape that both
 * satisfies the constraint and keeps the row out of every per-run query — while
 * still reaching the relaunch sweep, which is the caller that has to close an
 * orphaned Bridge.
 *
 * The second half of this file is the wiring above the tracer: a row nothing
 * writes is an invariant that holds in a unit test and not in the app, which is
 * exactly the state this file used to pin.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { BRIDGE_PROCESS_NAME } from '../../../src/main/bridge/manager.js';
import { BridgeService } from '../../../src/main/bridge/service.js';
import { RunRegistry } from '../../../src/main/engine/registry.js';
import { isAlive } from '../../../src/main/system/procs.js';
import { tempDir } from '../../helpers/tmp.js';
import type { AppSettings, PipelineDef, ProjectDef } from '../../../src/shared/types.js';

const pipeline: PipelineDef = {
  id: 'test',
  name: 'test',
  description: 'test pipeline',
  acceptance: { kind: 'all_phases_pass' },
  phases: [],
};

function tracer(): Tracer {
  const support = tempDir('foundry-bridge-proc-');
  return new Tracer(openDb(projectDbPath(support, 'proj')), projectRunsDir(support, 'proj'));
}

function withRun(trace: Tracer, runId: string): string {
  trace.startRun({
    runId,
    projectId: 'proj',
    pipeline,
    request: 'do it',
    engineer: 'tester',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
  });
  return runId;
}

describe('the Bridge process row', () => {
  it('records against no run, which the foreign key would otherwise refuse', () => {
    const trace = tracer();
    const id = trace.recordProcess({
      runId: null,
      kind: 'bridge',
      name: BRIDGE_PROCESS_NAME,
      pid: 4242,
      command: '/resources/bridge/cli-proxy-api -config /support/bridge/config.yaml',
    });
    expect(id).toBeGreaterThan(0);

    const open = trace.openProcesses();
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe('bridge');
    expect(open[0]?.runId).toBeNull();
  });

  it('rejects a synthetic run id, which is why the column is nulled', () => {
    const trace = tracer();
    expect(() =>
      trace.recordProcess({
        runId: '__bridge__',
        kind: 'bridge',
        name: BRIDGE_PROCESS_NAME,
        pid: 4243,
        command: 'cli-proxy-api',
      }),
    ).toThrow();
  });

  it('is invisible to a per-run query, so a run kill never signals the Bridge', () => {
    const trace = tracer();
    const runId = withRun(trace, 'run_a');
    trace.recordProcess({
      runId,
      kind: 'code',
      name: 'test',
      pid: 111,
      command: 'npm test',
    });
    trace.recordProcess({
      runId: null,
      kind: 'bridge',
      name: BRIDGE_PROCESS_NAME,
      pid: 4242,
      command: 'cli-proxy-api',
    });

    expect(trace.openProcesses(runId).map((p) => p.pid)).toEqual([111]);
    // The unfiltered sweep still sees it, which is how a crash-orphaned Bridge
    // gets its row closed on the next launch.
    expect(
      trace
        .openProcesses()
        .map((p) => p.pid)
        .sort(),
    ).toEqual([111, 4242]);
  });

  it('survives a retention pass that deletes the run alongside it', () => {
    const trace = tracer();
    const runId = withRun(trace, 'run_old');
    trace.finishRun(runId, 'accepted');
    trace.recordProcess({ runId, kind: 'code', name: 'test', pid: 111, command: 'npm test' });
    trace.recordProcess({
      runId: null,
      kind: 'bridge',
      name: BRIDGE_PROCESS_NAME,
      pid: 4242,
      command: 'cli-proxy-api',
    });

    // A negative retention puts the cutoff in the future, so every finished run
    // and everything keyed to it goes.
    expect(trace.deleteRunsOlderThan(-1).runIds).toEqual([runId]);

    const open = trace.openProcesses();
    expect(open).toHaveLength(1);
    expect(open[0]?.pid).toBe(4242);
  });

  it('closes like any other row once the sweep finds the pid gone', () => {
    const trace = tracer();
    const id = trace.recordProcess({
      runId: null,
      kind: 'bridge',
      name: BRIDGE_PROCESS_NAME,
      pid: 4242,
      command: 'cli-proxy-api',
    });
    trace.endProcess(id);
    expect(trace.openProcesses()).toEqual([]);
  });
});

// ── the wiring above the tracer ──────────────────────────────────────────────

const services: BridgeService[] = [];
/** Children deliberately orphaned by a test, so a failed sweep cannot leak one. */
const orphans: number[] = [];

afterEach(async () => {
  while (services.length) await services.pop()?.shutdown();
  while (orphans.length) {
    const pid = orphans.pop() as number;
    try {
      if (isAlive(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is the outcome the test was asserting anyway.
    }
  }
});

function registry(support: string): RunRegistry {
  return new RunRegistry({
    appSupportDir: support,
    settings: () => ({}) as AppSettings,
    engineerName: 'test',
    onRunFinished: () => undefined,
    onRunsChanged: () => undefined,
  });
}

/**
 * A stand-in that reads the generated config and binds the port it names, the
 * same shape `tests/bridge-manager.test.ts` uses.
 */
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

/**
 * Vitest runs files in parallel, and every Bridge test binds inside the same
 * 37700–37799 band. The manager probes for a free port and then spawns, so two
 * files racing the same offset can both be told a port is free and one child
 * loses the bind. This file takes the top of the band; the other Bridge suites
 * start from the default at the bottom.
 */
const PORT_BASE = 37_780;
let nextPort = PORT_BASE;

function bridge(support: string, runs: RunRegistry, port = nextPort++): BridgeService {
  const service = new BridgeService({
    supportDir: support,
    port,
    manager: {
      // The stand-in runs under `process.execPath`, and the sweep's pid-recycle
      // guard compares the recorded argv head against live `ps` output. A
      // fictional binary path would record a command no `ps` could ever match,
      // which is the one thing that must not be faked in a reclaim test.
      binaryPath: process.execPath,
      spawn: scriptedBridgeSpawn(),
      healthTimeoutMs: 10_000,
    },
    trace: () => runs.bridgeTrace(),
    refreshModels: async () => undefined,
  });
  services.push(service);
  return service;
}

async function waitForDeath(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isAlive(pid) && Date.now() < deadline) await sleep(50);
}

describe('recording the Bridge from a real ensure()', () => {
  it('writes the row without the caller passing anything', async () => {
    const support = tempDir('foundry-bridge-wiring-');
    const runs = registry(support);
    // No recorder argument anywhere: the wiring is the service's, so every
    // start path — a run, the doctor, a Settings login — records identically.
    const result = await bridge(support, runs).ensure();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const open = runs.appTracer().openProcesses();
    expect(open).toHaveLength(1);
    expect(open[0]?.kind).toBe('bridge');
    expect(open[0]?.name).toBe(BRIDGE_PROCESS_NAME);
    expect(open[0]?.runId).toBeNull();
    expect(open[0]?.pid).toBe(result.pid);
    expect(open[0]?.command).toBe(result.command);
  }, 20_000);

  it('writes one row for repeated ensures, and closes it on a clean shutdown', async () => {
    const support = tempDir('foundry-bridge-wiring-');
    const runs = registry(support);
    const service = bridge(support, runs);

    await Promise.all([service.ensure(), service.ensure()]);
    await service.ensure();
    expect(runs.appTracer().openProcesses()).toHaveLength(1);

    await service.shutdown();
    // A quit that ran `before-quit` leaves nothing for the next launch to
    // reclaim; an open row there would send the sweep after a dead pid.
    expect(runs.appTracer().openProcesses()).toEqual([]);
  }, 20_000);

  it('goes to the app trace, not a project one, so removing a project keeps it', async () => {
    const support = tempDir('foundry-bridge-wiring-');
    const runs = registry(support);
    await bridge(support, runs).ensure();

    const project: ProjectDef = {
      id: 'proj',
      name: 'proj',
      path: `${support}/repo`,
      baseRef: 'main',
      isolation: true,
      mergePolicy: 'ask',
      commands: [],
      protectedPaths: [],
      ownRoster: false,
      ownPipelines: false,
      addedAt: new Date().toISOString(),
    };
    // The Bridge is app-scoped and serves every project; a row in whichever
    // project's trace happened to start it disappears with that project.
    expect(runs.tracerFor(project).openProcesses()).toEqual([]);
    expect(runs.appTracer().openProcesses()).toHaveLength(1);
  }, 20_000);
});

describe('the relaunch sweep against a crash-orphaned Bridge', () => {
  it('kills the survivor and closes its row, so the next start reuses the port', async () => {
    const support = tempDir('foundry-bridge-sweep-');
    // Both launches prefer the same port, as two launches of one app do. That
    // is what makes the reuse assertion below mean something: an orphan still
    // holding it would send the second start scanning up onto the next one.
    const port = nextPort++;
    // Launch one: it records its child and is then lost without a shutdown,
    // exactly as a SIGKILL of main leaves things.
    const crashed = registry(support);
    const started = await bridge(support, crashed, port).ensure();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    services.pop();
    orphans.push(started.pid);
    expect(isAlive(started.pid)).toBe(true);

    // Launch two opens the same store and sees the row the first one left.
    const relaunched = registry(support);
    const open = relaunched.appTracer().openProcesses();
    expect(open).toHaveLength(1);
    expect(open[0]?.pid).toBe(started.pid);

    const swept = await relaunched.sweepAppProcesses();
    expect(swept.reclaimed).toEqual([started.pid]);
    expect(relaunched.appTracer().openProcesses()).toEqual([]);

    await waitForDeath(started.pid);
    expect(isAlive(started.pid)).toBe(false);

    // The port the orphan held is free again, so this launch's Bridge lands on
    // it rather than scanning up onto a second one.
    const restarted = await bridge(support, relaunched, port).ensure();
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.port).toBe(started.port);
    expect(relaunched.appTracer().openProcesses()).toHaveLength(1);
  }, 30_000);

  it('closes a row whose pid is gone without signalling anything', async () => {
    const support = tempDir('foundry-bridge-sweep-');
    const runs = registry(support);
    const service = bridge(support, runs);
    const started = await service.ensure();
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // The child died on its own — a crash of the proxy, not of the app. The
    // exit handler closes the row, and the sweep has nothing left to reclaim.
    process.kill(started.pid, 'SIGKILL');
    await waitForDeath(started.pid);
    await sleep(100);

    const swept = await runs.sweepAppProcesses();
    expect(swept.reclaimed).toEqual([]);
    expect(runs.appTracer().openProcesses()).toEqual([]);
  }, 20_000);

  it('leaves a recycled pid alone: the argv no longer matches the Bridge', async () => {
    const support = tempDir('foundry-bridge-sweep-');
    const runs = registry(support);
    // `process.pid` is alive and is certainly not a cli-proxy-api, which is the
    // shape a recycled pid takes. Killing it would be killing a stranger.
    const id = runs.appTracer().recordProcess({
      runId: null,
      kind: 'bridge',
      name: BRIDGE_PROCESS_NAME,
      pid: process.pid,
      command: '/resources/bridge/cli-proxy-api -config /support/bridge/config.yaml',
    });
    expect(id).toBeGreaterThan(0);

    const swept = await runs.sweepAppProcesses();
    expect(swept.reclaimed).toEqual([]);
    expect(swept.closed).toBe(1);
    expect(runs.appTracer().openProcesses()).toEqual([]);
    expect(isAlive(process.pid)).toBe(true);
  }, 20_000);
});
