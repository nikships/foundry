/**
 * What the agent edit pane should do with the current grid selection.
 *
 * The pane holds a draft rather than reading the store directly (edits are
 * autosaved, so the draft is ahead of the persisted agent), which means the
 * moment the selection moves has to be recognised explicitly. Kept as a pure
 * function so the transitions can be tested without an Electron window.
 *
 * - `sync`  — load the selected agent into the draft.
 * - `keep`  — leave the draft alone: no selection has resolved yet, which
 *   happens for a beat during a rename (the new name is selected before the
 *   store refresh lands). Clearing there would tear the editor down and back up.
 * - `clear` — there is nothing to edit at all.
 */
export type DraftSyncAction = 'sync' | 'keep' | 'clear';

export function draftSyncAction({
  selectedName,
  hasAgents,
  lastSyncedName,
}: {
  /** Name of the agent the grid has focused, or null if it resolved to none. */
  selectedName: string | null;
  /** Whether any agent exists at all. */
  hasAgents: boolean;
  /** Name the draft was last loaded from, or null if never. */
  lastSyncedName: string | null;
}): DraftSyncAction {
  if (!selectedName) return hasAgents ? 'keep' : 'clear';
  return selectedName === lastSyncedName ? 'keep' : 'sync';
}
