/**
 * Folding a turn's event stream into trace rows.
 *
 * The stream is deltas: a naive mapping writes a row per token and buries the
 * db, so the fold keeps one spanning row per tool call and one growing row per
 * text block. What this suite pins is that the compression never loses
 * anything — the raw JSONL keeps every event verbatim, a truncated row says so,
 * and a turn that dies mid-call leaves no row that never ends.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from './tmp.js';
import { EventFolder, labelToolCall, toolKind, toUsageBreakdown } from '../src/main/pi/events.js';
import type { TransportEvent, TurnUsage } from '../src/main/pi/transport.js';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import type { PipelineDef } from '../src/shared/types.js';

const PIPELINE: PipelineDef = {
  id: 'pi-events',
  name: 'pi-events',
  description: 'pi events unit',
  acceptance: { kind: 'all_phases_pass' },
  phases: [],
};

interface Harness {
  tracer: Tracer;
  runId: string;
  phaseId: string;
  /** Advances the fold's clock, so the text throttle is deterministic. */
  advance(ms: number): void;
  folder(onText?: (text: string) => void): EventFolder;
  events(): ReturnType<Tracer['eventsAfter']>;
  stream(): string[];
}

function harness(): Harness {
  const support = tempDir('foundry-pi-events-');
  const repo = tempDir('foundry-pi-events-repo-');
  const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  const runId = `run_ev_${Date.now().toString(36)}`;
  tracer.startRun({
    runId,
    projectId: 'p',
    pipeline: PIPELINE,
    request: 'events',
    engineer: 'tester',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
  });
  const phaseId = tracer.openPhase({
    runId,
    seq: 0,
    name: 'build',
    kind: 'agent',
    owner: 'builder',
    description: 'pi events unit',
  });

  let clock = 1_000;
  return {
    tracer,
    runId,
    phaseId,
    advance: (ms) => {
      clock += ms;
    },
    folder: (onText) =>
      new EventFolder({
        tracer,
        runId,
        phaseId,
        agent: 'builder',
        now: () => clock,
        ...(onText ? { onText } : {}),
      }),
    events: () => tracer.eventsAfter(runId, 0, 1000),
    stream: () => {
      const path = join(tracer.runDir(runId), 'builder/stream.jsonl');
      if (!existsSync(path)) return [];
      return readFileSync(path, 'utf8').split('\n').filter(Boolean);
    },
  };
}

const usage: TurnUsage = {
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationTokens: 3,
  cacheReadTokens: 4,
  thinkingTokens: 5,
  cost: 0.0012,
};

function feed(folder: EventFolder, events: TransportEvent[]): void {
  for (const event of events) folder.absorb(event);
}

describe('tool kinds and labels', () => {
  it('names a kind for every tool the transport enables', () => {
    expect(toolKind('bash')).toBe('command');
    expect(toolKind('read')).toBe('read');
    expect(toolKind('edit')).toBe('edit');
    expect(toolKind('write')).toBe('edit');
    expect(toolKind('grep')).toBe('search');
    expect(toolKind('find')).toBe('search');
    expect(toolKind('ls')).toBe('search');
    expect(toolKind('report_progress')).toBe('progress');
    expect(toolKind('submit_envelope')).toBe('envelope');
    expect(toolKind('read_phase_context')).toBe('envelope');
    expect(toolKind('anything_else')).toBe('other');
  });

  it('labels a call so the trace reads like a build log', () => {
    expect(labelToolCall('bash', { command: 'npm test' })).toBe('bash: npm test');
    expect(labelToolCall('read', { path: 'src/app.ts' })).toBe('read: src/app.ts');
    expect(labelToolCall('grep', { pattern: 'TODO' })).toBe('grep: TODO');
    expect(labelToolCall('report_progress', { summary: 'looked around' })).toBe(
      'progress: looked around',
    );
  });

  it('keeps a label to one short line, whatever the argument was', () => {
    const label = labelToolCall('bash', { command: `echo one\necho two` });
    expect(label).toBe('bash: echo one');
    const long = labelToolCall('bash', { command: 'x'.repeat(500) });
    expect(long.length).toBeLessThan(140);
    expect(long.endsWith('…')).toBe(true);
  });

  it('shortens a deep path rather than filling the row with directories', () => {
    expect(labelToolCall('read', { path: 'a/b/c/d/e.ts' })).toBe('read: …/d/e.ts');
  });

  it('falls back to a tool’s own name when nothing describes the call', () => {
    expect(labelToolCall('bash', {})).toBe('bash');
    expect(labelToolCall('some_future_tool', {})).toBe('some_future_tool');
    expect(labelToolCall('some_future_tool', { query: 'widgets' })).toBe(
      'some_future_tool: widgets',
    );
  });
});

describe('usage', () => {
  it('reports zeroes, marked unreported, when the turn produced no usage', () => {
    expect(toUsageBreakdown(null)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      cost: 0,
      reported: false,
    });
  });

  it('carries the real cost through', () => {
    expect(toUsageBreakdown(usage)).toEqual({ ...usage, reported: true });
  });
});

describe('folding a tool call', () => {
  it('writes one spanning row per call and closes it on the result', () => {
    const h = harness();
    const folder = h.folder();
    feed(folder, [
      { type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'npm test' } },
      { type: 'tool_result', callId: 'c1', content: 'all green', isError: false },
    ]);

    const calls = h.events().filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('bash: npm test');
    expect(calls[0]!.payload).toMatchObject({
      tool: 'bash',
      kind: 'command',
      toolUseId: 'c1',
      result: 'all green',
      isError: false,
    });
    expect(calls[0]!.endedAt).toBeTruthy();
  });

  it('ignores a duplicate call id rather than opening a second row for it', () => {
    const h = harness();
    const folder = h.folder();
    feed(folder, [
      { type: 'tool_call', callId: 'c1', tool: 'read', input: { path: 'a.ts' } },
      { type: 'tool_call', callId: 'c1', tool: 'read', input: { path: 'a.ts' } },
      { type: 'tool_result', callId: 'c1', content: 'contents', isError: false },
    ]);
    expect(h.events().filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });

  it('ignores a result for a call it never saw', () => {
    const h = harness();
    h.folder().absorb({ type: 'tool_result', callId: 'ghost', content: 'x', isError: false });
    expect(h.events().filter((e) => e.type === 'tool_call')).toHaveLength(0);
  });

  it('caps a huge result and says it truncated, with the whole thing in the raw record', () => {
    const h = harness();
    const folder = h.folder();
    const huge = 'y'.repeat(40_000);
    feed(folder, [
      { type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'cat big' } },
      { type: 'tool_result', callId: 'c1', content: huge, isError: false },
    ]);

    const row = h.events().find((e) => e.type === 'tool_call')!;
    expect(String(row.payload.result).length).toBe(32_000);
    expect(row.payload.truncated).toBe(true);
    // A capped row is a display decision, never a loss: stream.jsonl has it all.
    expect(h.stream().join('').includes(huge)).toBe(true);
  });

  it('caps a huge argument in place and flags which one it was', () => {
    const h = harness();
    const folder = h.folder();
    feed(folder, [
      {
        type: 'tool_call',
        callId: 'c1',
        tool: 'write',
        input: { path: 'big.txt', content: 'z'.repeat(20_000) },
      },
    ]);
    const row = h.events().find((e) => e.type === 'tool_call')!;
    const args = row.payload.args as Record<string, unknown>;
    expect(String(args.content).length).toBe(16_001);
    expect(args.contentTruncated).toBe(true);
    // Only the oversized argument is touched.
    expect(args.path).toBe('big.txt');
  });

  it('patches an open tool row as streamed output arrives', () => {
    const h = harness();
    const folder = h.folder();
    folder.absorb({ type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'ls' } });
    folder.absorb({ type: 'tool_output', callId: 'c1', content: 'a.ts\n' });
    const row = h.events().find((e) => e.type === 'tool_call')!;
    expect(row.payload.result).toBe('a.ts\n');
    expect(row.payload.execPhase).toBe('running');
    expect(row.endedAt).toBeFalsy();
    folder.absorb({ type: 'tool_result', callId: 'c1', content: 'a.ts\nb.ts\n', isError: false });
    expect(h.events().find((e) => e.type === 'tool_call')!.payload.result).toBe('a.ts\nb.ts\n');
  });

  it('records a provider retry as a log, not as silence', () => {
    const h = harness();
    h.folder().absorb({
      type: 'retry',
      attempt: 2,
      maxAttempts: 3,
      message: 'stream dropped',
    });
    const row = h.events().find((e) => e.type === 'log');
    expect(row?.name).toMatch(/retry/);
    expect(row?.payload.attempt).toBe(2);
  });

  it('records an error result as an error rather than as prose', () => {
    const h = harness();
    const folder = h.folder();
    feed(folder, [
      { type: 'tool_call', callId: 'c1', tool: 'write', input: { path: '/etc/hosts' } },
      {
        type: 'tool_result',
        callId: 'c1',
        content: 'blocked: outside the worktree',
        isError: true,
      },
    ]);
    expect(h.events().find((e) => e.type === 'tool_call')!.payload.isError).toBe(true);
  });
});

describe('folding text', () => {
  it('writes one row per block and patches it as the block grows', () => {
    const h = harness();
    const folder = h.folder();
    folder.absorb({ type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'Hello ' });
    // Inside the throttle window: the delta is kept, the row is not rewritten.
    folder.absorb({ type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'there ' });
    h.advance(300);
    folder.absorb({ type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'world' });

    const rows = h.events().filter((e) => e.type === 'assistant_text');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.text).toBe('Hello there world');
  });

  it('closes a block with the full text, throttled deltas included', () => {
    const h = harness();
    const folder = h.folder();
    // Every delta lands inside one throttle window, so none of them was ever
    // written: a throttle that lost text would show up as a short row here.
    for (const delta of ['a', 'b', 'c', 'd']) {
      folder.absorb({ type: 'text_delta', messageId: 'm1', blockIndex: 0, delta });
    }
    folder.absorb({ type: 'text_end', messageId: 'm1', blockIndex: 0 });

    const row = h.events().find((e) => e.type === 'assistant_text')!;
    expect(row.payload.text).toBe('abcd');
    expect(row.endedAt).toBeTruthy();
  });

  it('keeps separate rows for separate blocks and messages', () => {
    const h = harness();
    const folder = h.folder();
    feed(folder, [
      { type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'first' },
      { type: 'text_delta', messageId: 'm1', blockIndex: 1, delta: 'second' },
      { type: 'text_delta', messageId: 'm2', blockIndex: 0, delta: 'third' },
    ]);
    expect(
      h
        .events()
        .filter((e) => e.type === 'assistant_text')
        .map((e) => e.payload.text),
    ).toEqual(['first', 'second', 'third']);
  });

  it('files thinking separately from the answer', () => {
    const h = harness();
    const folder = h.folder();
    feed(folder, [
      { type: 'thinking_delta', messageId: 'm1', delta: 'weighing options' },
      { type: 'thinking_end', messageId: 'm1' },
      { type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'the answer' },
      { type: 'text_end', messageId: 'm1', blockIndex: 0 },
    ]);
    const byType = h.events().map((e) => `${e.type}:${e.payload.text ?? ''}`);
    expect(byType).toContain('thinking:weighing options');
    expect(byType).toContain('assistant_text:the answer');
  });

  it('caps a block that arrives as one enormous delta', () => {
    const h = harness();
    h.folder().absorb({
      type: 'text_delta',
      messageId: 'm1',
      blockIndex: 0,
      delta: 'q'.repeat(70_000),
    });
    const row = h.events().find((e) => e.type === 'assistant_text')!;
    expect(String(row.payload.text).length).toBe(64_000);
    expect(row.payload.truncated).toBe(true);
  });

  it('feeds the live tail without storing it', () => {
    const h = harness();
    const seen: string[] = [];
    const folder = h.folder((text) => seen.push(text));
    feed(folder, [
      { type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'tick ' },
      { type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'tock' },
      // Thinking is not the answer, so it stays out of the phase panel's tail.
      { type: 'thinking_delta', messageId: 'm1', delta: 'hmm' },
    ]);
    expect(seen).toEqual(['tick ', 'tock']);
  });
});

describe('a turn that ends mid-call', () => {
  it('closes every dangling row with the reason, as an error', () => {
    const h = harness();
    const folder = h.folder();
    feed(folder, [
      { type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'sleep 100' } },
      { type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'partial answ' },
    ]);
    folder.closeDangling('the run was killed');

    const call = h.events().find((e) => e.type === 'tool_call')!;
    expect(call.payload.result).toBe('the run was killed');
    expect(call.payload.isError).toBe(true);
    expect(call.endedAt).toBeTruthy();
    // The partial text is kept rather than dropped: it is what the agent said.
    const text = h.events().find((e) => e.type === 'assistant_text')!;
    expect(text.payload.text).toBe('partial answ');
    expect(text.endedAt).toBeTruthy();
  });

  it('is idempotent, so a second close writes nothing further', () => {
    const h = harness();
    const folder = h.folder();
    folder.absorb({ type: 'tool_call', callId: 'c1', tool: 'ls', input: {} });
    folder.closeDangling('first');
    folder.closeDangling('second');
    expect(h.events().find((e) => e.type === 'tool_call')!.payload.result).toBe('first');
  });
});

describe('the raw record', () => {
  it('keeps every event verbatim, in order', () => {
    const h = harness();
    const folder = h.folder();
    const events: TransportEvent[] = [
      { type: 'tool_call', callId: 'c1', tool: 'ls', input: { path: '.' } },
      { type: 'tool_result', callId: 'c1', content: 'a.ts', isError: false },
      { type: 'text_delta', messageId: 'm1', blockIndex: 0, delta: 'done' },
      { type: 'text_end', messageId: 'm1', blockIndex: 0 },
      { type: 'usage', usage },
    ];
    feed(folder, events);

    expect(h.stream().map((line) => JSON.parse(line))).toEqual(events);
  });

  it('reports the turn’s usage off the last usage event', () => {
    const h = harness();
    const folder = h.folder();
    folder.absorb({ type: 'usage', usage: { ...usage, outputTokens: 1 } });
    folder.absorb({ type: 'usage', usage });
    // The transport reports a running total, so the last one is the turn's.
    expect(folder.usage).toEqual(usage);
  });
});
