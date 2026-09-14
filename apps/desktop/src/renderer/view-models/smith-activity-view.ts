import type { SmithChatEntry, SmithTranscriptEntry } from '@shared/ipc-contract.js';
import { duration } from '../utils/format.js';

export type SmithActivityItem =
  | { kind: 'activity'; id: string; entries: SmithChatEntry[] }
  | { kind: 'entry'; id: string; entry: SmithTranscriptEntry };

export function smithActivityItems(entries: SmithTranscriptEntry[]): SmithActivityItem[] {
  const items: SmithActivityItem[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'tool' && entry.kind !== 'note') {
      items.push({ kind: 'entry', id: entry.id, entry });
      continue;
    }
    const last = items.at(-1);
    if (last?.kind === 'activity') last.entries.push(entry);
    else items.push({ kind: 'activity', id: entry.id, entries: [entry] });
  }
  return items;
}

function activityElapsedMs(entries: SmithChatEntry[]): number {
  if (entries.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const entry of entries) {
    const start = typeof entry.at === 'number' ? entry.at : 0;
    const dur =
      typeof (entry as { durationMs?: number }).durationMs === 'number'
        ? (entry as { durationMs?: number }).durationMs!
        : 0;
    const end =
      typeof (entry as { endedAt?: number }).endedAt === 'number'
        ? (entry as { endedAt?: number }).endedAt!
        : start + dur;
    if (start < min) min = start;
    if (end > max) max = end;
  }
  if (!isFinite(min) || !isFinite(max) || max < min) return 0;
  return max - min;
}

export function smithActivityStatus(
  entries: SmithChatEntry[],
  running: boolean,
): {
  active: boolean;
  failed: boolean;
  label: string;
} {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const active = running && tools.some((entry) => !entry.done && !entry.failed);
  const stopped = !running && tools.some((entry) => !entry.done && !entry.failed);
  const count = tools.length;

  const hasFailed = tools.some((entry) => entry.failed);
  const hasSuccessful = tools.some(
    (entry) => !entry.failed && (entry.done || (!active && !stopped)),
  );
  const partialFailure = hasFailed && hasSuccessful;
  const failed = !partialFailure && hasFailed;

  let label: string;
  if (!count) {
    label = 'Notes';
  } else if (partialFailure) {
    const elapsed = activityElapsedMs(entries);
    label = `${count} ${count === 1 ? 'tool' : 'tools'} · ${duration(elapsed)}`;
  } else {
    const state = active
      ? 'Working'
      : failed
        ? 'Work failed'
        : stopped
          ? 'Work stopped'
          : 'Work complete';
    label = `${state} · ${count} ${count === 1 ? 'tool' : 'tools'}`;
  }

  return {
    active,
    failed,
    label,
  };
}

export function smithToolSummary(entry: SmithChatEntry): string {
  const line = entry.text.trim().split('\n', 1)[0] ?? '';
  if (!line || /^[{[]/.test(line)) {
    return entry.kind === 'note' ? 'Work notes' : `${entry.toolKind ?? 'Tool'} details`;
  }
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}
