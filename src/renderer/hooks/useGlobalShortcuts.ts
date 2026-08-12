import { useEffect } from 'react';
import type { View } from '../App.js';
import { isEditableTarget, viewShortcut } from '../keyboard.js';

/**
 * App-wide keyboard navigation. View chords (⌘/Ctrl+1–4, ⌘/Ctrl+,) switch
 * screens; a bare Escape blurs an editable field, or calls `onEscape` when
 * nothing more specific wants it. Any open dialog owns Escape outright —
 * modals already close (or deny) themselves via their own listeners.
 */
export function useGlobalShortcuts({
  onNavigate,
  onEscape,
  enabled = true,
}: {
  onNavigate: (view: View) => void;
  onEscape?: () => void;
  enabled?: boolean;
}): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      const view = viewShortcut(e);
      if (view) {
        e.preventDefault();
        onNavigate(view);
        return;
      }
      if (e.key !== 'Escape' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (isEditableTarget(e.target)) {
        (e.target as HTMLElement).blur();
        return;
      }
      onEscape?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onNavigate, onEscape, enabled]);
}
