/**
 * Git as a typed surface. Everything here shells out and parses; nothing in the
 * renderer ever reaches git directly.
 */

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { spawnEnv } from '../system/env.js';
import { runCommand } from './commands.js';

const exec = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  const r = await runCommand({ argv: ['git', ...args], cwd });
  return { ok: r.passed, stdout: r.outputTail };
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--git-dir'])).ok;
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', ref])).ok;
}

export async function currentBranch(cwd: string): Promise<string> {
  const branch = await git(cwd, ['branch', '--show-current']);
  if (branch.ok && branch.stdout.trim()) {
    return branch.stdout.trim();
  }
  const sym = await git(cwd, ['symbolic-ref', '--short', 'HEAD']);
  if (sym.ok && sym.stdout.trim()) {
    return sym.stdout.trim();
  }
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

export async function headSha(cwd: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', 'HEAD']);
  return r.ok ? r.stdout.trim() : '';
}

export async function resolveRef(cwd: string, ref: string): Promise<string> {
  const r = await git(cwd, ['rev-parse', '--verify', ref]);
  return r.ok ? r.stdout.trim() : '';
}

export async function isAncestor(
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])).ok;
}

/** Safe on a quiet tree: aborting when no rebase is in progress just fails. */
export async function abortRebase(cwd: string): Promise<void> {
  await git(cwd, ['rebase', '--abort']);
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

/** One porcelain record, with the rename/copy source when git reports one. */
export interface PorcelainEntry extends StatusEntry {
  /** Where an `R`/`C` record's destination came from. */
  origPath?: string;
}

export interface PorcelainStatus {
  entries: PorcelainEntry[];
  /**
   * True when the listing is not known to be complete — the buffer was
   * exceeded, or git refused. A caller that records "this was the whole dirty
   * set" must degrade rather than believe a short list.
   */
  truncated: boolean;
}

/**
 * The complete porcelain status, uncapped and rename-aware.
 *
 * Deliberately not `runCommand`: that keeps only the last 4 KB of output, so a
 * worktree with more than roughly 110 changed paths silently loses an
 * arbitrary *prefix* of them. A checkpoint built from that list would record a
 * subset while claiming to be the whole dirty set.
 *
 * `-z` also removes two ambiguities `--porcelain` v1 leaves behind: paths are
 * NUL-terminated so a filename containing a newline or ` -> ` cannot be
 * misparsed, and a rename arrives as two fields (destination, then source)
 * rather than one `old -> new` string whose source is unrecoverable.
 */
export async function statusPorcelain(
  cwd: string,
  maxBuffer = 16 * 1024 * 1024,
): Promise<PorcelainStatus> {
  try {
    const { stdout } = await exec('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
      cwd,
      encoding: 'utf8',
      env: spawnEnv(),
      maxBuffer,
    });
    return { entries: parsePorcelainZ(stdout), truncated: false };
  } catch {
    // Either the output outgrew maxBuffer or git refused (not a repository).
    // Both mean the dirty set could not be enumerated, and an empty list that
    // reads as "nothing was dirty" is the one answer that must not be given.
    return { entries: [], truncated: true };
  }
}

/**
 * `git status --porcelain -z` records: `XY<space><path>`, NUL-terminated, with
 * an `R`/`C` record's source path following in its own field.
 */
export function parsePorcelainZ(text: string): PorcelainEntry[] {
  const fields = text.split('\0');
  const out: PorcelainEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? '';
    // `XY p` is the shortest possible record.
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    if (!/^[ MADRCU?!]{2}$/.test(code)) continue;
    const path = field.slice(3);
    if (!path) continue;
    if (code.includes('R') || code.includes('C')) {
      const source = fields[++i];
      out.push(source ? { path, code, origPath: source } : { path, code });
      continue;
    }
    out.push({ path, code });
  }
  return out;
}

/** True when `ref` carries `path` as a blob. */
export async function pathExistsAtRef(cwd: string, ref: string, path: string): Promise<boolean> {
  return (await git(cwd, ['cat-file', '-e', `${ref}:${path}`])).ok;
}

export async function checkoutPath(cwd: string, ref: string, path: string): Promise<GitResult> {
  return git(cwd, ['checkout', ref, '--', path]);
}

export async function addAll(cwd: string): Promise<GitResult> {
  return git(cwd, ['add', '-A']);
}

/** Stages a path git would otherwise skip because an ignore rule covers it. */
export async function addPathForce(cwd: string, path: string): Promise<GitResult> {
  return git(cwd, ['add', '-f', '--', path]);
}

/**
 * A file's full contents at `ref`, or null when the ref does not carry it.
 *
 * Deliberately not `runCommand`: that keeps only the last 4 KB of output, which
 * would hand back a truncated file that no longer parses as JSON.
 */
export async function showFileAtRef(
  cwd: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['show', `${ref}:${path}`], {
      cwd,
      encoding: 'utf8',
      env: spawnEnv(),
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function commit(cwd: string, message: string): Promise<GitResult> {
  return git(cwd, ['commit', '-m', message]);
}

/**
 * Moves the checked-out branch and the tracked tree back to `sha`.
 *
 * Destructive by design and only ever called against a run's own worktree: the
 * commits it moves off stay reachable through the branch's reflog, which is
 * what makes a restore recoverable rather than a deletion.
 */
export async function resetHardTo(cwd: string, sha: string): Promise<GitResult> {
  return git(cwd, ['reset', '--hard', sha]);
}

/** How many commits `tip` carries that `base` does not. Null when either ref fails. */
export async function commitCount(cwd: string, base: string, tip: string): Promise<number | null> {
  const r = await git(cwd, ['rev-list', '--count', `${base}..${tip}`]);
  if (!r.ok) return null;
  const count = Number(r.stdout.trim());
  return Number.isFinite(count) ? count : null;
}

/**
 * Abbreviated shas `tip` carries that `base` does not, newest first.
 *
 * Capped rather than complete: this exists so an operator can find work a
 * reset moved off, and `runCommand` keeps only the tail of its output, so an
 * uncapped list would silently start mid-sha.
 */
export async function commitsAhead(
  cwd: string,
  base: string,
  tip: string,
  max = 20,
): Promise<string[]> {
  const r = await git(cwd, [
    'rev-list',
    `--max-count=${max}`,
    '--abbrev-commit',
    `${base}..${tip}`,
  ]);
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{4,40}$/.test(line));
}

export async function diffStat(cwd: string, base: string): Promise<string> {
  if (!base) return (await git(cwd, ['diff', '--stat', 'HEAD'])).stdout;
  return (await git(cwd, ['diff', '--stat', base])).stdout;
}

/**
 * `git diff <base>` as a unified patch, optionally narrowed to one pathspec.
 *
 * Deliberately not `runCommand`: that keeps only the last 4 KB of output, which
 * would hand back a patch beginning mid-hunk. Bounding is the caller's job and
 * happens by whole file sections, so what reaches a reader always parses.
 *
 * `path` goes after `--`, so a value that looks like an option is a pathspec to
 * git rather than a flag. Callers still validate it: a pathspec cannot escape
 * the repository, but this function is not where that is decided.
 */
export async function diffPatch(cwd: string, base: string, path?: string): Promise<string> {
  const args = ['diff', '--no-color', '-M', base || 'HEAD', ...(path ? ['--', path] : [])];
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      encoding: 'utf8',
      env: spawnEnv(),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

export interface BoundedPatch {
  /** Unified diff, whole file sections only, within the caller's cap. */
  text: string;
  /** Files whose section did not fit, in diff order. */
  omitted: string[];
}

/**
 * Keeps whole file sections from the front of a patch until `maxChars` is
 * reached, and names what it dropped.
 *
 * It stops at the first section that does not fit rather than continuing to
 * collect smaller ones behind it: a patch that skips a file in the middle and
 * silently resumes later reads as complete, and the omitted list would no
 * longer match the order of what the reader is looking at.
 */
export function boundPatch(patch: string, maxChars: number): BoundedPatch {
  const trimmed = patch.trimEnd();
  if (!trimmed) return { text: '', omitted: [] };
  if (trimmed.length <= maxChars) return { text: trimmed, omitted: [] };

  const sections = splitPatchSections(trimmed);
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;

  for (const section of sections) {
    const cost = section.body.length + 1;
    if (!omitted.length && used + cost <= maxChars) {
      kept.push(section.body);
      used += cost;
      continue;
    }
    omitted.push(section.path);
  }

  // A single file bigger than the whole cap would otherwise return no patch at
  // all. A cut section still shows what kind of change it is, and its path is
  // reported as omitted either way, so the reader is told to go look at it.
  if (!kept.length && sections[0]) kept.push(sliceAtLineBoundary(sections[0].body, maxChars));

  return { text: kept.join('\n'), omitted };
}

function splitPatchSections(patch: string): { path: string; body: string }[] {
  const out: { path: string; body: string }[] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (!current.length) return;
    out.push({ path: patchSectionPath(current[0]!), body: current.join('\n') });
    current = [];
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) flush();
    current.push(line);
  }
  flush();
  return out;
}

function patchSectionPath(header: string): string {
  const match = /^diff --git .* b\/(.+)$/.exec(header);
  return stripQuotes(match?.[1]?.trim() ?? '') || '(unknown file)';
}

function sliceAtLineBoundary(text: string, maxChars: number): string {
  const cut = text.slice(0, maxChars);
  const lastBreak = cut.lastIndexOf('\n');
  return lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
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
  baseRef?: string,
): Promise<GitResult> {
  if (baseRef && (await refExists(repo, baseRef))) {
    return git(repo, ['worktree', 'add', '-b', branch, path, baseRef]);
  }
  return git(repo, ['worktree', 'add', '-b', branch, path]);
}

export async function removeWorktree(repo: string, path: string, force = true): Promise<GitResult> {
  return git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path]);
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

/**
 * The remote a PR flow talks to: `origin` when present, otherwise the first
 * one listed. Null means the repo has nowhere to push, which callers report
 * rather than guess around.
 */
export async function preferredRemote(repo: string): Promise<string | null> {
  const r = await git(repo, ['remote']);
  if (!r.ok) return null;
  const names = r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (names.length === 0) return null;
  return names.includes('origin') ? 'origin' : names[0]!;
}

export async function pushBranch(repo: string, remote: string, branch: string): Promise<GitResult> {
  return git(repo, ['push', '-u', remote, branch]);
}

export async function deleteRemoteBranch(
  repo: string,
  remote: string,
  branch: string,
): Promise<GitResult> {
  return git(repo, ['push', remote, '--delete', branch]);
}

/**
 * Update the remote after a repair rewrote the branch. `--force-with-lease`
 * rather than `--force`: the push is refused if someone else moved the remote
 * branch since it was last fetched, so a repair can never overwrite work
 * Foundry has not seen.
 */
export async function pushBranchForceWithLease(
  repo: string,
  remote: string,
  branch: string,
): Promise<GitResult> {
  return git(repo, ['push', '--force-with-lease', remote, branch]);
}

/** Fetch one ref; the answer lands in FETCH_HEAD for the caller to resolve. */
export async function fetchRef(repo: string, remote: string, ref: string): Promise<GitResult> {
  return git(repo, ['fetch', remote, ref]);
}

/**
 * Updates `refs/remotes/<remote>/<branch>` to whatever the remote has now,
 * without touching the local branch. The `+` matches git's default fetch
 * refspec so a rewritten remote tip is still visible; inspect can then
 * report diverged instead of silently keeping a stale tracking ref.
 */
export async function fetchTrackingRef(
  repo: string,
  remote: string,
  branch: string,
): Promise<GitResult> {
  const name = branch.replace(/^refs\/heads\//, '');
  return git(repo, ['fetch', remote, `+refs/heads/${name}:refs/remotes/${remote}/${name}`]);
}

/**
 * Commits reachable from `left` but not `right` (`ahead`) and the reverse
 * (`behind`). Null when either ref does not resolve.
 */
export async function aheadBehind(
  repo: string,
  left: string,
  right: string,
): Promise<{ ahead: number; behind: number } | null> {
  const r = await git(repo, ['rev-list', '--left-right', '--count', `${left}...${right}`]);
  if (!r.ok) return null;
  const [aheadRaw, behindRaw] = r.stdout.trim().split(/\s+/);
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null;
  return { ahead, behind };
}

/**
 * Brings the local base ref up to the remote after a PR merged there, without
 * ever creating a merge commit or moving the operator off their branch.
 *
 * On the base branch this is a plain ff-only pull. On any other branch the
 * ref is updated in place via a fetch refspec — git only fast-forwards a
 * `base:base` refspec, and refuses to touch a checked-out branch, so both
 * paths are safe by construction.
 */
export async function fastForwardBase(
  repo: string,
  remote: string,
  baseRef: string,
): Promise<GitResult> {
  const onBase = (await currentBranch(repo)) === baseRef;
  if (onBase) return git(repo, ['pull', '--ff-only', remote, baseRef]);
  return git(repo, ['fetch', remote, `${baseRef}:${baseRef}`]);
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
  const baseNow = await resolveRef(repo, baseRef);
  if (baseNow && branchPointSha && baseNow !== branchPointSha) {
    return {
      ok: false,
      baseMoved: true,
      detail: `${baseRef} moved from ${branchPointSha.slice(0, 8)} to ${baseNow.slice(0, 8)} since this run branched — rebase before merging`,
    };
  }

  const startedOn = await currentBranch(repo);
  const onBase = startedOn === baseRef;
  if (!onBase) {
    const checkout = await git(repo, ['checkout', baseRef]);
    if (!checkout.ok) {
      const checkoutBranch = await git(repo, ['checkout', '-b', baseRef]);
      if (!checkoutBranch.ok) {
        return {
          ok: false,
          baseMoved: false,
          detail: checkout.stdout.trim() || `could not check out ${baseRef}`,
        };
      }
    }
  }

  const hasCommits = await refExists(repo, 'HEAD');
  const merged = hasCommits
    ? await git(repo, ['merge', '--no-ff', branch, '-m', `foundry: merge ${branch}`])
    : await git(repo, ['merge', branch]);
  if (merged.ok) return { ok: true, baseMoved: false, detail: merged.stdout };

  await git(repo, ['merge', '--abort']);
  if (startedOn && startedOn !== 'HEAD' && startedOn !== baseRef) {
    await git(repo, ['checkout', startedOn]);
  }
  return { ok: false, baseMoved: false, detail: merged.stdout.trim() || 'merge failed' };
}
