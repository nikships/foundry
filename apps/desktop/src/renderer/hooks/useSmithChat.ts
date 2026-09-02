import { useCallback, useEffect, useState } from 'react';
import type { SmithChatState, SmithScreenContext } from '@shared/ipc-contract.js';
import type { ReasoningEffort } from '@shared/types.js';
import { api } from '../api.js';

/**
 * The Smith chat surface's connection to main: one snapshot on open, then
 * cloned states over `smith-progress`. Every action re-reads through its own
 * invoke result so the surface never waits on the next push to catch up.
 */
export function useSmithChat(projectId: string | undefined): {
  state: SmithChatState | null;
  send: (text: string, screen: SmithScreenContext) => Promise<void>;
  cancel: () => Promise<void>;
  newChat: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setReasoningEffort: (effort: ReasoningEffort) => Promise<void>;
} {
  const [state, setState] = useState<SmithChatState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState(null);
    void api.smith.state(projectId).then((next) => {
      // A push may land before this snapshot resolves; the push is fresher,
      // so the snapshot only fills an otherwise-empty surface.
      if (!cancelled && next) setState((prev) => prev ?? next);
    });
    const off = api.on('smith-progress', (data) => {
      const next = data as SmithChatState;
      if (next?.projectId === projectId) setState(next);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [projectId]);

  const apply = useCallback(async (work: () => Promise<SmithChatState | null>): Promise<void> => {
    const next = await work();
    if (next) setState(next);
  }, []);

  const send = useCallback(
    async (text: string, screen: SmithScreenContext): Promise<void> => {
      if (!text.trim()) return;
      await apply(() => api.smith.send(projectId, text, screen));
    },
    [apply, projectId],
  );

  const cancel = useCallback(
    (): Promise<void> => apply(() => api.smith.cancel(projectId)),
    [apply, projectId],
  );

  const newChat = useCallback(
    (): Promise<void> => apply(() => api.smith.newChat(projectId)),
    [apply, projectId],
  );

  const setModel = useCallback(
    async (model: string): Promise<void> => {
      if (!model.trim()) return;
      await apply(() => api.smith.setModel(projectId, model));
    },
    [apply, projectId],
  );

  const setReasoningEffort = useCallback(
    (effort: ReasoningEffort): Promise<void> =>
      apply(() => api.smith.setReasoningEffort(projectId, effort)),
    [apply, projectId],
  );

  return { state, send, cancel, newChat, setModel, setReasoningEffort };
}
