import { useEffect } from 'react';
import type { DesignTab, View } from '../navigation.js';
import {
  designTabShortcut,
  isEditableTarget,
  settingsSearchShortcut,
  viewShortcut,
} from '../keyboard.js';

/**
 * App-wide keyboard navigation. View chords (⌘/Ctrl+1–4, ⌘/Ctrl+,) switch
 * screens, ⌘/Ctrl+⇧+1–3 select a Design tab, and ⌘/Ctrl+K opens the settings
 * search palette; a bare Escape blurs an editable field, or calls `onEscape`
 * when nothing more specific wants it. Any open dialog owns Escape outright —
 * modals already close (or deny) themselves via their own listeners.
 */
export function useGlobalShortcuts({
  onNavigate,
  onDesignTab,
  onEscape,
  onSettingsSearch,
  enabled = true,
}: {
  onNavigate: (view: View) => void;
  /** Selects a Design tab, switching to Design first if it is not current. */
  onDesignTab?: (tab: DesignTab) => void;
  onEscape?: () => void;
  /** ⌘/Ctrl+K — opens Settings with its search palette raised. */
  onSettingsSearch?: () => void;
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
      // A dialog (including the palette itself) owns ⌘K: opening another layer
      // over an interrupt or a confirm would bury the thing that needs an answer.
      if (
        onSettingsSearch &&
        settingsSearchShortcut(e) &&
        !document.querySelector('[role="dialog"]')
      ) {
        e.preventDefault();
        onSettingsSearch();
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
  }, [onNavigate, onDesignTab, onEscape, onSettingsSearch, enabled]);
}
