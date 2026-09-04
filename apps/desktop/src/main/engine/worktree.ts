/**
 * Per-run git worktree: the isolation SSSF documents as "the obvious next
 * thing". A run works on its own branch in its own directory, so a failed run
 * leaves the repo exactly as it was and its work still reviewable.
 *
 * Kill or crash deliberately leaves the worktree in place; the orphan sweep
 * lists abandoned ones for Settings → Maintenance rather than deleting work
 * nobody has looked at yet.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MergePolicy, OrphanWorktree } from '@shared/types.js';
import {
  addWorktree,
  deleteBranch,
  excludeLocally,
  headSha,
  initSubmodules,
  listWorktrees,
  mergeBranch,
  pruneWorktrees,
  removeWorktree,
} from './git.js';

export const WORKTREE_DIR = '.foundry-worktrees';

/** The rule `create` registers in `.git/info/exclude` before adding a worktree. */
export const WORKTREE_EXCLUDE = `/${WORKTREE_DIR}/`;

export interface WorktreeHandle {
  path: string;
  branch: string;
  baseRef: string;
  branchPointSha: string;
}

export function worktreePathFor(repo: string, runId: string): string {
  return join(repo, WORKTREE_DIR, runId);
}

export function branchNameFor(runId: string): string {
  return `foundry/${runId}`;
}

export async function create(input: {
  repo: string;
  runId: string;
  baseRef: string;
}): Promise<WorktreeHandle> {
  const path = worktreePathFor(input.repo, input.runId);
  const branch = branchNameFor(input.runId);
  // Before the directory exists, so it never appears as untracked at all.
  await excludeLocally(input.repo, WORKTREE_DIR);
  const branchPointSha = await headSha(input.repo);
  const result = await addWorktree(input.repo, path, branch, input.baseRef);
  if (!result.ok) {
    throw new Error(`could not create worktree at ${path}: ${result.stdout.trim()}`);
  }
  if (existsSync(join(path, '.gitmodules'))) {
    const sub = await initSubmodules(path);
    if (!sub.ok) {
      throw new Error(`could not initialize submodules at ${path}: ${sub.stdout.trim()}`);
    }
  }
  return { path, branch, baseRef: input.baseRef, branchPointSha };
}

export interface SettleOutcome {
  merged: boolean;
  removed: boolean;
  detail: string;
}

/**
 * Accepted runs offer their branch back to the base; anything else keeps the
 * worktree so the work can be opened or discarded deliberately.
 */
export async function settle(input: {
  repo: string;
  handle: WorktreeHandle;
  accepted: boolean;
  policy: MergePolicy;
}): Promise<SettleOutcome> {
  if (!input.accepted) {
    return { merged: false, removed: false, detail: 'run not accepted: worktree kept for review' };
  }
  if (input.policy === 'never') {
    return { merged: false, removed: false, detail: 'merge policy is never: worktree kept' };
  }
  if (input.policy === 'ask') {
    return { merged: false, removed: false, detail: 'awaiting merge decision' };
  }
  return merge(input.repo, input.handle);
}

export async function merge(repo: string, handle: WorktreeHandle): Promise<SettleOutcome> {
  const result = await mergeBranch(repo, handle.branch, handle.baseRef, handle.branchPointSha);
  if (!result.ok) {
    return { merged: false, removed: false, detail: result.detail.trim() || 'merge failed' };
  }
  const removed = await discard(repo, handle);
  return {
    merged: true,
    removed: removed.removed,
    detail: `merged ${handle.branch} into ${handle.baseRef}`,
  };
}

export async function discard(repo: string, handle: WorktreeHandle): Promise<SettleOutcome> {
  if (existsSync(handle.path)) await removeWorktree(repo, handle.path);
  await pruneWorktrees(repo);
  await deleteBranch(repo, handle.branch);
  return { merged: false, removed: !existsSync(handle.path), detail: `removed ${handle.path}` };
}

/**
 * Worktrees whose run is no longer live. Known run ids are passed in rather
 * than inferred, so a worktree from a run still in progress is never listed.
 */
export async function findOrphans(input: {
  repo: string;
  projectId: string;
  activeRunIds: string[];
}): Promise<OrphanWorktree[]> {
  const all = await listWorktrees(input.repo);
  const active = new Set(input.activeRunIds);
  return all
    .filter((w) => w.path.includes(WORKTREE_DIR))
    .map((w) => {
      const runId = w.path.split('/').pop() || null;
      return { path: w.path, branch: w.branch, runId, projectId: input.projectId };
    })
    .filter((w) => {
      if (w.runId?.startsWith('ready-')) return false;
      return !w.runId || !active.has(w.runId);
    });
}
