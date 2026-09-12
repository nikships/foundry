/**
 * Pull-request conflict repair UI. GitHub recomputes mergeability after a
 * push, so a successful Fix-with-agent can still be listed as conflicting
 * on the next refresh. The card must not re-arm the button until that
 * window ends or GitHub reports a computed non-conflict.
 */

import type { PullRequest } from '@shared/types.js';

/** Hold the button after a successful push while GitHub's mergeability job runs. */
export const MERGEABILITY_RECHECK_MS = 20_000;

export type PrRepairPhase = 'idle' | 'repairing' | 'rechecking';

export const PR_FIX_TITLE =
  "An agent rebases this branch onto the fetched base in the run's worktree; Foundry verifies and pushes the result";

export const PR_RECHECK_TITLE = 'GitHub is recomputing mergeability after the last repair';

export function prRepairPhase(input: {
  busy: boolean;
  mergeable: PullRequest['mergeable'];
  recheckUntil: number | undefined;
  now: number;
}): PrRepairPhase {
  if (input.busy) return 'repairing';
  if (
    input.mergeable === 'conflicting' &&
    input.recheckUntil != null &&
    input.now < input.recheckUntil
  ) {
    return 'rechecking';
  }
  return 'idle';
}

export function beginRecheck(
  current: Record<number, number>,
  prNumber: number,
  now: number,
): Record<number, number> {
  return { ...current, [prNumber]: now + MERGEABILITY_RECHECK_MS };
}

export function expireRecheck(
  current: Record<number, number>,
  prNumber: number,
): Record<number, number> {
  if (current[prNumber] == null) return current;
  const next = { ...current };
  delete next[prNumber];
  return next;
}

/** Drop expired windows and PRs GitHub no longer reports as conflicting. */
export function pruneRechecks(
  current: Record<number, number>,
  prs: readonly Pick<PullRequest, 'number' | 'mergeable'>[],
  now: number,
): Record<number, number> {
  const stillConflicting = new Set(
    prs.filter((pr) => pr.mergeable === 'conflicting').map((pr) => pr.number),
  );
  const next: Record<number, number> = {};
  for (const [key, until] of Object.entries(current)) {
    const number = Number(key);
    if (until <= now) continue;
    if (!stillConflicting.has(number)) continue;
    next[number] = until;
  }
  return next;
}

export function prConflictBadge(
  mergeable: PullRequest['mergeable'],
  phase: PrRepairPhase,
): { label: string; color: string } | null {
  if (phase === 'rechecking') {
    return { label: 'checking mergeability', color: 'var(--amber)' };
  }
  if (mergeable === 'conflicting') {
    return { label: 'conflicts', color: 'var(--red)' };
  }
  return null;
}

export function prFixButton(input: {
  hasFixAction: boolean;
  mergeable: PullRequest['mergeable'];
  phase: PrRepairPhase;
}): { disabled: boolean; label: string; title: string } | null {
  if (!input.hasFixAction) return null;
  if (input.phase === 'repairing') {
    return { disabled: true, label: 'Repairing…', title: PR_FIX_TITLE };
  }
  if (input.phase === 'rechecking') {
    return { disabled: true, label: 'Checking…', title: PR_RECHECK_TITLE };
  }
  if (input.mergeable !== 'conflicting') return null;
  return { disabled: false, label: 'Fix with agent', title: PR_FIX_TITLE };
}

export function prMergeBlocked(input: {
  busy: boolean;
  isDraft: boolean;
  mergeable: PullRequest['mergeable'];
  phase: PrRepairPhase;
}): boolean {
  return (
    input.busy || input.isDraft || input.mergeable === 'conflicting' || input.phase === 'rechecking'
  );
}

export function prMergeHint(input: {
  isDraft: boolean;
  mergeable: PullRequest['mergeable'];
  phase: PrRepairPhase;
  number: number;
  baseRefName: string;
}): string {
  if (input.isDraft) return 'Draft PRs cannot be merged';
  if (input.phase === 'rechecking') return PR_RECHECK_TITLE;
  if (input.mergeable === 'conflicting') return 'This PR has merge conflicts';
  return `Merge #${input.number} into ${input.baseRefName} on GitHub, then sync your local ${input.baseRefName}`;
}
