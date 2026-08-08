/**
 * Git as a typed surface. Everything here shells out and parses; nothing in the
 * renderer ever reaches git directly.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
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

/**
 * A porcelain v1 row is two status columns and a space. Anything else git
 * prints is chatter, not a path: runCommand merges stderr into the capture,
 * so an fsmonitor warning like `error: could not read IPC response` would
 * otherwise parse as a changed file named `or: could not read IPC response`
 * and fail gates on a path that does not exist.
 */
const STATUS_LINE = /^[ MADRCU?!]{2} /;

export function parseStatus(text: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  for (const line of text.split('\n')) {
    if (!STATUS_LINE.test(line)) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (!path) continue;
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4);
    out.push({ path: stripQuotes(path), code });
  }
  return out;
}

/** `git status --porcelain`, parsed. Renames report the destination path. */
export async function status(cwd: string): Promise<StatusEntry[]> {
  const r = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (!r.ok) return [];
  return parseStatus(r.stdout);
}

export async function changedPaths(cwd: string): Promise<string[]> {
  return (await status(cwd)).map((s) => s.path);
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

/**
 * Ignores a repo-relative directory locally, unless something already does.
 *
 * A nested worktree is not ignored by git for free: `.foundry-worktrees/`
 * reports as untracked in the base checkout, so Foundry's own isolation
 * scaffolding reads as the operator's unfinished work. `info/exclude` is the
 * right home for the rule — local to the clone, never committed, and it leaves
 * the project's `.gitignore` alone.
 *
 * The check-ignore probe is a path *inside* the directory: a directory-only
 * pattern (`foo/`) matches `foo/anything` whether or not `foo` exists yet,
 * while the bare name is ambiguous to git before the directory is created.
 */
export async function excludeLocally(repo: string, dir: string): Promise<boolean> {
  const pattern = `/${dir}/`;
  if ((await git(repo, ['check-ignore', '--quiet', `${dir}/probe`])).ok) return true;

  const common = (await git(repo, ['rev-parse', '--git-common-dir'])).stdout.trim();
  if (!common) return false;
  const gitDir = isAbsolute(common) ? common : join(repo, common);
  const file = join(gitDir, 'info', 'exclude');

  try {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (existing.split('\n').some((line) => line.trim() === pattern)) return true;
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}${pattern}\n`);
    return true;
  } catch {
    return false;
  }
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
 *
 * Uncommitted work in the base checkout is *not* a reason to refuse. Git
 * already declines a checkout or merge that would overwrite local changes, and
 * says which files, so a blanket dirty-tree veto only ever blocked merges that
 * would have been fine. Failure restores where the operator was standing:
 * a conflicted merge is aborted and the original branch checked back out, so a
 * rejected merge leaves the base exactly as it found it.
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

  const startedOn = await currentBranch(repo);
  const onBase = await git(repo, ['checkout', baseRef], 120_000);
  if (!onBase.ok) {
    return {
      ok: false,
      baseMoved: false,
      detail: onBase.stdout.trim() || `could not check out ${baseRef}`,
    };
  }

  const merged = await git(
    repo,
    ['merge', '--no-ff', branch, '-m', `foundry: merge ${branch}`],
    120_000,
  );
  if (merged.ok) return { ok: true, baseMoved: false, detail: merged.stdout };

  await git(repo, ['merge', '--abort']);
  if (startedOn && startedOn !== 'HEAD' && startedOn !== baseRef) {
    await git(repo, ['checkout', startedOn], 120_000);
  }
  return { ok: false, baseMoved: false, detail: merged.stdout.trim() || 'merge failed' };
}
