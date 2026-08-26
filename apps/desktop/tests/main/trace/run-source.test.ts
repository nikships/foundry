import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { LinearRunSource, PipelineDef } from '../../../src/shared/types.js';

const pipeline: PipelineDef = {
  id: 'linear-run',
  name: 'Linear run',
  description: 'Test fixture.',
  phases: [],
  acceptance: { kind: 'all_phases_pass' },
};

const source: LinearRunSource = {
  kind: 'linear',
  trigger: 'manual',
  issueId: 'issue-uuid',
  url: 'https://linear.app/foundry/issue/FOU-190',
  revision: '2026-08-25T19:09:16.054Z',
  statusMapping: { started: 'started', completed: 'completed', failed: 'failed' },
  snapshot: {
    id: 'issue-uuid',
    identifier: 'FOU-190',
    title: 'Add Linear ticket orchestration integration',
    description: 'Use this issue as the brief.',
    url: 'https://linear.app/foundry/issue/FOU-190',
    updatedAt: '2026-08-25T19:09:16.054Z',
    team: { id: 'team-uuid', name: 'Foundry' },
    state: { id: 'todo-state', name: 'Todo', type: 'unstarted' },
  },
};

let support: string;
let tracer: Tracer;

beforeEach(() => {
  support = tempDir('foundry-run-source-');
  tracer = new Tracer(openDb(projectDbPath(support, 'proj')), projectRunsDir(support, 'proj'));
  tracer.startRun({
    runId: 'run_linear',
    projectId: 'proj',
    pipeline,
    request: 'Implement FOU-190',
    engineer: 'tester',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
    source,
  });
});

describe('immutable run source persistence', () => {
  it('round-trips the full Linear snapshot through SQLite and the raw record', () => {
    expect(tracer.run('run_linear')?.source).toEqual(source);
    const file = join(tracer.runDir('run_linear'), 'source.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(source);
  });

  it('survives a tracer restart', () => {
    const reopened = new Tracer(
      openDb(projectDbPath(support, 'proj')),
      projectRunsDir(support, 'proj'),
    );
    expect(reopened.run('run_linear')?.source).toEqual(source);
  });

  it('treats a malformed source row as absent instead of exposing a partial object', () => {
    const db = openDb(projectDbPath(support, 'proj'));
    db.prepare('UPDATE runs SET source_json = ? WHERE run_id = ?').run(
      JSON.stringify({ kind: 'linear' }),
      'run_linear',
    );
    db.close();

    expect(tracer.run('run_linear')?.source).toBeNull();
  });

  it('persists status-sync failures without changing the immutable source', () => {
    tracer.setSourceSyncError('run_linear', 'Linear rejected the status mapping');
    const run = tracer.run('run_linear');
    expect(run?.sourceSyncError).toBe('Linear rejected the status mapping');
    expect(run?.source).toEqual(source);
  });
});
