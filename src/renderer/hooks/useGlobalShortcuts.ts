import { useEffect } from 'react';
import type { DesignTab, View } from '../navigation.js';
import { designTabShortcut, isEditableTarget, viewShortcut } from '../keyboard.js';

/**
 * App-wide keyboard navigation. View chords (⌘/Ctrl+1–4, ⌘/Ctrl+,) switch
 * screens and ⌘/Ctrl+⇧+1–3 select a Design tab; a bare Escape blurs an editable
 * field, or calls `onEscape` when nothing more specific wants it. Any open
 * dialog owns Escape outright — modals already close (or deny) themselves via
 * their own listeners.
 */
export function useGlobalShortcuts({
  onNavigate,
  onDesignTab,
  onEscape,
  enabled = true,
}: {
  onNavigate: (view: View) => void;
  /** Selects a Design tab, switching to Design first if it is not current. */
  onDesignTab?: (tab: DesignTab) => void;
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
      const tab = onDesignTab ? designTabShortcut(e) : null;
      if (tab) {
        e.preventDefault();
        onDesignTab?.(tab);
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
  }, [onNavigate, onDesignTab, onEscape, enabled]);
}
