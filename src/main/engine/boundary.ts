/**
 * Write boundaries: the inner, per-agent safety envelope. Droid's own --auto
 * level is the outer one.
 *
 * Enforced in code after every agent phase, not asked of the agent: snapshot
 * git status at phase start, diff it at phase end, classify each change against
 * the agent's boundary, revert what was not allowed, and fail the phase with
 * the violation list as evidence.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoundaryViolation, WriteBoundary } from '@shared/types.js';
import { changedPaths, resolveRef, revertPath } from './git.js';

/** Always protected, whatever an agent's boundary says. */
export const ALWAYS_PROTECTED = ['.foundry/', '.git/', '.foundry-worktrees/'];

/**
 * One dirty path's content at phase start — the shape rewind({filesToRestore})
 * needs. Missing/deleted paths stay in `paths` only (nothing to restore by hash).
 */
export interface SnapshotFile {
  path: string;
  contentHash: string;
  size: number;
}

export interface Snapshot {
  paths: Set<string>;
  /** Worktree HEAD at phase start (`resolveRef(cwd, 'HEAD')`). */
  headSha: string;
  /** Content hashes for changed files that still exist on disk. */
  files: SnapshotFile[];
}

function hashExistingFile(cwd: string, relPath: string): SnapshotFile | null {
  const abs = join(cwd, relPath);
  if (!existsSync(abs)) return null;
  try {
    const buf = readFileSync(abs);
    return {
      path: relPath,
      contentHash: createHash('sha256').update(buf).digest('hex'),
      size: buf.byteLength,
    };
  } catch {
    // Unreadable (permissions, race) — keep the path in the set; skip the hash.
    return null;
  }
}

/**
 * Cheap phase-start capture: porcelain changed paths + HEAD + per-file hashes
 * of only those paths. Never walks the tree.
 */
export async function snapshot(cwd: string): Promise<Snapshot> {
  const changed = await changedPaths(cwd);
  const files: SnapshotFile[] = [];
  for (const path of changed) {
    const file = hashExistingFile(cwd, path);
    if (file) files.push(file);
  }
  return {
    paths: new Set(changed),
    headSha: await resolveRef(cwd, 'HEAD'),
    files,
  };
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
