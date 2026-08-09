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
import { promisify } from 'node:util';
import type { GhStatus, PrChecks, PrMergeMethod, PullRequest } from '@shared/types.js';
import type { PrAction, PrList } from '@shared/ipc-contract.js';
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

async function gh(bin: string, cwd: string, args: string[], timeoutMs = 60_000): Promise<GhResult> {
  try {
    const { stdout, stderr } = await exec(bin, args, {
      cwd,
      timeout: timeoutMs,
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

/**
 * Whether PR features can work for this repo, checked in the order the fixes
 * differ: install gh, sign in, then have a remote GitHub can resolve.
 */
export async function ghStatus(repo: string, opts: GhOptions = {}): Promise<GhStatus> {
  const bin = opts.bin ?? 'gh';
  const version = await gh(bin, repo, ['--version'], 10_000);
  if (!version.ok) {
    return { available: false, detail: 'GitHub CLI (gh) is not installed or not on PATH' };
  }
  const auth = await gh(bin, repo, ['auth', 'status'], 15_000);
  if (!auth.ok) {
    return { available: false, detail: 'gh is not signed in — run `gh auth login` in a terminal' };
  }
  const view = await gh(bin, repo, ['repo', 'view', '--json', 'nameWithOwner'], 30_000);
  if (!view.ok) {
    return {
      available: false,
      detail: firstLine(view) || 'gh could not resolve this repo on GitHub',
    };
  }
  const parsed = safeParse<{ nameWithOwner?: string }>(view.stdout);
  const name = parsed?.nameWithOwner;
  return {
    available: true,
    detail: name ? `gh is signed in; repo resolves to ${name}` : 'gh is signed in',
    repo: name,
  };
}

interface PrRef {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
}

/** The PR for a branch or number, or null when none exists. */
export async function viewPr(
  repo: string,
  ref: string | number,
  opts: GhOptions = {},
): Promise<PrRef | null> {
  const bin = opts.bin ?? 'gh';
  const r = await gh(
    bin,
    repo,
    ['pr', 'view', String(ref), '--json', 'number,url,headRefName,baseRefName'],
    30_000,
  );
  if (!r.ok) return null;
  const parsed = safeParse<Partial<PrRef>>(r.stdout);
  if (!parsed || typeof parsed.number !== 'number' || typeof parsed.url !== 'string') return null;
  return {
    number: parsed.number,
    url: parsed.url,
    headRefName: parsed.headRefName ?? '',
    baseRefName: parsed.baseRefName ?? '',
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

  const created = await gh(
    bin,
    repo,
    [
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
    ],
    60_000,
  );
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

  // gh prints the new PR's URL as the last non-empty stdout line.
  const url = created.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https:\/\//.test(line))
    .pop();
  const number = url ? Number(/\/pull\/(\d+)/.exec(url)?.[1]) : NaN;
  return {
    ok: true,
    detail: url ? `opened ${url}` : created.stdout.trim() || 'pull request opened',
    number: Number.isFinite(number) ? number : undefined,
    url,
  };
}

/**
 * gh reports two shapes inside statusCheckRollup — CheckRun (status +
 * conclusion) and StatusContext (state) — flattened here to the one word a
 * list row has room for. Failure wins over pending: a red check is the fact
 * to surface even while others still spin.
 */
export function summarizeChecks(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  const failing = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
  const pendingStates = new Set(['EXPECTED', 'PENDING', 'QUEUED', 'IN_PROGRESS', '']);
  let sawFailing = false;
  let sawPending = false;
  for (const item of rollup) {
    const c = (item ?? {}) as Record<string, unknown>;
    const status = String(c.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') {
      sawPending = true;
      continue;
    }
    const state = String(c.state ?? c.conclusion ?? '').toUpperCase();
    if (failing.has(state)) sawFailing = true;
    else if (pendingStates.has(state)) sawPending = true;
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

function mapPr(raw: RawPr): PullRequest {
  const mergeable = String(raw.mergeable ?? '').toUpperCase();
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
    mergeable:
      mergeable === 'MERGEABLE'
        ? 'mergeable'
        : mergeable === 'CONFLICTING'
          ? 'conflicting'
          : 'unknown',
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
  const merged = await gh(bin, repo, ['pr', 'merge', String(prNumber), `--${method}`], 120_000);
  if (!merged.ok) {
    return {
      ok: false,
      detail: firstLine(merged) || 'gh pr merge failed',
      headRefName: pr?.headRefName,
      baseRefName: pr?.baseRefName,
      url: pr?.url,
    };
  }
  return {
    ok: true,
    detail: `merged #${prNumber} (${method})`,
    headRefName: pr?.headRefName,
    baseRefName: pr?.baseRefName,
    url: pr?.url,
  };
}
