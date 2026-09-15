/**
 * Provider-parameterized forge CLI ops. GitHub (`gh`) and GitLab (`glab`) share
 * one implementation; only argv, JSON shapes, and copy diverge.
 */

import type { GhStatus, PrChecks, PrMergeMethod, PullRequest } from '@shared/types.js';
import type { IssueAction, PrAction, PrList } from '@shared/ipc-contract.js';
import { preferredRemote, pushBranch } from '../engine/git.js';
import { cliAuthSatisfied, githubTokenEnvName, gitlabTokenEnvName } from './scm-auth.js';
import {
  createdUrl,
  firstLine,
  numberFromUrl,
  runCli,
  safeParse,
  type CliResult,
} from './scm-cli.js';

export type ForgeKind = 'github' | 'gitlab';
export type ForgeCliName = 'gh' | 'glab';
export interface ForgeBinOptions {
  bin?: string;
}

export interface PrRef {
  number: number;
  url: string;
  headRefName: string;
  baseRefName: string;
}
export interface PrMergeState extends PrRef {
  merged: boolean;
  state: string;
}
export interface MergeOutcome {
  ok: boolean;
  detail: string;
  headRefName?: string;
  baseRefName?: string;
  url?: string;
}

type OpenInput = { branch: string; baseRef: string; title: string; body: string };
type IssueInput = { title: string; body: string; labels?: string[] };
type ViewParsed = PrRef & { state: string; mergedAt: string | null };

interface ForgeProvider {
  kind: ForgeKind;
  cli: ForgeCliName;
  defaultBin: string;
  envExtras: Record<string, string>;
  tokenEnvName: () => string | undefined;
  notInstalled: string;
  notSignedIn: string;
  resolveFailed: string;
  noun: string; // "pull request" | "merge request"
  hash: string; // "#" | "!"
  repoViewArgs: string[];
  parseRepoName: (stdout: string) => string | undefined;
  viewArgs: (ref: string) => string[];
  parseView: (stdout: string) => ViewParsed | null;
  createArgs: (input: OpenInput) => string[];
  createUrlPattern: RegExp;
  issueArgs: (input: IssueInput, withLabels: boolean) => string[];
  issueUrlPattern: RegExp;
  listArgs: string[];
  parseList: (stdout: string) => PullRequest[] | null;
  mergeArgs: (n: number, method: PrMergeMethod) => string[];
}

const FAILING = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PENDING = new Set(['EXPECTED', 'PENDING', 'QUEUED', 'IN_PROGRESS', '']);

export function summarizeChecks(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let failing = false;
  let pending = false;
  for (const item of rollup) {
    const c = (item ?? {}) as Record<string, unknown>;
    const status = String(c.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') {
      pending = true;
      continue;
    }
    const state = String(c.state ?? c.conclusion ?? '').toUpperCase();
    if (FAILING.has(state)) failing = true;
    else if (PENDING.has(state)) pending = true;
  }
  return failing ? 'failing' : pending ? 'pending' : 'passing';
}

const GH_LIST =
  'number,title,url,author,headRefName,baseRefName,createdAt,additions,deletions,isDraft,reviewDecision,mergeable,statusCheckRollup';
const GH_MERGEABLE: Record<string, PullRequest['mergeable']> = {
  MERGEABLE: 'mergeable',
  CONFLICTING: 'conflicting',
};

function labelFlags(labels: string[] | undefined, on: boolean): string[] {
  if (!on) return [];
  return (labels ?? [])
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => ['--label', l]);
}

function mapGh(raw: {
  number?: number;
  title?: string;
  url?: string;
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
}): PullRequest | null {
  if (typeof raw?.number !== 'number' || typeof raw.url !== 'string' || !raw.title) return null;
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
    mergeable: GH_MERGEABLE[String(raw.mergeable ?? '').toUpperCase()] ?? 'unknown',
    reviewDecision: raw.reviewDecision ?? '',
  };
}

function mapGl(raw: {
  iid?: number;
  number?: number;
  web_url?: string;
  url?: string;
  title?: string;
  source_branch?: string;
  target_branch?: string;
  author?: { username?: string; name?: string };
  created_at?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
}): PullRequest | null {
  const number = raw.iid ?? raw.number;
  const url = raw.web_url ?? raw.url;
  if (typeof number !== 'number' || typeof url !== 'string' || !raw.title) return null;
  const status = String(raw.detailed_merge_status ?? raw.merge_status ?? '').toLowerCase();
  const mergeable: PullRequest['mergeable'] =
    status === 'can_be_merged' || status === 'mergeable'
      ? 'mergeable'
      : status.includes('conflict') || status.startsWith('cannot_be_merged')
        ? 'conflicting'
        : 'unknown';
  return {
    number,
    title: raw.title,
    url,
    author: raw.author?.username ?? raw.author?.name ?? '',
    headRefName: raw.source_branch ?? '',
    baseRefName: raw.target_branch ?? '',
    createdAt: raw.created_at ?? '',
    additions: 0,
    deletions: 0,
    isDraft: Boolean(raw.draft || raw.work_in_progress),
    checks: 'none',
    mergeable,
    reviewDecision: '',
  };
}

function github(): ForgeProvider {
  return {
    kind: 'github',
    cli: 'gh',
    defaultBin: 'gh',
    envExtras: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    tokenEnvName: githubTokenEnvName,
    notInstalled: 'GitHub CLI (gh) is not installed or not on PATH',
    notSignedIn:
      'gh is not signed in — run `gh auth login` in a terminal, or set GH_TOKEN / GITHUB_TOKEN',
    resolveFailed: 'gh could not resolve this repo on GitHub',
    noun: 'pull request',
    hash: '#',
    repoViewArgs: ['repo', 'view', '--json', 'nameWithOwner'],
    parseRepoName: (s) => safeParse<{ nameWithOwner?: string }>(s)?.nameWithOwner,
    viewArgs: (ref) => [
      'pr',
      'view',
      ref,
      '--json',
      'number,url,headRefName,baseRefName,state,mergedAt',
    ],
    parseView: (s) => {
      const p = safeParse<{
        number?: number;
        url?: string;
        headRefName?: string;
        baseRefName?: string;
        state?: string;
        mergedAt?: string | null;
      }>(s);
      if (!p || typeof p.number !== 'number' || typeof p.url !== 'string') return null;
      return {
        number: p.number,
        url: p.url,
        headRefName: p.headRefName ?? '',
        baseRefName: p.baseRefName ?? '',
        state: p.state ?? '',
        mergedAt: p.mergedAt ?? null,
      };
    },
    createArgs: (i) => [
      'pr',
      'create',
      '--head',
      i.branch,
      '--base',
      i.baseRef,
      '--title',
      i.title,
      '--body',
      i.body,
    ],
    createUrlPattern: /\/pull\/(\d+)/,
    issueArgs: (i, withLabels) => [
      'issue',
      'create',
      '--title',
      i.title,
      '--body',
      i.body,
      ...labelFlags(i.labels, withLabels),
    ],
    issueUrlPattern: /\/issues\/(\d+)/,
    listArgs: ['pr', 'list', '--state', 'open', '--limit', '50', '--json', GH_LIST],
    parseList: (s) => {
      const rows = safeParse<Parameters<typeof mapGh>[0][]>(s);
      return rows ? rows.map(mapGh).filter((r): r is PullRequest => r !== null) : null;
    },
    mergeArgs: (n, method) => ['pr', 'merge', String(n), `--${method}`],
  };
}

function gitlab(): ForgeProvider {
  return {
    kind: 'gitlab',
    cli: 'glab',
    defaultBin: 'glab',
    envExtras: {},
    tokenEnvName: gitlabTokenEnvName,
    notInstalled: 'GitLab CLI (glab) is not installed or not on PATH',
    notSignedIn: 'glab is not signed in — run `glab auth login` in a terminal, or set GITLAB_TOKEN',
    resolveFailed: 'glab could not resolve this repo on GitLab',
    noun: 'merge request',
    hash: '!',
    repoViewArgs: ['repo', 'view', '-F', 'json'],
    parseRepoName: (s) => safeParse<{ path_with_namespace?: string }>(s)?.path_with_namespace,
    viewArgs: (ref) => ['mr', 'view', ref, '-F', 'json'],
    parseView: (s) => {
      const p = safeParse<{
        iid?: number;
        number?: number;
        web_url?: string;
        url?: string;
        source_branch?: string;
        target_branch?: string;
        state?: string;
        merged_at?: string | null;
      }>(s);
      if (!p) return null;
      const number = p.iid ?? p.number;
      const url = p.web_url ?? p.url;
      if (typeof number !== 'number' || typeof url !== 'string') return null;
      return {
        number,
        url,
        headRefName: p.source_branch ?? '',
        baseRefName: p.target_branch ?? '',
        state: p.state ?? '',
        mergedAt: p.merged_at ?? null,
      };
    },
    createArgs: (i) => [
      'mr',
      'create',
      '--source-branch',
      i.branch,
      '--target-branch',
      i.baseRef,
      '--title',
      i.title,
      '--description',
      i.body,
      '--yes',
      '--no-editor',
    ],
    createUrlPattern: /\/merge_requests\/(\d+)/,
    issueArgs: (i, withLabels) => [
      'issue',
      'create',
      '--title',
      i.title,
      '--description',
      i.body,
      '--yes',
      '--no-editor',
      ...labelFlags(i.labels, withLabels),
    ],
    issueUrlPattern: /\/issues\/(\d+)/,
    listArgs: ['mr', 'list', '--state', 'opened', '--per-page', '50', '-F', 'json'],
    parseList: (s) => {
      const rows = safeParse<Parameters<typeof mapGl>[0][]>(s);
      return rows ? rows.map(mapGl).filter((r): r is PullRequest => r !== null) : null;
    },
    mergeArgs: (n, method) => [
      'mr',
      'merge',
      String(n),
      '--yes',
      '--auto-merge=false',
      ...(method === 'squash' ? ['--squash'] : []),
    ],
  };
}

const PROVIDERS: Record<ForgeKind, () => ForgeProvider> = { github, gitlab };
export function providerFor(kind: ForgeKind): ForgeProvider {
  return PROVIDERS[kind]();
}

function binOf(p: ForgeProvider, opts: ForgeBinOptions): string {
  return opts.bin ?? p.defaultBin;
}
function run(p: ForgeProvider, bin: string, cwd: string, args: string[], timeoutMs?: number) {
  return runCli(bin, cwd, args, { timeoutMs, envExtras: p.envExtras });
}

async function usable(p: ForgeProvider, bin: string, cwd: string): Promise<string | null> {
  if (!(await run(p, bin, cwd, ['--version'], 10_000)).ok) return p.notInstalled;
  const auth = await run(p, bin, cwd, ['auth', 'status'], 15_000);
  return cliAuthSatisfied(auth.ok, p.tokenEnvName()) ? null : p.notSignedIn;
}

export async function forgeStatus(
  kind: ForgeKind,
  repo: string,
  opts: ForgeBinOptions = {},
): Promise<GhStatus> {
  const p = providerFor(kind);
  const bin = binOf(p, opts);
  const unusable = await usable(p, bin, repo);
  if (unusable) return { available: false, detail: unusable, cli: p.cli };
  const view = await run(p, bin, repo, p.repoViewArgs, 30_000);
  if (!view.ok) return { available: false, detail: firstLine(view) || p.resolveFailed, cli: p.cli };
  const name = p.parseRepoName(view.stdout);
  return {
    available: true,
    detail: name ? `${p.cli} is signed in; repo resolves to ${name}` : `${p.cli} is signed in`,
    repo: name,
    cli: p.cli,
  };
}

export async function forgeView(
  kind: ForgeKind,
  repo: string,
  ref: string | number,
  opts: ForgeBinOptions = {},
): Promise<PrRef | null> {
  const p = providerFor(kind);
  const result = await run(p, binOf(p, opts), repo, p.viewArgs(String(ref)), 30_000);
  if (!result.ok) return null;
  const parsed = p.parseView(result.stdout);
  return parsed
    ? {
        number: parsed.number,
        url: parsed.url,
        headRefName: parsed.headRefName,
        baseRefName: parsed.baseRefName,
      }
    : null;
}

export async function forgeViewMergeState(
  kind: ForgeKind,
  repo: string,
  ref: string | number,
  opts: ForgeBinOptions = {},
): Promise<PrMergeState | null> {
  const p = providerFor(kind);
  const result = await run(p, binOf(p, opts), repo, p.viewArgs(String(ref)), 30_000);
  if (!result.ok) return null;
  const parsed = p.parseView(result.stdout);
  if (!parsed) return null;
  const merged =
    parsed.state.toUpperCase() === 'MERGED' ||
    parsed.state.toLowerCase() === 'merged' ||
    Boolean(parsed.mergedAt);
  const openDefault = kind === 'gitlab' ? 'opened' : 'OPEN';
  const mergedDefault = kind === 'gitlab' ? 'merged' : 'MERGED';
  return {
    number: parsed.number,
    url: parsed.url,
    headRefName: parsed.headRefName,
    baseRefName: parsed.baseRefName,
    merged,
    state: parsed.state || (merged ? mergedDefault : openDefault),
  };
}

export async function forgeOpen(
  kind: ForgeKind,
  repo: string,
  input: OpenInput,
  opts: ForgeBinOptions = {},
): Promise<PrAction> {
  const p = providerFor(kind);
  const bin = binOf(p, opts);
  const remote = await preferredRemote(repo);
  if (!remote) return { ok: false, detail: 'this repo has no git remote to push to' };
  const pushed = await pushBranch(repo, remote, input.branch);
  if (!pushed.ok) {
    return {
      ok: false,
      detail: pushed.stdout.trim() || `could not push ${input.branch} to ${remote}`,
    };
  }
  const created = await run(p, bin, repo, p.createArgs(input));
  if (!created.ok) {
    const existing = await forgeView(kind, repo, input.branch, opts);
    if (existing) {
      return {
        ok: true,
        detail: `a ${p.noun} for ${input.branch} already exists: ${existing.url}`,
        number: existing.number,
        url: existing.url,
      };
    }
    return { ok: false, detail: firstLine(created) || `${p.cli} ${p.noun} create failed` };
  }
  const url = createdUrl(created.stdout);
  return {
    ok: true,
    detail: url ? `opened ${url}` : created.stdout.trim() || `${p.noun} opened`,
    number: numberFromUrl(url, p.createUrlPattern),
    url,
  };
}

export async function forgeCreateIssue(
  kind: ForgeKind,
  repo: string,
  input: IssueInput,
  opts: ForgeBinOptions = {},
): Promise<IssueAction> {
  const p = providerFor(kind);
  const bin = binOf(p, opts);
  const labels = (input.labels ?? []).map((l) => l.trim()).filter(Boolean);
  let created: CliResult = await run(p, bin, repo, p.issueArgs({ ...input, labels }, true));
  let note = '';
  if (!created.ok && labels.length) {
    const retried = await run(p, bin, repo, p.issueArgs({ ...input, labels }, false));
    if (retried.ok) {
      note = ` (labels ${labels.join(', ')} were not applied: ${firstLine(created)})`;
      created = retried;
    }
  }
  if (!created.ok)
    return { ok: false, detail: firstLine(created) || `${p.cli} issue create failed` };
  const url = createdUrl(created.stdout);
  const number = numberFromUrl(url, p.issueUrlPattern);
  if (!url || number === undefined) {
    return {
      ok: false,
      detail: `${p.cli} issue create did not report an issue URL: ${created.stdout.trim() || 'empty output'}`,
    };
  }
  return { ok: true, detail: `filed ${url}${note}`, number, url };
}

export async function forgeList(
  kind: ForgeKind,
  repo: string,
  opts: ForgeBinOptions = {},
): Promise<PrList> {
  const p = providerFor(kind);
  const r = await run(p, binOf(p, opts), repo, p.listArgs, 60_000);
  if (!r.ok) return { ok: false, detail: firstLine(r) || `${p.cli} list failed`, prs: [] };
  const prs = p.parseList(r.stdout);
  if (!prs) return { ok: false, detail: `could not parse ${p.cli} list output`, prs: [] };
  return { ok: true, detail: `${prs.length} open`, prs };
}

export async function forgeMerge(
  kind: ForgeKind,
  repo: string,
  number: number,
  method: PrMergeMethod,
  opts: ForgeBinOptions = {},
): Promise<MergeOutcome> {
  const p = providerFor(kind);
  const pr = await forgeView(kind, repo, number, opts);
  const merged = await run(p, binOf(p, opts), repo, p.mergeArgs(number, method));
  return {
    ok: merged.ok,
    detail: merged.ok
      ? `merged ${p.hash}${number} (${method})`
      : firstLine(merged) || `${p.cli} merge failed`,
    headRefName: pr?.headRefName,
    baseRefName: pr?.baseRefName,
    url: pr?.url,
  };
}
