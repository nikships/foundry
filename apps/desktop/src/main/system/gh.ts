/**
 * GitHub's `gh` CLI as a typed surface, the same way engine/git.ts wraps git.
 * Foundry never talks to the GitHub API itself: gh owns auth, remotes, and
 * pagination, so the app inherits whatever the operator's `gh auth login`
 * already set up and stores no token of its own.
 *
 * Calls run through execFile rather than runCommand because runCommand keeps
 * only a 4000-char output tail — fine for a failure log, fatal for `--json`
 * payloads that must parse whole.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  GhStatus,
  GithubAccount,
  PrChecks,
  PrMergeMethod,
  PullRequest,
} from '@shared/types.js';
import type {
  IssueAction,
  NewRepoInput,
  NewRepoResult,
  PrAction,
  PrList,
} from '@shared/ipc-contract.js';
import { preferredRemote, pushBranch } from '../engine/git.js';
import { spawnEnv } from './env.js';

const exec = promisify(execFile);

/** Test seam: the fake gh script stands in for the real binary. */
export interface GhOptions {
  bin?: string;
}

interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function gh(bin: string, cwd: string, args: string[], timeoutMs?: number): Promise<GhResult> {
  try {
    const { stdout, stderr } = await exec(bin, args, {
      cwd,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      // Never let gh stop to ask a question a headless call cannot answer.
      env: spawnEnv({ GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' }),
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

/** gh writes errors to stderr with blank padding; the first real line is the reason. */
function firstLine(result: GhResult): string {
  return (
    (result.stderr || result.stdout)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** gh prints the URL of what it just created as the last https line on stdout. */
function createdUrl(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('https://'))
    .pop();
}

function numberFromUrl(url: string | undefined, kind: 'pull' | 'issues'): number | undefined {
  const parsed = Number(url && new RegExp(`/${kind}/(\\d+)`).exec(url)?.[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether PR features can work for this repo, checked in the order the fixes
 * differ: install gh, sign in, then have a remote GitHub can resolve.
 */
/** Installed and signed in, or the reason not. Checked from `cwd`. */
async function ghUsable(bin: string, cwd: string): Promise<string | null> {
  const version = await gh(bin, cwd, ['--version'], 10_000);
  if (!version.ok) return 'GitHub CLI (gh) is not installed or not on PATH';
  const auth = await gh(bin, cwd, ['auth', 'status'], 15_000);
  if (!auth.ok) return 'gh is not signed in — run `gh auth login` in a terminal';
  return null;
}

export async function ghStatus(repo: string, opts: GhOptions = {}): Promise<GhStatus> {
  const bin = opts.bin ?? 'gh';
  const unusable = await ghUsable(bin, repo);
  if (unusable) return { available: false, detail: unusable };
  const view = await gh(bin, repo, ['repo', 'view', '--json', 'nameWithOwner'], 30_000);
  if (!view.ok) {
    return {
      available: false,
      detail: firstLine(view) || 'gh could not resolve this repo on GitHub',
    };
  }
  const name = safeParse<{ nameWithOwner?: string }>(view.stdout)?.nameWithOwner;
  return {
    available: true,
    detail: name ? `gh is signed in; repo resolves to ${name}` : 'gh is signed in',
    repo: name,
  };
}

/**
 * Who gh is signed in as. `ghStatus` answers "can this repo do PRs", which
 * needs a checkout; creating a repository happens before one exists, so the
 * account is asked for on its own, from a directory that always exists.
 *
 * A failure to list orgs is not a failure to be signed in: most people create
 * under their own login, so the owner list degrades to just that.
 */
export async function githubAccount(opts: GhOptions = {}): Promise<GithubAccount> {
  const bin = opts.bin ?? 'gh';
  const cwd = homedir();
  const unusable = await ghUsable(bin, cwd);
  if (unusable) return { available: false, detail: unusable };
  const user = await gh(bin, cwd, ['api', 'user'], 30_000);
  const login = safeParse<{ login?: string }>(user.stdout)?.login;
  if (!user.ok || !login) {
    return {
      available: false,
      detail: firstLine(user) || 'gh is signed in but could not read your account',
    };
  }

  const orgsResult = await gh(bin, cwd, ['api', 'user/orgs', '--paginate'], 30_000);
  const orgs = orgsResult.ok
    ? (safeParse<{ login?: string }[]>(orgsResult.stdout) ?? [])
        .map((org) => org?.login)
        .filter((name): name is string => !!name && name !== login)
    : [];

  return {
    available: true,
    detail: `signed in as ${login}`,
    login,
    owners: [login, ...orgs],
  };
}

/**
 * GitHub's own rule, applied before the network call so a bad name costs a
 * keystroke rather than a round trip. `.` and `..` pass the character class but
 * would name the parent directory rather than a new one.
 */
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function repoNameIssue(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'a repository needs a name';
  if (trimmed === '.' || trimmed === '..') return `"${trimmed}" is not a repository name`;
  if (!REPO_NAME.test(trimmed)) {
    return 'use letters, numbers, dots, hyphens and underscores only';
  }
  return null;
}

/**
 * Create on GitHub, then clone. `--add-readme` is not decoration: a repository
 * with no commits has no HEAD, `git worktree add` refuses it, and every run
 * would die at isolation before the first agent turn. One commit makes the
 * clone a repo Foundry can actually branch from.
 *
 * Visibility is passed as an explicit flag on every call, never defaulted by
 * gh, so "private" is a fact about the argv rather than a hope about config.
 */
export async function createRepo(
  input: NewRepoInput,
  opts: GhOptions = {},
): Promise<NewRepoResult> {
  const bin = opts.bin ?? 'gh';
  const name = input.name.trim();
  const nameIssue = repoNameIssue(name);
  if (nameIssue) return { ok: false, detail: nameIssue };

  const parentDir = input.parentDir.trim();
  if (!parentDir || !existsSync(parentDir)) {
    return { ok: false, detail: `${parentDir || 'the chosen folder'} does not exist` };
  }
  const path = join(parentDir, name);
  if (existsSync(path)) {
    return { ok: false, detail: `${path} already exists — pick another name or folder` };
  }

  const owner = input.owner?.trim();
  const target = owner ? `${owner}/${name}` : name;
  const argv = [
    'repo',
    'create',
    target,
    `--${input.visibility}`,
    '--add-readme',
    '--clone',
    ...(input.description?.trim() ? ['--description', input.description.trim()] : []),
  ];

  const created = await gh(bin, parentDir, argv, 180_000);
  if (!created.ok) {
    return { ok: false, detail: firstLine(created) || 'gh repo create failed' };
  }
  // gh reports success even when the clone step is the part that failed, so the
  // directory is the evidence, not the exit code.
  if (!existsSync(path)) {
    return {
      ok: false,
      detail: `gh created ${target} but no clone landed at ${path}`,
      nameWithOwner: target,
    };
  }

  const url =
    `${created.stdout}\n${created.stderr}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('https://github.com/')) ?? `https://github.com/${target}`;

  return { ok: true, detail: `created ${target}`, url, nameWithOwner: target, path };
}

interface PrRef {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
}

/**
 * A PR without a number and URL cannot be acted on, so a row missing either is
 * treated as "no PR" rather than partially trusted.
 */
function identifiedPr<T extends { number?: number; url?: string }>(
  result: GhResult,
): (T & { number: number; url: string }) | null {
  if (!result.ok) return null;
  const parsed = safeParse<T>(result.stdout);
  if (!parsed || typeof parsed.number !== 'number' || typeof parsed.url !== 'string') return null;
  return parsed as T & { number: number; url: string };
}

/** The PR for a branch or number, or null when none exists. */
export async function viewPr(
  repo: string,
  ref: string | number,
  opts: GhOptions = {},
): Promise<PrRef | null> {
  const bin = opts.bin ?? 'gh';
  const parsed = identifiedPr<Partial<PrRef>>(
    await gh(
      bin,
      repo,
      ['pr', 'view', String(ref), '--json', 'number,url,headRefName,baseRefName'],
      30_000,
    ),
  );
  if (!parsed) return null;
  return {
    number: parsed.number,
    url: parsed.url,
    headRefName: parsed.headRefName ?? '',
    baseRefName: parsed.baseRefName ?? '',
  };
}

export interface PrMergeState {
  number: number;
  url: string;
  merged: boolean;
  state: string;
}

/** Merge confirmation: state + mergedAt, used by readiness (not run PRs). */
export async function viewPrMergeState(
  repo: string,
  ref: string | number,
  opts: GhOptions = {},
): Promise<PrMergeState | null> {
  const bin = opts.bin ?? 'gh';
  const parsed = identifiedPr<{
    number?: number;
    url?: string;
    state?: string;
    mergedAt?: string | null;
  }>(
    await gh(bin, repo, ['pr', 'view', String(ref), '--json', 'number,url,state,mergedAt'], 30_000),
  );
  if (!parsed) return null;
  const state = parsed.state ?? '';
  const merged = state.toUpperCase() === 'MERGED' || Boolean(parsed.mergedAt);
  return {
    number: parsed.number,
    url: parsed.url,
    merged,
    state: state || (merged ? 'MERGED' : 'OPEN'),
  };
}

/**
 * Push the branch, then open the PR. The push always runs first — gh can only
 * create a PR for a head GitHub has seen — and a branch whose PR already
 * exists reports that PR rather than an error, so a double click is harmless.
 */
export async function openPr(
  repo: string,
  input: { branch: string; baseRef: string; title: string; body: string },
  opts: GhOptions = {},
): Promise<PrAction> {
  const bin = opts.bin ?? 'gh';
  const remote = await preferredRemote(repo);
  if (!remote) return { ok: false, detail: 'this repo has no git remote to push to' };

  const pushed = await pushBranch(repo, remote, input.branch);
  if (!pushed.ok) {
    return {
      ok: false,
      detail: pushed.stdout.trim() || `could not push ${input.branch} to ${remote}`,
    };
  }

  const created = await gh(bin, repo, [
    'pr',
    'create',
    '--head',
    input.branch,
    '--base',
    input.baseRef,
    '--title',
    input.title,
    '--body',
    input.body,
  ]);
  if (!created.ok) {
    const existing = await viewPr(repo, input.branch, opts);
    if (existing) {
      return {
        ok: true,
        detail: `a pull request for ${input.branch} already exists: ${existing.url}`,
        number: existing.number,
        url: existing.url,
      };
    }
    return { ok: false, detail: firstLine(created) || 'gh pr create failed' };
  }

  const url = createdUrl(created.stdout);
  return {
    ok: true,
    detail: url ? `opened ${url}` : created.stdout.trim() || 'pull request opened',
    number: numberFromUrl(url, 'pull'),
    url,
  };
}

/**
 * File a GitHub issue. No push is involved — an issue is repository metadata,
 * not a branch — so this works even for a run that never isolated. Labels are
 * best-effort by retry: gh refuses the whole create when a label does not
 * exist, and an issue without labels beats no issue.
 */
export async function createIssue(
  repo: string,
  input: { title: string; body: string; labels?: string[] },
  opts: GhOptions = {},
): Promise<IssueAction> {
  const bin = opts.bin ?? 'gh';
  const labels = (input.labels ?? []).map((l) => l.trim()).filter(Boolean);
  const argv = (withLabels: boolean): string[] => [
    'issue',
    'create',
    '--title',
    input.title,
    '--body',
    input.body,
    ...(withLabels ? labels.flatMap((label) => ['--label', label]) : []),
  ];

  let created = await gh(bin, repo, argv(true));
  let note = '';
  if (!created.ok && labels.length) {
    const retried = await gh(bin, repo, argv(false));
    if (retried.ok) {
      note = ` (labels ${labels.join(', ')} were not applied: ${firstLine(created)})`;
      created = retried;
    }
  }
  if (!created.ok) {
    return { ok: false, detail: firstLine(created) || 'gh issue create failed' };
  }

  const url = createdUrl(created.stdout);
  const number = numberFromUrl(url, 'issues');
  if (!url || number === undefined) {
    return {
      ok: false,
      detail: `gh issue create did not report an issue URL: ${created.stdout.trim() || 'empty output'}`,
    };
  }
  return { ok: true, detail: `filed ${url}${note}`, number, url };
}

/**
 * gh reports two shapes inside statusCheckRollup — CheckRun (status +
 * conclusion) and StatusContext (state) — flattened here to the one word a
 * list row has room for. Failure wins over pending: a red check is the fact
 * to surface even while others still spin.
 */
const FAILING_STATES = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
]);
const PENDING_STATES = new Set(['EXPECTED', 'PENDING', 'QUEUED', 'IN_PROGRESS', '']);

export function summarizeChecks(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let sawFailing = false;
  let sawPending = false;
  for (const item of rollup) {
    const check = (item ?? {}) as Record<string, unknown>;
    const status = String(check.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') {
      sawPending = true;
      continue;
    }
    const state = String(check.state ?? check.conclusion ?? '').toUpperCase();
    if (FAILING_STATES.has(state)) sawFailing = true;
    else if (PENDING_STATES.has(state)) sawPending = true;
  }
  if (sawFailing) return 'failing';
  return sawPending ? 'pending' : 'passing';
}

interface RawPr {
  number: number;
  title: string;
  url: string;
  author?: { login?: string };
  headRefName?: string;
  baseRefName?: string;
  createdAt?: string;
  additions?: number;
  deletions?: number;
  isDraft?: boolean;
  reviewDecision?: string;
  mergeable?: string;
  statusCheckRollup?: unknown;
}

const MERGEABLE: Record<string, PullRequest['mergeable']> = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
};

function mapPr(raw: RawPr): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? '',
    headRefName: raw.headRefName ?? '',
    baseRefName: raw.baseRefName ?? '',
    createdAt: raw.createdAt ?? '',
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    isDraft: !!raw.isDraft,
    checks: summarizeChecks(raw.statusCheckRollup),
    mergeable: MERGEABLE[String(raw.mergeable ?? '').toUpperCase()] ?? 'unknown',
    reviewDecision: raw.reviewDecision ?? '',
  };
}

const LIST_FIELDS =
  'number,title,url,author,headRefName,baseRefName,createdAt,additions,deletions,isDraft,reviewDecision,mergeable,statusCheckRollup';

export async function listOpenPrs(repo: string, opts: GhOptions = {}): Promise<PrList> {
  const bin = opts.bin ?? 'gh';
  const r = await gh(
    bin,
    repo,
    ['pr', 'list', '--state', 'open', '--limit', '50', '--json', LIST_FIELDS],
    60_000,
  );
  if (!r.ok) return { ok: false, detail: firstLine(r) || 'gh pr list failed', prs: [] };
  const rows = safeParse<RawPr[]>(r.stdout);
  if (!rows) return { ok: false, detail: 'could not parse gh pr list output', prs: [] };
  // A row without its identity fields cannot render or merge; drop it rather
  // than showing a blank card whose buttons target nothing.
  const usable = rows.filter(
    (row) => typeof row?.number === 'number' && typeof row.url === 'string' && !!row.title,
  );
  return { ok: true, detail: `${usable.length} open`, prs: usable.map(mapPr) };
}

export interface MergePrOutcome {
  ok: boolean;
  detail: string;
  /** From a pre-merge view, so callers can settle the local branch after. */
  headRefName?: string;
  baseRefName?: string;
  url?: string;
}

/**
 * Merge on GitHub. The PR is viewed first so the head branch survives the
 * merge for local settlement; the view failing is not a reason to refuse the
 * merge the operator asked for.
 */
export async function mergePr(
  repo: string,
  prNumber: number,
  method: PrMergeMethod,
  opts: GhOptions = {},
): Promise<MergePrOutcome> {
  const bin = opts.bin ?? 'gh';
  const pr = await viewPr(repo, prNumber, opts);
  const merged = await gh(bin, repo, ['pr', 'merge', String(prNumber), `--${method}`]);
  return {
    ok: merged.ok,
    detail: merged.ok
      ? `merged #${prNumber} (${method})`
      : firstLine(merged) || 'gh pr merge failed',
    headRefName: pr?.headRefName,
    baseRefName: pr?.baseRefName,
    url: pr?.url,
  };
}
