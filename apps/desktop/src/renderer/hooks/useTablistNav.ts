import { useCallback } from 'react';
import { tablistStep } from '../utils/keyboard.js';

/**
 * Arrow-key navigation for a `role="tablist"` container: wrap-around navigation,
 * Home/End jump, and selection follows focus (switching panes here is cheap
 * and side-effect free). Pair with roving tabindex on the tabs themselves so
 * Tab enters the strip once instead of stopping on every tab.
 */
export function useTablistNav(
  opts: { orientation?: 'horizontal' | 'vertical' } = {},
): (e: React.KeyboardEvent<HTMLElement>) => void {
  const { orientation = 'horizontal' } = opts;
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
