/**
 * Bound the `smith_runs` events page so a long run cannot dump a megabyte of
 * trace JSON into the chat. Spark (and most chat models) 400 on that payload,
 * and the blob then stays in session history.
 *
 * The Inspector still reads the full `eventPage` over IPC. Only the model-facing
 * tool result is compacted here.
 */

import type { EventPage } from '@shared/ipc-contract.js';
import type { EventRow } from '@shared/types.js';

export const SMITH_EVENT_PAGE_SIZE = 40;
export const SMITH_EVENT_JSON_BUDGET = 16_384;
export const SMITH_EVENT_STRING_CAP = 400;

export interface SmithEventPage {
  events: EventRow[];
  cursor: number;
  hasMore: boolean;
  truncated: boolean;
}

/** Compact an `events` IPC result. Non-pages pass through unchanged. */
export function compactSmithRunEvents(value: unknown): unknown {
  const page = asEventPage(value);
  return page ? compactEventPage(page) : value;
}

function asEventPage(value: unknown): EventPage | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { events?: unknown; cursor?: unknown };
  if (!Array.isArray(record.events) || typeof record.cursor !== 'number') return null;
  return { events: record.events as EventRow[], cursor: record.cursor };
}

function compactEventPage(page: EventPage): SmithEventPage {
  const slimmed = page.events.map(slimEvent);
  const events = takeBudget(slimmed.slice(0, SMITH_EVENT_PAGE_SIZE));
  const truncated =
    events.length < page.events.length ||
    events.some(
      (event, index) =>
        JSON.stringify(event.payload) !== JSON.stringify(page.events[index]?.payload),
    );
  const cursor = events.length ? Math.max(...events.map((event) => event.changeId)) : page.cursor;
  return {
    events,
    cursor,
    hasMore: events.length < page.events.length,
    truncated,
  };
}

function takeBudget(events: EventRow[]): EventRow[] {
  const kept = [...events];
  while (kept.length > 1 && JSON.stringify(kept).length > SMITH_EVENT_JSON_BUDGET) {
    kept.pop();
  }
  return kept;
}

function slimEvent(event: EventRow): EventRow {
  return { ...event, payload: slimValue(event.payload) as Record<string, unknown> };
}

function slimValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= SMITH_EVENT_STRING_CAP) return value;
    const omitted = value.length - SMITH_EVENT_STRING_CAP;
    return `${value.slice(0, SMITH_EVENT_STRING_CAP)}…[truncated ${omitted} chars]`;
  }
  if (Array.isArray(value)) return value.map(slimValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = slimValue(entry);
    return out;
  }
  return value;
}
