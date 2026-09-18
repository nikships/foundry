/**
 * When a proof command fails, the log often names the test, snapshot, or
 * fixture the owner was not allowed to write. `feedbackTo` would otherwise
 * re-enter the same tight allowlist. This module extracts those paths so the
 * engine can widen the owner for that re-entry, or skip the loop when the
 * owner cannot write them (read-only).
 */
import type { WriteBoundary } from '@shared/types.js';
import { isAllowed, isProtected } from './boundary.js';

const ANSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
const RELATIVE_PATH =
  /(?<![A-Za-z0-9_./])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})(?::\d+(?::\d+)?)?/g;

export type FeedbackWidenPlan =
  { action: 'feedback'; extra: string[] } | { action: 'skip'; reason: string };

function addPath(found: Set<string>, raw: string): void {
  let path = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  path = path.replace(/:\d+(?::\d+)?$/, '');
  if (!path || path.startsWith('/') || path.includes('node_modules/') || path.includes('://')) {
    return;
  }
  found.add(path);
}

/** Repo-relative file paths a proof log named, including tests and snapshots. */
export function repoPathsNamedInLog(log: string, cwd?: string): string[] {
  const cleaned = log.replace(ANSI, '');
  const found = new Set<string>();
  const cwdNorm = cwd?.replace(/\\/g, '/').replace(/\/$/, '');
  if (cwdNorm) {
    const escaped = cwdNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const abs = new RegExp(`${escaped}/([^\\s:'")\\]]+\\.[A-Za-z0-9]{1,8})`, 'g');
    for (const match of cleaned.matchAll(abs)) addPath(found, match[1]!);
  }
  for (const match of cleaned.matchAll(RELATIVE_PATH)) addPath(found, match[1]!);
  return [...found];
}

export function outOfBoundProofPaths(
  log: string,
  writes: WriteBoundary,
  protectedPaths: string[] = [],
  cwd?: string,
): string[] {
  return repoPathsNamedInLog(log, cwd).filter(
    (path) => !isProtected(path, protectedPaths) && !isAllowed(path, writes, protectedPaths),
  );
}

export function widenWriteBoundary(writes: WriteBoundary, extra: string[]): WriteBoundary {
  if (writes === null || extra.length === 0) return writes;
  if (writes.length === 0) return writes;
  const next = [...writes];
  for (const path of extra) {
    if (!isAllowed(path, next)) next.push(path);
  }
  return next;
}

/**
 * Whether `feedbackTo` should re-enter (optionally widened) or abort so
 * healing/replan can take over instead of looping a read-only owner.
 */
export function feedbackWidenPlan(input: {
  writes: WriteBoundary;
  log: string;
  protectedPaths?: string[];
  cwd?: string;
}): FeedbackWidenPlan {
  const extra = outOfBoundProofPaths(input.log, input.writes, input.protectedPaths, input.cwd);
  if (extra.length === 0) return { action: 'feedback', extra: [] };
  if (Array.isArray(input.writes) && input.writes.length === 0) {
    return {
      action: 'skip',
      reason: 'owner is read-only and cannot write paths named by the proof log',
    };
  }
  return { action: 'feedback', extra };
}
