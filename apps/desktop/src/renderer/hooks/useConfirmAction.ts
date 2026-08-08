import { useCallback } from 'react';

/**
 * Wraps an async action with a `window.confirm` modal prompt.
 * If the user cancels, the action is not called and the wrapper returns `false`.
 */
export function useConfirmAction<Args extends unknown[] = []>(
  message: string | ((...args: Args) => string),
  action: (...args: Args) => Promise<void> | void,
): (...args: Args) => Promise<boolean> {
  return useCallback(
    async (...args: Args): Promise<boolean> => {
      const promptText = typeof message === 'function' ? message(...args) : message;
      if (!window.confirm(promptText)) {
        return false;
      }
      await action(...args);
      return true;
    },
    [message, action],
  );
}
