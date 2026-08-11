import type { View } from './App.js';

/** The subset of KeyboardEvent the shortcut helpers read; keeps them testable. */
export interface ShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const VIEW_KEYS: Record<string, View> = {
  '1': 'runs',
  '2': 'pipelines',
  '3': 'roster',
  '4': 'inspector',
  ',': 'settings',
};

/**
 * Mirrors the native menu accelerators (⌘1–⌘4, ⌘,) so the same chords work
 * when the menu cannot intercept them — synthetic input (CDP automation) and
 * non-mac platforms via Ctrl. On macOS the menu consumes the real keypress
 * first, so this only ever sees events the menu did not handle.
 */
export function viewShortcut(e: ShortcutKey): View | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return null;
  return VIEW_KEYS[e.key] ?? null;
}

export function isEditableTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

export type TablistOrientation = 'horizontal' | 'vertical';

/**
 * Next tab index for a tablist, per the ARIA pattern: the arrows along the
 * list's own axis move with wrap-around, Home/End jump. Null means "not ours"
 * so the caller lets the event fall through (e.g. plain typing, Tab).
 *
 * A vertical tablist reads Up/Down instead of Left/Right, because in a stacked
 * list Left/Right is where the caret moves in the fields beside it.
 */
export function tablistStep(
  key: string,
  current: number,
  count: number,
  orientation: TablistOrientation = 'horizontal',
): number | null {
  if (count <= 0 || current < 0) return null;
  const back = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  const forward = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  switch (key) {
    case back:
      return (current - 1 + count) % count;
    case forward:
      return (current + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
