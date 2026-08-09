import { useCallback } from 'react';

export interface ConfirmRequest {
  id: string;
  message: string;
}

type Listener = (req: ConfirmRequest | null) => void;

class ConfirmManager {
  private current: (ConfirmRequest & { resolve: (accepted: boolean) => void }) | null = null;
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.current) listener(this.current);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ask(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const req = {
        id: Math.random().toString(36).slice(2),
        message,
        resolve: (accepted: boolean) => {
          this.current = null;
          this.notify();
          resolve(accepted);
        },
      };
      this.current = req;
      this.notify();
    });
  }

  resolve(id: string, accepted: boolean): void {
    if (this.current && this.current.id === id) {
      this.current.resolve(accepted);
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.current);
    }
  }
}

export const confirmManager = new ConfirmManager();

/**
 * Wraps an async action with an in-app dark modal prompt.
 * If the user cancels, the action is not called and the wrapper returns `false`.
 */
export function useConfirmAction<Args extends unknown[] = []>(
  message: string | ((...args: Args) => string),
  action: (...args: Args) => Promise<void> | void,
): (...args: Args) => Promise<boolean> {
  return useCallback(
    async (...args: Args): Promise<boolean> => {
      const promptText = typeof message === 'function' ? message(...args) : message;
      const accepted = await confirmManager.ask(promptText);
      if (!accepted) {
        return false;
      }
      await action(...args);
      return true;
    },
    [message, action],
  );
}
