import { useEffect, useState } from 'react';
import type { ReadinessState } from '@shared/types.js';
import { api } from '../api.js';
import { isReadinessTerminal } from '../view-models/readiness-view.js';

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
    let cancelled = false;

    const read = async (): Promise<ReadinessState | null> => {
      try {
        return await api.readiness.get(projectId);
      } catch {
        return null;
      }
    };

    void read().then((next) => {
      if (!cancelled) setSession(next);
    });

    const id = window.setInterval(() => {
      void read().then((next) => {
        if (cancelled || !next) return;
        setSession((current) => {
          // A settled session stops moving: keep the settled snapshot and let
          // the interval below tear itself down on the next render.
          if (current && isReadinessTerminal(current.phase) && current.phase === next.phase) {
            return current;
          }
          return next;
        });
        if (isReadinessTerminal(next.phase) || next.phase === 'needs_continue') {
          window.clearInterval(id);
        }
      });
    }, pollMs);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [projectId, pollMs, nonce]);

  return {
    session,
    refresh: () => {
      setNonce((n) => n + 1);
      if (!projectId) return;
      void api.readiness
        .get(projectId)
        .then(setSession)
        .catch(() => {});
    },
  };
}
