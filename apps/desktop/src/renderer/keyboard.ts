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

/**
 * ⌘/Ctrl+6 opens Smith. It is not in `VIEW_KEYS` because Smith is a modal, not
 * a `View` — the same reason its sidebar item never reads as the active view.
 */
export function isSmithShortcut(e: ShortcutKey): boolean {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return false;
  return e.key === '6';
}

export function isEditableTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/**
 * Next tab index for a tablist, per the ARIA pattern:
 * Left/Right (or Up/Down for vertical) move with wrap-around, Home/End jump.
 * Null means "not ours" so the caller lets the event fall through.
 */
export function tablistStep(
  key: string,
  current: number,
  count: number,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): number | null {
  if (count <= 0 || current < 0) return null;
  const prevKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  switch (key) {
    case prevKey:
      return (current - 1 + count) % count;
    case nextKey:
      return (current + 1) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
