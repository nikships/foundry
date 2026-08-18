/**
 * `TranscriptEntry` ends in `default: return null`, so an event type nobody
 * added a case for is not a rendering bug anyone can see — it is simply absent
 * from the timeline. These tests render the entry to markup and assert the row
 * exists, which is the only way that silence fails a suite instead of a review.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EventRow, EventType, UsageBreakdown } from '../src/shared/types.js';
import { TranscriptEntry } from '../src/renderer/components/inspector/entries.js';
import { BUILTIN_TOOLS } from '../src/main/pi/tools.js';
import { toolKind } from '../src/main/pi/events.js';

function event(type: EventType, payload: Record<string, unknown> = {}): EventRow {
  return {
    rowid: 1,
    changeId: 1,
    eventId: 'evt_1',
    runId: 'run_1',
    phaseId: 'ph_1',
    parentId: null,
    type,
    name: 'planner',
    payload,
    tokens: 0,
    startedAt: '2026-08-10T12:34:56.000Z',
    endedAt: '2026-08-10T12:34:56.000Z',
  };
}

function render(row: EventRow): string {
  return renderToStaticMarkup(createElement(TranscriptEntry, { event: row }));
}

const compaction = (payload: Record<string, unknown>): string =>
  render(event('compaction', payload));

describe('a compaction event in the timeline', () => {
  it('renders a row, so a recorded compaction is never silently invisible', () => {
    const html = compaction({
      removedCount: 41,
      before: { used: 82_000, limit: 100_000 },
      after: { used: 31_000, limit: 100_000 },
    });
    expect(html).not.toBe('');
    expect(html).toContain('compacted');
  });

  it('names what was dropped and how much room it bought', () => {
    const html = compaction({
      removedCount: 41,
      before: { used: 82_000, limit: 100_000 },
      after: { used: 31_000, limit: 100_000 },
    });
    expect(html).toContain('41 messages removed');
    expect(html).toContain('82% → 31%');
  });

  it('says one message rather than 1 messages', () => {
    const html = compaction({
      removedCount: 1,
      before: { used: 82_000, limit: 100_000 },
      after: { used: 80_000, limit: 100_000 },
    });
    expect(html).toContain('1 message removed');
    expect(html).not.toContain('1 messages');
  });

  it('still renders when the after-stats never arrived, which the engine allows', () => {
    // `AgentSession.compact()` omits `after` when the follow-up stats call
    // failed: the compaction still happened and must still be visible.
    const html = compaction({ removedCount: 12, before: { used: 90_000, limit: 100_000 } });
    expect(html).toContain('compacted');
    expect(html).toContain('12 messages removed');
    expect(html).toContain('from 90%');
  });

  it('renders the row even with an empty payload rather than a blank entry', () => {
    const html = compaction({});
    expect(html).toContain('compacted');
  });
});

describe('a pi tool call in the timeline', () => {
  /** A `tool_call` row as the tracer writes one: `<tool>: <summary>`. */
  const toolCall = (name: string, payload: Record<string, unknown> = {}): string => {
    const row = event('tool_call', { result: 'ok', ...payload });
    return render({ ...row, name: `${name}: target` });
  };

  // The renderer classifies off the row's own name, and pi's tool names are not
  // droid's. `toolKind` is main's answer for the same tool; the two are read by
  // the same operator on the same row, so they must not disagree.
  const RENDERED_CLASS: Record<string, string> = {
    command: 'te command',
    read: 'te read',
    edit: 'te edit',
    search: 'te read',
    progress: 'te tool',
    envelope: 'te tool',
    other: 'te tool',
  };

  it('formats every tool a pi phase is given, in agreement with main', () => {
    const piTools = [...BUILTIN_TOOLS, 'report_progress', 'read_phase_context', 'submit_envelope'];
    for (const tool of piTools) {
      const html = toolCall(tool);
      expect(html, tool).toContain(RENDERED_CLASS[toolKind(tool)]!);
    }
  });

  it('reads a bash call as a command rather than an anonymous tool row', () => {
    // droid called it Execute; pi calls it bash. The `$` prompt is the whole
    // difference between a shell line and a generic row.
    const html = toolCall('bash', { args: { command: 'npm test' } });
    expect(html).toContain('npm test');
    expect(html).toContain('$');
  });

  it('files find and ls with grep rather than leaving them generic', () => {
    for (const tool of ['grep', 'find', 'ls']) {
      expect(toolCall(tool), tool).toContain('te read');
    }
  });

  it('renders a tool nobody classified rather than dropping the row', () => {
    // A tool added to pi, or one an MCP server contributes, reaches the timeline
    // before this file learns its name. The fallback is what keeps it visible.
    const html = toolCall('some_future_tool');
    expect(html).not.toBe('');
    expect(html).toContain('some_future_tool');
    expect(html).toContain('te tool');
  });
});

describe('what a turn cost', () => {
  const usage = (over: Partial<UsageBreakdown> = {}): UsageBreakdown => ({
    inputTokens: 1_000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 800,
    thinkingTokens: 0,
    credits: 0,
    cost: 0,
    reported: true,
    ...over,
  });

  it('is stated in dollars, which is what a pi turn reports', () => {
    const html = render(event('agent_end', { usage: usage({ cost: 0.42 }) }));
    expect(html).toContain('$0.42');
    expect(html).not.toContain('credits');
  });

  it('shows sub-cent turns at a precision that is not just $0.00', () => {
    const html = render(event('agent_end', { usage: usage({ cost: 0.0031 }) }));
    expect(html).toContain('$0.0031');
  });

  // Historical rows from the droid transport carry credits and no cost. Printing
  // "$0" for them would state a price that was never measured.
  it('omits the figure for a turn that reported no cost', () => {
    const html = render(event('agent_end', { usage: usage({ credits: 42 }) }));
    expect(html).toContain('tokens');
    expect(html).not.toContain('$');
  });

  it('says usage was unreported rather than showing a zero', () => {
    const html = render(event('agent_end', { usage: usage({ reported: false }) }));
    expect(html).toContain('usage unreported by this model');
    expect(html).not.toContain('$');
  });
});

describe('the entry switch', () => {
  it('renders every event type the engine records except the structural ones', () => {
    // phase/agent boundaries are lane furniture, not transcript rows: the lane
    // header already says whose phase this is and how it went.
    const structural: EventType[] = ['agent_start', 'phase_start', 'phase_end'];
    const types: EventType[] = [
      'phase_start',
      'phase_end',
      'agent_start',
      'agent_end',
      'tool_call',
      'assistant_text',
      'thinking',
      'handoff',
      'gate_pass',
      'gate_fail',
      'correction',
      'interrupt',
      'compaction',
      'log',
      'error',
    ];
    for (const type of types) {
      const payload =
        type === 'agent_end'
          ? {
              usage: {
                inputTokens: 10,
                outputTokens: 5,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
                thinkingTokens: 0,
                credits: 0,
                cost: 0,
                reported: true,
              },
            }
          : { text: 'hello', detail: 'detail' };
      const html = render(event(type, payload));
      if (structural.includes(type)) expect(html, type).toBe('');
      else expect(html, type).not.toBe('');
    }
  });
});
