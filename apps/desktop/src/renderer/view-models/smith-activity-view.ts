import type { SmithChatEntry, SmithTranscriptEntry } from '@shared/ipc-contract.js';

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
  const failed = tools.some((entry) => entry.failed);
  const stopped = !running && tools.some((entry) => !entry.done && !entry.failed);
  const count = tools.length;
  const label = active
    ? 'Working'
    : failed
      ? 'Work failed'
      : stopped
        ? 'Work stopped'
        : 'Work complete';
  return {
    active,
    failed,
    label: count ? `${label} · ${count} ${count === 1 ? 'tool' : 'tools'}` : 'Notes',
  };
}

export function smithToolSummary(entry: SmithChatEntry): string {
  const line = entry.text.trim().split('\n', 1)[0] ?? '';
  if (!line || /^[{[]/.test(line)) {
    return entry.kind === 'note' ? 'Work notes' : `${entry.toolKind ?? 'Tool'} details`;
  }
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}
