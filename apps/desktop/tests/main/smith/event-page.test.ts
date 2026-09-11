import { describe, expect, it } from 'vitest';
import type { EventRow } from '../../../src/shared/types.js';
import {
  compactSmithRunEvents,
  SMITH_EVENT_JSON_BUDGET,
  SMITH_EVENT_PAGE_SIZE,
  SMITH_EVENT_STRING_CAP,
} from '../../../src/main/smith/event-page.js';

function row(changeId: number, payload: Record<string, unknown> = {}): EventRow {
  return {
    rowid: changeId,
    changeId,
    eventId: `e${changeId}`,
    runId: 'r1',
    phaseId: 'p1',
    parentId: null,
    type: 'log',
    name: 'reviewer: retry',
    payload,
    tokens: 0,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
  };
}

describe('compactSmithRunEvents', () => {
  it('passes through a non-page result unchanged', () => {
    expect(compactSmithRunEvents('normalized')).toBe('normalized');
    expect(compactSmithRunEvents(null)).toBeNull();
  });

  it('leaves a small page intact', () => {
    const events = [row(1, { message: 'ok' }), row(2, { message: 'still ok' })];
    expect(compactSmithRunEvents({ events, cursor: 2 })).toEqual({
      events,
      cursor: 2,
      hasMore: false,
      truncated: false,
    });
  });

  it('returns one bounded page instead of the whole run', () => {
    const events = Array.from({ length: SMITH_EVENT_PAGE_SIZE + 12 }, (_, i) =>
      row(i + 1, { n: i + 1 }),
    );
    const compacted = compactSmithRunEvents({ events, cursor: events.at(-1)!.changeId }) as {
      events: EventRow[];
      cursor: number;
      hasMore: boolean;
    };
    expect(compacted.events).toHaveLength(SMITH_EVENT_PAGE_SIZE);
    expect(compacted.events.at(-1)!.changeId).toBe(SMITH_EVENT_PAGE_SIZE);
    expect(compacted.cursor).toBe(SMITH_EVENT_PAGE_SIZE);
    expect(compacted.hasMore).toBe(true);
  });

  it('truncates huge payload strings so Spark cannot be 400d by a tool dump', () => {
    const blob = 'x'.repeat(8_000);
    const compacted = compactSmithRunEvents({
      events: [row(1, { result: blob, nested: { text: blob } })],
      cursor: 1,
    }) as { events: EventRow[]; truncated: boolean };
    const result = compacted.events[0]!.payload.result as string;
    expect(result.length).toBeLessThan(blob.length);
    expect(result).toContain('truncated');
    expect(result.startsWith('x'.repeat(SMITH_EVENT_STRING_CAP))).toBe(true);
    expect((compacted.events[0]!.payload.nested as { text: string }).text).toContain('truncated');
    expect(compacted.truncated).toBe(true);
  });

  it('drops events to stay under the JSON budget', () => {
    const fat = {
      events: Array.from({ length: SMITH_EVENT_PAGE_SIZE }, (_, i) =>
        row(i + 1, { blob: 'y'.repeat(SMITH_EVENT_STRING_CAP) }),
      ),
      cursor: SMITH_EVENT_PAGE_SIZE,
    };
    const compacted = compactSmithRunEvents(fat) as { events: EventRow[]; hasMore: boolean };
    expect(JSON.stringify(compacted.events).length).toBeLessThanOrEqual(SMITH_EVENT_JSON_BUDGET);
    expect(compacted.events.length).toBeGreaterThan(0);
    expect(compacted.events.length).toBeLessThan(SMITH_EVENT_PAGE_SIZE);
    expect(compacted.hasMore).toBe(true);
  });
});
