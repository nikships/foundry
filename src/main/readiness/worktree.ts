/**
 * Isolated worktree for "Make it ready". Reuses git plumbing, not the run
 * engine: branches are `foundry-ready/<id>` so a readiness tree can never be
 * mistaken for `foundry/<runId>`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  addAll,
  addWorktree,
  commit,
  deleteBranch,
  excludeLocally,
  headSha,
  pruneWorktrees,
  removeWorktree,
} from '../engine/git.js';
import { WORKTREE_DIR } from '../engine/worktree.js';

export interface ReadinessWorktree {
  path: string;
  branch: string;
  baseRef: string;
}

export function readinessWorktreePath(repo: string, sessionId: string): string {
  return join(repo, WORKTREE_DIR, `ready-${sessionId}`);
}

export function readinessBranchName(sessionId: string): string {
  return `foundry-ready/${sessionId}`;
}

export function isReadinessWorktreePath(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  return base.startsWith('ready-');
}

export async function createReadinessWorktree(input: {
  repo: string;
  sessionId: string;
  baseRef: string;
}): Promise<ReadinessWorktree> {
  const path = readinessWorktreePath(input.repo, input.sessionId);
  const branch = readinessBranchName(input.sessionId);
  await excludeLocally(input.repo, WORKTREE_DIR);
  const result = await addWorktree(input.repo, path, branch, input.baseRef);
  if (!result.ok) {
    throw new Error(`could not create readiness worktree at ${path}: ${result.stdout.trim()}`);
  }
  return { path, branch, baseRef: input.baseRef };
}

export async function commitReadinessWork(cwd: string, message: string): Promise<void> {
  await addAll(cwd);
  const result = await commit(cwd, message);
  if (!result.ok) {
    throw new Error(result.stdout.trim() || 'readiness commit failed');
  }
}

export async function discardReadinessWorktree(
  repo: string,
  handle: ReadinessWorktree,
): Promise<void> {
  if (existsSync(handle.path)) await removeWorktree(repo, handle.path);
  await pruneWorktrees(repo);
  await deleteBranch(repo, handle.branch);
}

export async function readinessHeadSha(cwd: string): Promise<string> {
  return headSha(cwd);
}
