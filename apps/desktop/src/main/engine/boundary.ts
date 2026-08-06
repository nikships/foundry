/**
 * Write boundaries: the inner, per-agent safety envelope. Droid's own --auto
 * level is the outer one.
 *
 * Enforced in code after every agent phase, not asked of the agent: snapshot
 * git status at phase start, diff it at phase end, classify each change against
 * the agent's boundary, revert what was not allowed, and fail the phase with
 * the violation list as evidence.
 */

import type { BoundaryViolation, WriteBoundary } from '@shared/types.js';
import { changedPaths, revertPath } from './git.js';

/** Always protected, whatever an agent's boundary says. */
export const ALWAYS_PROTECTED = ['.foundry/', '.git/', '.foundry-worktrees/'];

export interface Snapshot {
  paths: Set<string>;
}

export async function snapshot(cwd: string): Promise<Snapshot> {
  return { paths: new Set(await changedPaths(cwd)) };
}

function normalise(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/');
}

/** Glob support is deliberately narrow: `*` within a segment, `**` across. */
export function matchesPattern(path: string, pattern: string): boolean {
  const p = normalise(path);
  const pat = normalise(pattern);
  if (pat.endsWith('/')) return p === pat.slice(0, -1) || p.startsWith(pat);
  if (!pat.includes('*')) return p === pat || p.startsWith(`${pat}/`);

  const escaped = pat
    .split('**')
    .map((seg) =>
      seg
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]'),
    )
    .join('.*');
  return new RegExp(`^${escaped}$`).test(p);
}

export function isProtected(path: string, projectProtected: string[] = []): boolean {
  return [...ALWAYS_PROTECTED, ...projectProtected].some((pat) => matchesPattern(path, pat));
}

/** `null` = unrestricted (minus protected); `[]` = read-only; list = allowlist. */
export function isAllowed(
  path: string,
  writes: WriteBoundary,
  projectProtected: string[] = [],
): boolean {
  if (isProtected(path, projectProtected)) return false;
  if (writes === null) return true;
  if (writes.length === 0) return false;
  return writes.some((pat) => matchesPattern(path, pat));
}

export interface BoundaryResult {
  violations: BoundaryViolation[];
  allowedChanges: string[];
}

export async function enforce(input: {
  cwd: string;
  before: Snapshot;
  writes: WriteBoundary;
  projectProtected?: string[];
}): Promise<BoundaryResult> {
  const after = await changedPaths(input.cwd);
  const newChanges = after.filter((p) => !input.before.paths.has(p));
  const violations: BoundaryViolation[] = [];
  const allowedChanges: string[] = [];

  for (const path of newChanges) {
    if (isAllowed(path, input.writes, input.projectProtected)) {
      allowedChanges.push(path);
      continue;
    }
    const reverted = await revertPath(input.cwd, path);
    violations.push({
      path,
      change: input.writes === null ? 'protected path' : 'outside write boundary',
      reverted,
    });
  }

  return { violations, allowedChanges };
}

export function describeBoundary(writes: WriteBoundary): string {
  if (writes === null) return 'unrestricted (minus protected paths)';
  if (writes.length === 0) return 'read-only';
  return writes.join(', ');
}

export function boundaryCorrection(violations: BoundaryViolation[]): string {
  return [
    'Your last phase wrote outside its write boundary. Those changes were reverted:',
    '',
    ...violations.map(
      (v) => `- ${v.path} (${v.change}${v.reverted ? ', reverted' : ', revert failed'})`,
    ),
    '',
    'Redo the work touching only the paths you are allowed to write, then reply with the envelope JSON only.',
  ].join('\n');
}
