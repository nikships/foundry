/**
 * Create-project forge surface: probe the signed-in account and create a repo
 * on GitHub (`gh`) or GitLab (`glab`) according to Settings → forgeProvider.
 *
 * Auto resolves to GitHub for create only (there is no git remote yet to
 * classify). Existing-project PR/MR flows keep using resolveForge() in forge.ts.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ForgeAccount } from '@shared/types.js';
import type { NewRepoInput, NewRepoResult } from '@shared/ipc-contract.js';
import {
  DEFAULT_FORGE_PROVIDER,
  isForgeProviderPreference,
  type ForgeProviderPreference,
} from '@shared/forge-cli.js';
import { forgePreference } from './forge.js';
import { createRepo, githubAccount, repoNameIssue } from './gh.js';
import type { ForgeBinOptions, ForgeKind } from './forge-ops.js';
import { firstLine, runCli, safeParse } from './scm-cli.js';
import { cliAuthSatisfied, gitlabTokenEnvName } from './scm-auth.js';

export type { ForgeKind, ForgeBinOptions };
export { repoNameIssue };

export interface ForgeCreateOptions {
  gh?: ForgeBinOptions;
  glab?: ForgeBinOptions;
  /** Override the app-level Settings preference for this call. */
  preference?: ForgeProviderPreference;
}

/**
 * Create has no git remote yet, so Auto cannot classify — it defaults to GitHub.
 * Explicit github / gitlab preferences win.
 */
export function resolveCreateForge(
  preference: ForgeProviderPreference = DEFAULT_FORGE_PROVIDER,
): ForgeKind {
  if (preference === 'gitlab') return 'gitlab';
  return 'github';
}

function preferenceOf(opts: ForgeCreateOptions): ForgeProviderPreference {
  if (isForgeProviderPreference(opts.preference)) return opts.preference;
  return forgePreference();
}

function gitlabHost(): string {
  const host = process.env.GITLAB_HOST?.trim() || process.env.GL_HOST?.trim();
  if (!host) return 'gitlab.com';
  return host.replace(/^https?:\/\//, '').replace(/\/$/, '') || 'gitlab.com';
}

async function glabUsable(bin: string, cwd: string): Promise<string | null> {
  const version = await runCli(bin, cwd, ['--version'], { timeoutMs: 10_000 });
  if (!version.ok) return 'GitLab CLI (glab) is not installed or not on PATH';
  const auth = await runCli(bin, cwd, ['auth', 'status'], { timeoutMs: 15_000 });
  if (cliAuthSatisfied(auth.ok, gitlabTokenEnvName())) return null;
  return 'glab is not signed in — run `glab auth login` in a terminal, or set GITLAB_TOKEN';
}

/**
 * Who glab is signed in as, without a repo checkout. Groups the user can create
 * projects in are best-effort: a token without group scope still creates under
 * the personal namespace.
 */
export async function gitlabAccount(opts: ForgeBinOptions = {}): Promise<ForgeAccount> {
  const bin = opts.bin ?? 'glab';
  const cwd = homedir();
  const host = gitlabHost();
  const unusable = await glabUsable(bin, cwd);
  if (unusable) {
    return { available: false, detail: unusable, provider: 'gitlab', host };
  }

  const user = await runCli(bin, cwd, ['api', 'user'], { timeoutMs: 30_000 });
  const parsed = safeParse<{ username?: string; login?: string }>(user.stdout);
  const login = parsed?.username ?? parsed?.login;
  if (!user.ok || !login) {
    return {
      available: false,
      detail: firstLine(user) || 'glab is signed in but could not read your account',
      provider: 'gitlab',
      host,
    };
  }

  // Developer (30) can create projects in a group; failure degrades to login-only.
  const groupsResult = await runCli(
    bin,
    cwd,
    ['api', 'groups?membership=true&min_access_level=30&per_page=100'],
    { timeoutMs: 30_000 },
  );
  const groups = groupsResult.ok
    ? (safeParse<{ full_path?: string; path?: string }[]>(groupsResult.stdout) ?? [])
        .map((g) => g?.full_path || g?.path)
        .filter((name): name is string => !!name && name !== login)
    : [];

  return {
    available: true,
    detail: `signed in as ${login}`,
    login,
    owners: [login, ...groups],
    provider: 'gitlab',
    host,
  };
}

/**
 * Create on GitLab, then clone. `--readme` is load-bearing: it initializes a
 * README and clones so the working tree has a commit/HEAD Foundry can branch
 * from (same requirement as gh's `--add-readme --clone`).
 */
export async function createGitlabRepo(
  input: NewRepoInput,
  opts: ForgeBinOptions = {},
): Promise<NewRepoResult> {
  const bin = opts.bin ?? 'glab';
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
  const visibilityFlag = input.visibility === 'public' ? '--public' : '--private';
  const argv = [
    'repo',
    'create',
    target,
    visibilityFlag,
    '--readme',
    ...(input.description?.trim() ? ['--description', input.description.trim()] : []),
  ];

  const created = await runCli(bin, parentDir, argv, { timeoutMs: 180_000 });
  if (!created.ok) {
    return { ok: false, detail: firstLine(created) || 'glab repo create failed' };
  }
  if (!existsSync(path)) {
    return {
      ok: false,
      detail: `glab created ${target} but no clone landed at ${path}`,
      nameWithOwner: target,
    };
  }

  const host = gitlabHost();
  const url =
    `${created.stdout}\n${created.stderr}`
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /^https?:\/\//.test(line)) ?? `https://${host}/${target}`;

  return { ok: true, detail: `created ${target}`, url, nameWithOwner: target, path };
}

async function githubAccountTagged(opts: ForgeBinOptions = {}): Promise<ForgeAccount> {
  const account = await githubAccount(opts);
  return {
    ...account,
    provider: 'github',
    host: 'github.com',
  };
}

/** Probe the forge account for the resolved create provider. */
export async function forgeAccount(opts: ForgeCreateOptions = {}): Promise<ForgeAccount> {
  const kind = resolveCreateForge(preferenceOf(opts));
  if (kind === 'gitlab') return gitlabAccount(opts.glab ?? {});
  return githubAccountTagged(opts.gh ?? {});
}

/** Create a repository on the resolved create provider and clone it. */
export async function createForgeRepo(
  input: NewRepoInput,
  opts: ForgeCreateOptions = {},
): Promise<NewRepoResult> {
  const kind = resolveCreateForge(preferenceOf(opts));
  if (kind === 'gitlab') return createGitlabRepo(input, opts.glab ?? {});
  return createRepo(input, opts.gh ?? {});
}
