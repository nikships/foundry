/**
 * `TranscriptEntry` ends in `default: return null`, so an event type nobody
 * added a case for is not a rendering bug anyone can see — it is simply absent
 * from the timeline. These tests render the entry to markup and assert the row
 * exists, which is the only way that silence fails a suite instead of a review.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EventRow, EventType } from '../src/shared/types.js';
import { TranscriptEntry } from '../src/renderer/components/inspector/entries.js';

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
                totalTokens: 15,
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
