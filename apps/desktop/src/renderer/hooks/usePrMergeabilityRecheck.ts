import { useCallback, useEffect, useRef, useState } from 'react';
import type { PullRequest } from '@shared/types.js';
import {
  MERGEABILITY_RECHECK_MS,
  beginRecheck,
  expireRecheck,
  pruneRechecks,
} from '../view-models/pr-repair-view.js';

type RecheckTimers = Map<number, ReturnType<typeof setTimeout>>;

function clearTimer(timers: RecheckTimers, prNumber: number): void {
  const handle = timers.get(prNumber);
  if (handle === undefined) return;
  clearTimeout(handle);
  timers.delete(prNumber);
}

function clearAllTimers(timers: RecheckTimers): void {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
}

/**
 * After a successful conflict repair, GitHub can keep reporting the PR as
 * conflicting until its mergeability job finishes. Hold that card locally
 * for a bounded window (and drop the hold once a refresh sees a computed
 * non-conflict) so Fix-with-agent cannot fire a second rebase.
 */
export function usePrMergeabilityRecheck(): {
  untilFor: (prNumber: number) => number | undefined;
  holdAfterSuccessfulFix: (prNumber: number) => void;
  pruneAgainst: (prs: readonly Pick<PullRequest, 'number' | 'mergeable'>[]) => void;
  reset: () => void;
} {
  const [recheckUntil, setRecheckUntil] = useState<Record<number, number>>({});
  const untilRef = useRef(recheckUntil);
  untilRef.current = recheckUntil;
  const timers = useRef<RecheckTimers>(new Map());

  const reset = useCallback((): void => {
    clearAllTimers(timers.current);
    untilRef.current = {};
    setRecheckUntil({});
  }, []);

  useEffect(
    () => () => {
      clearAllTimers(timers.current);
    },
    [],
  );

  const holdAfterSuccessfulFix = useCallback((prNumber: number): void => {
    const next = beginRecheck(untilRef.current, prNumber, Date.now());
    untilRef.current = next;
    setRecheckUntil(next);
    clearTimer(timers.current, prNumber);
    const handle = setTimeout(() => {
      timers.current.delete(prNumber);
      const expired = expireRecheck(untilRef.current, prNumber);
      untilRef.current = expired;
      setRecheckUntil(expired);
    }, MERGEABILITY_RECHECK_MS);
    timers.current.set(prNumber, handle);
  }, []);

  const pruneAgainst = useCallback(
    (prs: readonly Pick<PullRequest, 'number' | 'mergeable'>[]): void => {
      const previous = untilRef.current;
      const next = pruneRechecks(previous, prs, Date.now());
      for (const key of Object.keys(previous)) {
        if (next[Number(key)] == null) clearTimer(timers.current, Number(key));
      }
      untilRef.current = next;
      setRecheckUntil(next);
    },
    [],
  );

  const untilFor = useCallback(
    (prNumber: number): number | undefined => recheckUntil[prNumber],
    [recheckUntil],
  );

  return { untilFor, holdAfterSuccessfulFix, pruneAgainst, reset };
}
