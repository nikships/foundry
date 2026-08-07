/**
 * The transcript machinery: the EventFolder's folding of droid's notification
 * stream into trace rows, and the change_id cursor that re-serves a row after
 * it was patched in place. Real sqlite, no model, no git: the folder is the
 * unit under test.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import { EventFolder, toolKind } from '../src/main/droid/events.js';
import type { PipelineDef } from '../src/shared/types.js';

const pipeline: PipelineDef = {
  id: 'test',
  name: 'test',
  description: 'test pipeline',
  acceptance: { kind: 'all_phases_pass' },
  phases: [],
};

let tracer: Tracer;
let runsDir: string;
let runId: string;
let phaseId: string;
/** Injectable clock so the folder's flush throttle is deterministic. */
let now: number;

beforeEach(() => {
  const support = mkdtempSync(join(tmpdir(), 'foundry-transcript-'));
  tracer = new Tracer(openDb(projectDbPath(support, 'proj')), projectRunsDir(support, 'proj'));
  runsDir = projectRunsDir(support, 'proj');
  runId = 'run_transcript_test';
  tracer.startRun({
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
  phaseId = tracer.openPhase({ runId, seq: 0, name: 'build', kind: 'agent', owner: 'builder', description: 'd' });
  now = 1_000_000;
});

function folder(): EventFolder {
  return new EventFolder({ tracer, runId, phaseId, agent: 'builder', now: () => now });
}

function eventsOf(type: string) {
  return tracer.eventsAfter(runId, 0).filter((e) => e.type === type);
}

describe('text folding', () => {
  it('folds thinking deltas into one row that closes on complete', () => {
    const f = folder();
    f.absorb({ type: 'thinking_text_delta', messageId: 'm1', textDelta: 'let ' });
    f.absorb({ type: 'thinking_text_delta', messageId: 'm1', textDelta: 'me think' });
    f.absorb({ type: 'thinking_text_complete', messageId: 'm1' });
    const rows = eventsOf('thinking');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.text).toBe('let me think');
    expect(rows[0]!.endedAt).not.toBeNull();
  });

  it('folds assistant text per message and block, so two blocks stay two rows', () => {
    const f = folder();
    f.absorb({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'first ' });
    f.absorb({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 1, textDelta: 'second' });
    f.absorb({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'block' });
    f.absorb({ type: 'assistant_text_complete', messageId: 'm1', blockIndex: 0 });
    f.absorb({ type: 'assistant_text_complete', messageId: 'm1', blockIndex: 1 });
    const rows = eventsOf('assistant_text');
    expect(rows.map((r) => r.payload.text)).toEqual(['first block', 'second']);
  });

  it('throttles in-place growth but never loses a delta', () => {
    const f = folder();
    f.absorb({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'a' });
    now += 10;
    f.absorb({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'b' });
    // Inside the flush window the row still shows the first delta only.
    expect(eventsOf('assistant_text')[0]!.payload.text).toBe('a');
    now += 300;
    f.absorb({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'c' });
    expect(eventsOf('assistant_text')[0]!.payload.text).toBe('abc');
    // And the close always writes the whole text, whatever the throttle did.
    now += 10;
    f.absorb({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'd' });
    f.absorb({ type: 'assistant_text_complete', messageId: 'm1', blockIndex: 0 });
    expect(eventsOf('assistant_text')[0]!.payload.text).toBe('abcd');
  });

  it('caps a huge block and says so, pointing at the raw stream for the rest', () => {
    const f = folder();
    f.absorb({ type: 'assistant_text_delta', messageId: 'm1', blockIndex: 0, textDelta: 'x'.repeat(70_000) });
    f.absorb({ type: 'assistant_text_complete', messageId: 'm1', blockIndex: 0 });
    const row = eventsOf('assistant_text')[0]!;
    expect((row.payload.text as string).length).toBe(64_000);
    expect(row.payload.truncated).toBe(true);
  });
});

describe('tool call folding', () => {
  it('caps a long result and marks it truncated', () => {
    const f = folder();
    f.absorb({ type: 'tool_call', toolUse: { type: 'tool_use', id: 't1', name: 'Execute', input: { command: 'bun test' } } });
    f.absorb({ type: 'tool_result', toolUseId: 't1', content: 'y'.repeat(40_000), isError: false });
    const row = eventsOf('tool_call')[0]!;
    expect((row.payload.result as string).length).toBe(32_000);
    expect(row.payload.truncated).toBe(true);
    expect(row.payload.kind).toBe('command');
    expect(row.endedAt).not.toBeNull();
  });

  it('records the execution phase on the open span', () => {
    const f = folder();
    f.absorb({ type: 'tool_call', toolUse: { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a/b.ts' } } });
    f.absorb({ type: 'tool_execution_phase_changed', toolUseId: 't1', toolName: 'Read', phase: 'running' });
    expect(eventsOf('tool_call')[0]!.payload.execPhase).toBe('running');
  });

  it('closes dangling calls and texts when a turn dies mid-stream', () => {
    const f = folder();
    f.absorb({ type: 'tool_call', toolUse: { type: 'tool_use', id: 't1', name: 'Execute', input: { command: 'x' } } });
    f.absorb({ type: 'thinking_text_delta', messageId: 'm1', textDelta: 'half a thought' });
    f.closeDangling('turn ended before this call reported a result');
    const call = eventsOf('tool_call')[0]!;
    expect(call.endedAt).not.toBeNull();
    expect(call.payload.isError).toBe(true);
    const thought = eventsOf('thinking')[0]!;
    expect(thought.endedAt).not.toBeNull();
    expect(thought.payload.text).toBe('half a thought');
  });

  it('classifies tool kinds for the UI', () => {
    expect(toolKind('Execute')).toBe('command');
    expect(toolKind('Read')).toBe('read');
    expect(toolKind('Edit')).toBe('edit');
    expect(toolKind('Create')).toBe('edit');
    expect(toolKind('Grep')).toBe('search');
    expect(toolKind('WebFetch')).toBe('other');
  });
});

describe('the raw stream file', () => {
  it('appends every notification verbatim at structural points', () => {
    const f = folder();
    f.absorb({ type: 'thinking_text_delta', messageId: 'm1', textDelta: 'raw' });
    f.absorb({ type: 'tool_call', toolUse: { type: 'tool_use', id: 't1', name: 'Execute', input: { command: 'ls' } } });
    const lines = readFileSync(join(runsDir, runId, 'builder', 'stream.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    // The thought delta was buffered until the tool call flushed it: nothing is lost.
    expect(lines.map((l) => l.type)).toEqual(['thinking_text_delta', 'tool_call']);
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
    const support = mkdtempSync(join(tmpdir(), 'foundry-transcript-'));
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
      mode: 'rpc',
    });
    first.event({ runId: 'r1', type: 'log', name: 'before', payload: {} });
    const maxBefore = Math.max(...first.eventsAfter('r1', 0).map((e) => e.changeId));

    const second = new Tracer(openDb(dbPath), dir);
    second.event({ runId: 'r1', type: 'log', name: 'after', payload: {} });
    const after = second.eventsAfter('r1', maxBefore);
    expect(after.map((e) => e.name)).toEqual(['after']);
  });
});
