/**
 * The Bridge's `processes` row is app-scoped, and that has consequences the
 * schema enforces rather than the code.
 *
 * `processes.run_id` has a foreign key to `runs` with `foreign_keys = ON`, so
 * an invented run id would be rejected outright. Null is the shape that both
 * satisfies the constraint and keeps the row out of every per-run query — while
 * still reaching the relaunch sweep, which is the caller that has to close an
 * orphaned Bridge.
 */

import { describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import { BRIDGE_PROCESS_NAME } from '../src/main/bridge/manager.js';
import { tempDir } from './tmp.js';
import type { PipelineDef } from '../src/shared/types.js';

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
    mode: 'rpc',
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
    expect(trace.deleteRunsOlderThan(-1)).toEqual([runId]);

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
