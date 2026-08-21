/**
 * Pure derivation for the Smith chat surface, kept free of React so the
 * grouping and the screen-context descriptor are testable without a DOM.
 *
 * The transcript arrives as a flat array of folded rows (`SmithTranscriptEntry`
 * is a `PanelEntry` stamped with who produced it). The screen renders it as
 * runs of same-source entries: operator turns read as chat bubbles, Smith's
 * work as inspector-style tool rows, and readiness sub-agent turns as a
 * visually distinct block — like run phases in the Inspector.
 */

import type { SmithScreenContext, SmithTranscriptEntry } from '@shared/ipc-contract.js';
import type { DesignTab, View } from '../utils/navigation.js';

/** One run of consecutive same-source entries, keyed by its first entry. */
export interface SmithTranscriptGroup {
  id: string;
  source: SmithTranscriptEntry['source'];
  entries: SmithTranscriptEntry[];
}

export function groupTranscript(entries: SmithTranscriptEntry[]): SmithTranscriptGroup[] {
  const groups: SmithTranscriptGroup[] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last && last.source === entry.source) {
      last.entries.push(entry);
    } else {
      groups.push({ id: entry.id, source: entry.source, entries: [entry] });
    }
  }
  return groups;
}

/**
 * Tool-row icons, same vocabulary as the detection and readiness panels so
 * the transcripts cannot drift apart visually.
 */
export const SMITH_TOOL_ICON: Record<string, string> = {
  command: '⚙',
  read: '◇',
  edit: '✎',
  search: '⌕',
  other: '·',
};

/** What the app shell knows about the operator's position, for `describeScreen`. */
export interface ScreenPosition {
  openRunId: string;
  inspectorRunId: string;
  designTab: DesignTab;
  settingsPane: string;
}

/**
 * The compact descriptor sent with each `smith:send`, so "why did this run
 * fail?" resolves without the user naming the run. The shell computes it from
 * whatever screen the operator was on before opening Smith — never from the
 * Smith screen itself, which would describe nothing.
 */
export function describeScreen(view: View, position: ScreenPosition): SmithScreenContext {
  if (view === 'runs' && position.openRunId) {
    return { route: 'run-detail', entity: { kind: 'run', id: position.openRunId } };
  }
  if (view === 'inspector' && position.inspectorRunId) {
    return { route: 'inspector', entity: { kind: 'run', id: position.inspectorRunId } };
  }
  if (view === 'design') {
    return { route: `design/${position.designTab}` };
  }
  if (view === 'settings') {
    return { route: 'settings', entity: { kind: 'settings', id: position.settingsPane } };
  }
  return { route: view };
}
