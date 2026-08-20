/**
 * The `change_id` cursor the renderer polls on. Real sqlite, no model, no git.
 *
 * A row is patched in place as a turn streams — text grows, a tool call closes
 * — so a cursor that only ever moved forward by rowid would serve the first
 * version of a row and never the finished one. Every insert and every patch
 * stamps a new `change_id`, which is what makes a poll that has already passed
 * a row see it again.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { PipelineDef } from '../../../src/shared/types.js';

const pipeline: PipelineDef = {
  id: 'test',
  name: 'test',
  description: 'test pipeline',
  acceptance: { kind: 'all_phases_pass' },
  phases: [],
};

let tracer: Tracer;
let runId: string;
let phaseId: string;

beforeEach(() => {
  const support = tempDir('foundry-trace-cursor-');
  tracer = new Tracer(openDb(projectDbPath(support, 'proj')), projectRunsDir(support, 'proj'));
  runId = 'run_trace_cursor';
  tracer.startRun({
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
  phaseId = tracer.openPhase({
    runId,
    seq: 0,
    name: 'build',
    kind: 'agent',
    owner: 'builder',
    description: 'd',
  });
});

describe('the change_id cursor', () => {
  it('re-serves a row patched in place after the cursor has passed it', () => {
    const id = tracer.event({ runId, phaseId, type: 'tool_call', name: 'bash: x', payload: {} });
    const firstPage = tracer.eventsAfter(runId, 0);
    const cursor = Math.max(...firstPage.map((e) => e.changeId));
    tracer.endEvent(id, { result: 'done' });
    const secondPage = tracer.eventsAfter(runId, cursor);
    expect(secondPage.map((e) => e.eventId)).toContain(id);
    expect(secondPage.find((e) => e.eventId === id)!.payload.result).toBe('done');
  });

  it('keeps creation order when a patched row is re-served', () => {
    const a = tracer.event({ runId, phaseId, type: 'log', name: 'a', payload: {} });
    const b = tracer.event({ runId, phaseId, type: 'log', name: 'b', payload: {} });
    tracer.patchEvent(a, { touched: true });
    const all = tracer.eventsAfter(runId, 0);
    const names = all.filter((e) => e.type === 'log').map((e) => e.name);
    expect(names).toEqual(['a', 'b']);
    expect(all.find((e) => e.eventId === a)!.payload.touched).toBe(true);
    expect(b).not.toBe(a);
  });

  it('assigns monotonically increasing ids across inserts and patches', () => {
    const a = tracer.event({ runId, phaseId, type: 'log', name: 'a', payload: {} });
    tracer.event({ runId, phaseId, type: 'log', name: 'b', payload: {} });
    tracer.patchEvent(a, { n: 1 });
    const rows = tracer.eventsAfter(runId, 0).filter((e) => e.type === 'log');
    const byName = new Map(rows.map((e) => [e.name, e.changeId]));
    // The patch bumped a past b, which is what makes the re-serve query find it.
    expect(byName.get('a')!).toBeGreaterThan(byName.get('b')!);
    const patchedA = tracer.eventsAfter(runId, byName.get('b')!);
    expect(patchedA.map((e) => e.name)).toEqual(['a']);
  });

  it('continues the sequence when the db is reopened', () => {
    const support = tempDir('foundry-trace-cursor-');
    const dbPath = projectDbPath(support, 'proj');
    const dir = projectRunsDir(support, 'proj');
    const first = new Tracer(openDb(dbPath), dir);
    first.startRun({
      runId: 'r1',
      projectId: 'proj',
      pipeline,
      request: 'x',
      engineer: 't',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    first.event({ runId: 'r1', type: 'log', name: 'before', payload: {} });
    const maxBefore = Math.max(...first.eventsAfter('r1', 0).map((e) => e.changeId));

    const second = new Tracer(openDb(dbPath), dir);
    second.event({ runId: 'r1', type: 'log', name: 'after', payload: {} });
    const after = second.eventsAfter('r1', maxBefore);
    expect(after.map((e) => e.name)).toEqual(['after']);
  });
});

describe('run artifact columns', () => {
  it('records and reads back the filed issue beside the PR', () => {
    tracer.setPr(runId, 12, 'https://github.com/acme/widgets/pull/12');
    tracer.setIssue(runId, 34, 'https://github.com/acme/widgets/issues/34');
    const row = tracer.run(runId)!;
    expect(row.prNumber).toBe(12);
    expect(row.prUrl).toBe('https://github.com/acme/widgets/pull/12');
    expect(row.issueNumber).toBe(34);
    expect(row.issueUrl).toBe('https://github.com/acme/widgets/issues/34');
  });

  it('adds the issue columns to a database created before they existed', () => {
    const support = tempDir('foundry-trace-migrate-');
    const dbPath = projectDbPath(support, 'proj');
    mkdirSync(dirname(dbPath), { recursive: true });
    // A pre-FOU-80 runs table: no issue_number / issue_url.
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE runs (
      run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, pipeline_id TEXT NOT NULL,
      pipeline_name TEXT, pipeline_snapshot_json TEXT, request TEXT,
      status TEXT NOT NULL DEFAULT 'running', engineer TEXT, worktree_path TEXT,
      branch TEXT, base_ref TEXT, mode TEXT DEFAULT 'pi', merged INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0, branch_point_sha TEXT, outcome_detail TEXT,
      pr_number INTEGER, pr_url TEXT, started_at TEXT, ended_at TEXT,
      total_tokens INTEGER DEFAULT 0
    )`);
    old
      .prepare(
        "INSERT INTO runs (run_id, project_id, pipeline_id, started_at) VALUES ('r_old', 'proj', 'p', '2026-01-01')",
      )
      .run();
    old.close();

    const migrated = new Tracer(openDb(dbPath), projectRunsDir(support, 'proj'));
    const row = migrated.run('r_old')!;
    expect(row.issueNumber).toBeNull();
    expect(row.issueUrl).toBeNull();
    migrated.setIssue('r_old', 5, 'https://github.com/acme/widgets/issues/5');
    expect(migrated.run('r_old')!.issueNumber).toBe(5);
  });
});

describe('agent sessions', () => {
  it('reads back the session id under the neutral column name', () => {
    tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'inherit',
      reasoningEffort: 'medium',
      agentSessionId: 'sess-1',
      mode: 'pi',
      color: '#fff',
    });
    const [session] = tracer.agentSessions(runId);
    expect(session!.mode).toBe('pi');
    expect(session!.agentSessionId).toBe('sess-1');
  });
});
