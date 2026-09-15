/**
 * GitHub's `gh` CLI as a typed surface for GitHub-only flows (account probe,
 * repo create) plus thin wrappers over the shared forge-ops PR/issue path.
 * Foundry never talks to the GitHub API itself: gh owns auth, remotes, and
 * pagination — `gh auth login` or a token env var (`GH_TOKEN` / `GITHUB_TOKEN`,
 * and the enterprise pair).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { GithubAccount, PrMergeMethod } from '@shared/types.js';
import type { NewRepoInput, NewRepoResult } from '@shared/ipc-contract.js';
import {
  forgeCreateIssue,
  forgeList,
  forgeMerge,
  forgeOpen,
  forgeStatus,
  forgeView,
  forgeViewMergeState,
  summarizeChecks,
  type ForgeBinOptions,
  type MergeOutcome,
  type PrMergeState,
  type PrRef,
} from './forge-ops.js';
import { firstLine, runCli, safeParse } from './scm-cli.js';
import { cliAuthSatisfied, githubTokenEnvName } from './scm-auth.js';

/** Test seam: the fake gh script stands in for the real binary. */
export type GhOptions = ForgeBinOptions;

export type { PrMergeState, MergeOutcome };
/** @deprecated Prefer MergeOutcome — kept for existing imports. */
export type MergePrOutcome = MergeOutcome;
export { summarizeChecks };

const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' };

async function ghUsable(bin: string, cwd: string): Promise<string | null> {
  const version = await runCli(bin, cwd, ['--version'], { timeoutMs: 10_000, envExtras: GH_ENV });
  if (!version.ok) return 'GitHub CLI (gh) is not installed or not on PATH';
  const auth = await runCli(bin, cwd, ['auth', 'status'], { timeoutMs: 15_000, envExtras: GH_ENV });
  if (cliAuthSatisfied(auth.ok, githubTokenEnvName())) return null;
  return 'gh is not signed in — run `gh auth login` in a terminal, or set GH_TOKEN / GITHUB_TOKEN';
}

export async function ghStatus(repo: string, opts: GhOptions = {}) {
  return forgeStatus('github', repo, opts);
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
  const user = await runCli(bin, cwd, ['api', 'user'], { timeoutMs: 30_000, envExtras: GH_ENV });
  const login = safeParse<{ login?: string }>(user.stdout)?.login;
  if (!user.ok || !login) {
    return {
      available: false,
      detail: firstLine(user) || 'gh is signed in but could not read your account',
    };
  }

  const orgsResult = await runCli(bin, cwd, ['api', 'user/orgs', '--paginate'], {
    timeoutMs: 30_000,
    envExtras: GH_ENV,
  });
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

  const created = await runCli(bin, parentDir, argv, { timeoutMs: 180_000, envExtras: GH_ENV });
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

export async function viewPr(
  repo: string,
  ref: string | number,
  opts: GhOptions = {},
): Promise<PrRef | null> {
  return forgeView('github', repo, ref, opts);
}

export async function viewPrMergeState(
  repo: string,
  ref: string | number,
  opts: GhOptions = {},
): Promise<PrMergeState | null> {
  return forgeViewMergeState('github', repo, ref, opts);
}

export async function openPr(
  repo: string,
  input: { branch: string; baseRef: string; title: string; body: string },
  opts: GhOptions = {},
) {
  return forgeOpen('github', repo, input, opts);
}

export async function createIssue(
  repo: string,
  input: { title: string; body: string; labels?: string[] },
  opts: GhOptions = {},
) {
  return forgeCreateIssue('github', repo, input, opts);
}

export async function listOpenPrs(repo: string, opts: GhOptions = {}) {
  return forgeList('github', repo, opts);
}

export async function mergePr(
  repo: string,
  prNumber: number,
  method: PrMergeMethod,
  opts: GhOptions = {},
): Promise<MergeOutcome> {
  return forgeMerge('github', repo, prNumber, method, opts);
}
