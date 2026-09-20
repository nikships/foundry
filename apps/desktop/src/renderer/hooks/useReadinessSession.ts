import { useEffect, useState } from 'react';
import type { ReadinessState } from '@shared/types.js';
import { api } from '../api.js';
import { isReadinessTerminal } from '../view-models/readiness-view.js';
import { pollWhileVisible } from '../utils/visible-poll.js';

/**
 * The live readiness session for one project, polled while it is moving.
 *
 * There is no `readiness-progress` push channel (it left with the old modal),
 * so the panel reads `readiness:get` on an interval and re-inspects the
 * marker when the session settles, exactly the way the old Runs banner did.
 * Polling stops once the session reaches a terminal phase or parks on
 * `needs_continue`.
 */
export function useReadinessSession(
  projectId: string,
  pollMs = 1500,
): {
  session: ReadinessState | null;
  refresh: () => void;
} {
  const [session, setSession] = useState<ReadinessState | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setSession(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    let settled = false;
    const poll = pollWhileVisible(
      async (signal) => {
        try {
          const next = await api.readiness.get(projectId);
          if (signal.aborted) return;
          settled = !!next && (isReadinessTerminal(next.phase) || next.phase === 'needs_continue');
          setSession((current) => {
            if (
              current &&
              next &&
              isReadinessTerminal(current.phase) &&
              current.phase === next.phase
            ) {
              return current;
            }
            return next;
          });
        } catch {
          // Keep the last snapshot; the next visible poll retries.
        }
      },
      () => (settled ? null : pollMs),
    );
    return poll.stop;
  }, [projectId, pollMs, nonce]);

  return {
    session,
    refresh: () => setNonce((n) => n + 1),
  };
}
