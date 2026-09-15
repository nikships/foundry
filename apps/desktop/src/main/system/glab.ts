/**
 * GitLab's `glab` CLI as a typed surface, parallel to system/gh.ts.
 * Foundry never talks to the GitLab API itself: glab owns auth, remotes, and
 * pagination, so the app inherits whatever the operator already set up —
 * `glab auth login` or a token env var (`GITLAB_TOKEN` / `GITLAB_ACCESS_TOKEN`
 * / `OAUTH_TOKEN`) — and stores no token of its own.
 *
 * Merge-request operations map onto the same shapes as GitHub PRs so forge
 * routing can present one UI.
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import type { GhStatus, PrChecks, PrMergeMethod, PullRequest } from '@shared/types.js';
import type { IssueAction, PrAction, PrList } from '@shared/ipc-contract.js';
import { preferredRemote, pushBranch } from '../engine/git.js';
import { spawnEnv } from './env.js';
import { cliAuthSatisfied, gitlabTokenEnvName } from './scm-auth.js';

const exec = promisify(execFile);

/** Test seam: the fake glab script stands in for the real binary. */
export interface GlabOptions {
  bin?: string;
}

interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function glab(
  bin: string,
  cwd: string,
  args: string[],
  timeoutMs?: number,
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(bin, args, {
      cwd,
      ...(timeoutMs ? { timeout: timeoutMs } : {}),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: spawnEnv({ NO_COLOR: '1' }),
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

function firstLine(result: CliResult): string {
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

function createdUrl(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('https://'))
    .pop();
}

function numberFromUrl(
  url: string | undefined,
  kind: 'merge_requests' | 'issues',
): number | undefined {
  const parsed = Number(url && new RegExp(`/${kind}/(\\d+)`).exec(url)?.[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Installed and signed in (login or token env), or the reason not. */
async function glabUsable(bin: string, cwd: string): Promise<string | null> {
  const version = await glab(bin, cwd, ['--version'], 10_000);
  if (!version.ok) return 'GitLab CLI (glab) is not installed or not on PATH';
  const auth = await glab(bin, cwd, ['auth', 'status'], 15_000);
  if (cliAuthSatisfied(auth.ok, gitlabTokenEnvName())) return null;
  return 'glab is not signed in — run `glab auth login` in a terminal, or set GITLAB_TOKEN';
}

/**
 * Whether MR features can work for a GitLab remote: glab installed, authenticated,
 * and the repo resolving on GitLab. Returned as GhStatus so the PR UI stays one shape.
 */
export async function glabStatus(repo: string, opts: GlabOptions = {}): Promise<GhStatus> {
  const bin = opts.bin ?? 'glab';
  const unusable = await glabUsable(bin, repo);
  if (unusable) return { available: false, detail: unusable, cli: 'glab' };
  const view = await glab(bin, repo, ['repo', 'view', '-F', 'json'], 30_000);
  if (!view.ok) {
    return {
      available: false,
      detail: firstLine(view) || 'glab could not resolve this repo on GitLab',
      cli: 'glab',
    };
  }
  const name = safeParse<{ path_with_namespace?: string }>(view.stdout)?.path_with_namespace;
  return {
    available: true,
    detail: name ? `glab is signed in; repo resolves to ${name}` : 'glab is signed in',
    repo: name,
    cli: 'glab',
  };
}

interface MrRef {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
}

interface RawMr {
  iid?: number;
  number?: number;
  web_url?: string;
  url?: string;
  source_branch?: string;
  target_branch?: string;
  title?: string;
  state?: string;
  merged_at?: string | null;
  author?: { username?: string; name?: string };
  created_at?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
  user_notes_count?: number;
}

function mrIdentity(raw: RawMr | null): { number: number; url: string } | null {
  if (!raw) return null;
  const number = raw.iid ?? raw.number;
  const url = raw.web_url ?? raw.url;
  if (typeof number !== 'number' || typeof url !== 'string') return null;
  return { number, url };
}

function parseMr(result: CliResult): RawMr | null {
  if (!result.ok) return null;
  return safeParse<RawMr>(result.stdout);
}

/** The MR for a branch or iid, or null when none exists. */
export async function viewMr(
  repo: string,
  ref: string | number,
  opts: GlabOptions = {},
): Promise<MrRef | null> {
  const bin = opts.bin ?? 'glab';
  const parsed = parseMr(await glab(bin, repo, ['mr', 'view', String(ref), '-F', 'json'], 30_000));
  const id = mrIdentity(parsed);
  if (!id || !parsed) return null;
  return {
    number: id.number,
    url: id.url,
    headRefName: parsed.source_branch ?? '',
    baseRefName: parsed.target_branch ?? '',
  };
}

export interface MrMergeState {
  number: number;
  url: string;
  merged: boolean;
  state: string;
}

export async function viewMrMergeState(
  repo: string,
  ref: string | number,
  opts: GlabOptions = {},
): Promise<MrMergeState | null> {
  const bin = opts.bin ?? 'glab';
  const parsed = parseMr(await glab(bin, repo, ['mr', 'view', String(ref), '-F', 'json'], 30_000));
  const id = mrIdentity(parsed);
  if (!id || !parsed) return null;
  const state = String(parsed.state ?? '');
  const merged = state.toLowerCase() === 'merged' || Boolean(parsed.merged_at);
  return {
    number: id.number,
    url: id.url,
    merged,
    state: state || (merged ? 'merged' : 'opened'),
  };
}

/**
 * Push the branch, then open the MR. Same contract as gh.openPr so forge
 * routing can treat GitHub PRs and GitLab MRs as one flow.
 */
export async function openMr(
  repo: string,
  input: { branch: string; baseRef: string; title: string; body: string },
  opts: GlabOptions = {},
): Promise<PrAction> {
  const bin = opts.bin ?? 'glab';
  const remote = await preferredRemote(repo);
  if (!remote) return { ok: false, detail: 'this repo has no git remote to push to' };

  const pushed = await pushBranch(repo, remote, input.branch);
  if (!pushed.ok) {
    return {
      ok: false,
      detail: pushed.stdout.trim() || `could not push ${input.branch} to ${remote}`,
    };
  }

  const created = await glab(bin, repo, [
    'mr',
    'create',
    '--source-branch',
    input.branch,
    '--target-branch',
    input.baseRef,
    '--title',
    input.title,
    '--description',
    input.body,
    '--yes',
    '--no-editor',
  ]);
  if (!created.ok) {
    const existing = await viewMr(repo, input.branch, opts);
    if (existing) {
      return {
        ok: true,
        detail: `a merge request for ${input.branch} already exists: ${existing.url}`,
        number: existing.number,
        url: existing.url,
      };
    }
    return { ok: false, detail: firstLine(created) || 'glab mr create failed' };
  }

  const url = createdUrl(created.stdout);
  return {
    ok: true,
    detail: url ? `opened ${url}` : created.stdout.trim() || 'merge request opened',
    number: numberFromUrl(url, 'merge_requests'),
    url,
  };
}

export async function createGitlabIssue(
  repo: string,
  input: { title: string; body: string; labels?: string[] },
  opts: GlabOptions = {},
): Promise<IssueAction> {
  const bin = opts.bin ?? 'glab';
  const labels = (input.labels ?? []).map((l) => l.trim()).filter(Boolean);
  const argv = (withLabels: boolean): string[] => [
    'issue',
    'create',
    '--title',
    input.title,
    '--description',
    input.body,
    '--yes',
    '--no-editor',
    ...(withLabels ? labels.flatMap((label) => ['--label', label]) : []),
  ];

  let created = await glab(bin, repo, argv(true));
  let note = '';
  if (!created.ok && labels.length) {
    const retried = await glab(bin, repo, argv(false));
    if (retried.ok) {
      note = ` (labels ${labels.join(', ')} were not applied: ${firstLine(created)})`;
      created = retried;
    }
  }
  if (!created.ok) {
    return { ok: false, detail: firstLine(created) || 'glab issue create failed' };
  }

  const url = createdUrl(created.stdout);
  const number = numberFromUrl(url, 'issues');
  if (!url || number === undefined) {
    return {
      ok: false,
      detail: `glab issue create did not report an issue URL: ${created.stdout.trim() || 'empty output'}`,
    };
  }
  return { ok: true, detail: `filed ${url}${note}`, number, url };
}

const MERGEABLE_OK = new Set(['can_be_merged', 'mergeable']);
const MERGEABLE_CONFLICT = new Set(['cannot_be_merged', 'cannot_be_merged_recheck', 'conflict']);

function mapMergeable(raw: RawMr): PullRequest['mergeable'] {
  const status = String(raw.detailed_merge_status ?? raw.merge_status ?? '').toLowerCase();
  if (MERGEABLE_OK.has(status)) return 'mergeable';
  if (MERGEABLE_CONFLICT.has(status) || status.includes('conflict')) return 'conflicting';
  return 'unknown';
}

function mapMr(raw: RawMr): PullRequest | null {
  const id = mrIdentity(raw);
  if (!id || !raw.title) return null;
  return {
    number: id.number,
    title: raw.title,
    url: id.url,
    author: raw.author?.username ?? raw.author?.name ?? '',
    headRefName: raw.source_branch ?? '',
    baseRefName: raw.target_branch ?? '',
    createdAt: raw.created_at ?? '',
    additions: 0,
    deletions: 0,
    isDraft: Boolean(raw.draft || raw.work_in_progress),
    checks: 'none' as PrChecks,
    mergeable: mapMergeable(raw),
    reviewDecision: '',
  };
}

export async function listOpenMrs(repo: string, opts: GlabOptions = {}): Promise<PrList> {
  const bin = opts.bin ?? 'glab';
  const r = await glab(
    bin,
    repo,
    ['mr', 'list', '--state', 'opened', '--per-page', '50', '-F', 'json'],
    60_000,
  );
  if (!r.ok) return { ok: false, detail: firstLine(r) || 'glab mr list failed', prs: [] };
  const rows = safeParse<RawMr[]>(r.stdout);
  if (!rows) return { ok: false, detail: 'could not parse glab mr list output', prs: [] };
  const prs = rows.map(mapMr).filter((row): row is PullRequest => row !== null);
  return { ok: true, detail: `${prs.length} open`, prs };
}

export interface MergeMrOutcome {
  ok: boolean;
  detail: string;
  headRefName?: string;
  baseRefName?: string;
  url?: string;
}

export async function mergeMr(
  repo: string,
  mrNumber: number,
  method: PrMergeMethod,
  opts: GlabOptions = {},
): Promise<MergeMrOutcome> {
  const bin = opts.bin ?? 'glab';
  const mr = await viewMr(repo, mrNumber, opts);
  const argv = [
    'mr',
    'merge',
    String(mrNumber),
    '--yes',
    '--auto-merge=false',
    ...(method === 'squash' ? ['--squash'] : []),
  ];
  const merged = await glab(bin, repo, argv);
  return {
    ok: merged.ok,
    detail: merged.ok
      ? `merged !${mrNumber} (${method})`
      : firstLine(merged) || 'glab mr merge failed',
    headRefName: mr?.headRefName,
    baseRefName: mr?.baseRefName,
    url: mr?.url,
  };
}

/** Account probe without a repo, for doctor/settings symmetry with githubAccount. */
export async function gitlabAccount(opts: GlabOptions = {}): Promise<{
  available: boolean;
  detail: string;
  login?: string;
}> {
  const bin = opts.bin ?? 'glab';
  const cwd = homedir();
  const unusable = await glabUsable(bin, cwd);
  if (unusable) return { available: false, detail: unusable };
  const user = await glab(bin, cwd, ['api', 'user'], 30_000);
  const login = safeParse<{ username?: string }>(user.stdout)?.username;
  if (!user.ok || !login) {
    return {
      available: false,
      detail: firstLine(user) || 'glab is signed in but could not read your account',
    };
  }
  return { available: true, detail: `signed in as ${login}`, login };
}
