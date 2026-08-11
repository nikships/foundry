import { useCallback } from 'react';
import { tablistStep, type TablistOrientation } from '../keyboard.js';

/**
 * Arrow-key navigation for a `role="tablist"` container: the arrows along the
 * list's axis wrap, Home/End jump, and selection follows focus (switching
 * panes here is cheap and side-effect free). Pair with roving tabindex on the
 * tabs themselves so Tab enters the strip once instead of stopping on every
 * tab.
 *
 * Pass `'vertical'` for a stacked tablist so it reads Up/Down and leaves
 * Left/Right to the caret in any field beside it.
 */
export function useTablistNav(
  orientation: TablistOrientation = 'horizontal',
): (e: React.KeyboardEvent<HTMLElement>) => void {
  return useCallback(
    (e) => {
      const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
      const next = tablistStep(
        e.key,
        tabs.indexOf(e.target as HTMLElement),
        tabs.length,
        orientation,
      );
      if (next == null) return;
      e.preventDefault();
      tabs[next]?.focus();
      tabs[next]?.click();
    },
    [orientation],
  );
}
