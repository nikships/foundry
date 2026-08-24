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
import { MODEL_UNSET } from '@shared/model-choice.js';
import { modelLabel } from '@shared/model-label.js';
import type { ModelInfo } from '@shared/types.js';
import { isHiddenVendorText } from '@shared/vendor-text.js';
import type { DesignTab, View } from '../utils/navigation.js';

/** One run of consecutive same-source entries, keyed by its first entry. */
export interface SmithTranscriptGroup {
  id: string;
  source: SmithTranscriptEntry['source'];
  entries: SmithTranscriptEntry[];
}

function isHiddenSmithText(entry: SmithTranscriptEntry): boolean {
  return entry.kind === 'text' && isHiddenVendorText(entry.text);
}

export function groupTranscript(entries: SmithTranscriptEntry[]): SmithTranscriptGroup[] {
  const groups: SmithTranscriptGroup[] = [];
  for (const entry of entries) {
    if (isHiddenSmithText(entry)) continue;
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

/**
 * Closed-face copy for the Smith header's model picker when nothing is chosen.
 *
 * Deliberately an instruction rather than a value. The old copy named a
 * fallback ("first reachable model"), which reads like a setting but is really
 * an unanswered question — the operator could not tell you which model it
 * meant, and neither could the app until a session opened. Smith now refuses
 * to run on an unchosen model, so this option is a prompt, not a choice.
 */
export const SMITH_MODEL_UNSET_LABEL = 'Select a model…';

/**
 * How the header names the model, given what the chat resolved.
 *
 * Prefers the catalog's display name, falls back to the bare id so an unknown
 * model still reads as itself rather than as a fallback.
 */
export function smithModelLabel(chosen: string | null | undefined, models: ModelInfo[]): string {
  if (!chosen || chosen === MODEL_UNSET) return SMITH_MODEL_UNSET_LABEL;
  const info = models.find((model) => model.id === chosen);
  return info?.displayName || modelLabel(chosen);
}

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
  switch (view) {
    case 'runs':
      return position.openRunId
        ? { route: 'run-detail', entity: { kind: 'run', id: position.openRunId } }
        : { route: view };
    case 'inspector':
      return position.inspectorRunId
        ? { route: 'inspector', entity: { kind: 'run', id: position.inspectorRunId } }
        : { route: view };
    case 'design':
      return { route: `design/${position.designTab}` };
    case 'settings':
      return { route: 'settings', entity: { kind: 'settings', id: position.settingsPane } };
    default:
      return { route: view };
  }
}
