/**
 * Git as a typed surface. Everything here shells out and parses; nothing in the
 * renderer ever reaches git directly.
 */

import { runCommand } from './commands.js';

export interface GitResult {
  ok: boolean;
  stdout: string;
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  const r = await runCommand({ argv: ['git', ...args], cwd, timeoutMs });
  return { ok: r.passed, stdout: r.outputTail };
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--git-dir'])).ok;
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.stdout.trim() : null;
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', ref])).ok;
}

export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.stdout.trim();
}

export async function headSha(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
}

export interface StatusEntry {
  path: string;
  code: string;
}

function stripQuotes(p: string): string {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

/** `git status --porcelain`, parsed. Renames report the destination path. */
export async function status(cwd: string): Promise<StatusEntry[]> {
  const r = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (!r.ok) return [];

  const out: StatusEntry[] = [];
  for (const line of r.stdout.split('\n')) {
    if (line.trim().length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    out.push({ path: stripQuotes(path), code });
  }
  return out;
}

export async function changedPaths(cwd: string): Promise<string[]> {
  return (await status(cwd)).map((s) => s.path);
}

export async function hasStagedOrUnstaged(cwd: string): Promise<boolean> {
  return (await status(cwd)).length > 0;
}

export async function addAll(cwd: string): Promise<GitResult> {
  return git(cwd, ['add', '-A']);
}

export async function commit(cwd: string, message: string): Promise<GitResult> {
  return git(cwd, ['commit', '-m', message]);
}

export async function diffStat(cwd: string, base: string): Promise<string> {
  return (await git(cwd, ['diff', '--stat', `${base}...HEAD`])).stdout;
}

/** Reverts a path whether it is tracked-and-modified or untracked. */
export async function revertPath(cwd: string, path: string): Promise<boolean> {
  const tracked = await git(cwd, ['ls-files', '--error-unmatch', path]);
  if (tracked.ok) return (await git(cwd, ['checkout', '--', path])).ok;
  return (await git(cwd, ['clean', '-fd', '--', path])).ok;
}

export async function addWorktree(
  repo: string,
  path: string,
  branch: string,
  baseRef: string,
): Promise<GitResult> {
  return git(repo, ['worktree', 'add', '-b', branch, path, baseRef], 120_000);
}

export async function removeWorktree(repo: string, path: string, force = true): Promise<GitResult> {
  return git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path], 120_000);
}

export async function pruneWorktrees(repo: string): Promise<GitResult> {
  return git(repo, ['worktree', 'prune']);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

export async function listWorktrees(repo: string): Promise<WorktreeInfo[]> {
  const r = await git(repo, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];

  const out: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};

  const flush = (): void => {
    if (!cur.path) return;
    out.push({ path: cur.path, branch: cur.branch ?? '', head: cur.head ?? '' });
  };

  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice(9).trim() };
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).trim().replace('refs/heads/', '');
    }
  }
  flush();
  return out;
}

export async function deleteBranch(repo: string, branch: string): Promise<GitResult> {
  return git(repo, ['branch', '-D', branch]);
}

export interface MergeOutcome {
  ok: boolean;
  detail: string;
  /** True when the base ref moved since the run branched, so merge is not safe. */
  baseMoved: boolean;
}

/**
 * Merge is never automatic when the base moved: the run was verified against
 * the ref it branched from, not against wherever the base is now.
 */
export async function mergeBranch(
  repo: string,
  branch: string,
  baseRef: string,
  branchPointSha: string,
): Promise<MergeOutcome> {
  const baseNow = (await git(repo, ['rev-parse', baseRef])).stdout.trim();
  if (baseNow && branchPointSha && baseNow !== branchPointSha) {
    return {
      ok: false,
      baseMoved: true,
      detail: `${baseRef} moved from ${branchPointSha.slice(0, 8)} to ${baseNow.slice(0, 8)} since this run branched — rebase before merging`,
    };
  }

  if (await hasStagedOrUnstaged(repo)) {
    return { ok: false, baseMoved: false, detail: 'the base worktree has uncommitted changes' };
  }

  const onBase = await git(repo, ['checkout', baseRef], 120_000);
  if (!onBase.ok) return { ok: false, baseMoved: false, detail: onBase.stdout };

  const merged = await git(
    repo,
    ['merge', '--no-ff', branch, '-m', `foundry: merge ${branch}`],
    120_000,
  );
  return { ok: merged.ok, baseMoved: false, detail: merged.stdout };
}
