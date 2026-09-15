/**
 * Pick GitHub (`gh`) or GitLab (`glab`) from the repo remote, then expose the
 * same PR/MR operations both CLIs implement. Callers stay forge-agnostic;
 * create-on-GitHub flows keep using system/gh.ts directly.
 */

import type { GhStatus, PrMergeMethod } from '@shared/types.js';
import type { IssueAction, PrAction, PrList } from '@shared/ipc-contract.js';
import { preferredRemote, remoteUrl } from '../engine/git.js';
import * as ghLib from './gh.js';
import type { GhOptions } from './gh.js';
import * as glabLib from './glab.js';
import type { GlabOptions } from './glab.js';

export type ForgeKind = 'github' | 'gitlab';

export interface ForgeOptions {
  gh?: GhOptions;
  glab?: GlabOptions;
}

/**
 * Classify a git remote URL. Self-managed hosts with "gitlab" in the name map
 * to GitLab; github.com / ghe.com / github.* map to GitHub. Unknown hosts keep
 * today's default (GitHub) so existing projects are unchanged.
 */
export function classifyRemoteUrl(url: string): ForgeKind {
  const normalized = url.trim().toLowerCase();
  if (!normalized) return 'github';
  // SSH scp-like: git@gitlab.com:group/repo.git / git@github.com:owner/repo.git
  const host = (() => {
    const ssh = /^[^@]+@([^:]+):/.exec(normalized);
    if (ssh) return ssh[1]!;
    try {
      const withScheme = /:\/\//.test(normalized) ? normalized : `https://${normalized}`;
      return new URL(withScheme).hostname;
    } catch {
      return normalized;
    }
  })();

  if (
    host === 'github.com' ||
    host.endsWith('.github.com') ||
    host.endsWith('.ghe.com') ||
    host.startsWith('github.')
  ) {
    return 'github';
  }
  if (
    host === 'gitlab.com' ||
    host.endsWith('.gitlab.com') ||
    host.includes('gitlab') ||
    host === 'salsa.debian.org'
  ) {
    return 'gitlab';
  }
  return 'github';
}

export async function detectForge(repo: string): Promise<ForgeKind> {
  const remote = await preferredRemote(repo);
  if (!remote) return 'github';
  const url = await remoteUrl(repo, remote);
  return url ? classifyRemoteUrl(url) : 'github';
}

/** Tag GitHub status answers so the UI can tell which CLI answered. */
function withGhCli(status: GhStatus): GhStatus {
  return { ...status, cli: status.cli ?? 'gh' };
}

export async function scmStatus(repo: string, opts: ForgeOptions = {}): Promise<GhStatus> {
  const forge = await detectForge(repo);
  if (forge === 'gitlab') return glabLib.glabStatus(repo, opts.glab ?? {});
  return withGhCli(await ghLib.ghStatus(repo, opts.gh ?? {}));
}

export async function openPullRequest(
  repo: string,
  input: { branch: string; baseRef: string; title: string; body: string },
  opts: ForgeOptions = {},
): Promise<PrAction> {
  const forge = await detectForge(repo);
  if (forge === 'gitlab') return glabLib.openMr(repo, input, opts.glab ?? {});
  return ghLib.openPr(repo, input, opts.gh ?? {});
}

export async function viewPullRequest(
  repo: string,
  ref: string | number,
  opts: ForgeOptions = {},
): Promise<{ number: number; url: string; headRefName: string; baseRefName: string } | null> {
  const forge = await detectForge(repo);
  if (forge === 'gitlab') return glabLib.viewMr(repo, ref, opts.glab ?? {});
  return ghLib.viewPr(repo, ref, opts.gh ?? {});
}

export async function viewPullRequestMergeState(
  repo: string,
  ref: string | number,
  opts: ForgeOptions = {},
): Promise<{ number: number; url: string; merged: boolean; state: string } | null> {
  const forge = await detectForge(repo);
  if (forge === 'gitlab') return glabLib.viewMrMergeState(repo, ref, opts.glab ?? {});
  return ghLib.viewPrMergeState(repo, ref, opts.gh ?? {});
}

export async function listOpenPullRequests(repo: string, opts: ForgeOptions = {}): Promise<PrList> {
  const forge = await detectForge(repo);
  if (forge === 'gitlab') return glabLib.listOpenMrs(repo, opts.glab ?? {});
  return ghLib.listOpenPrs(repo, opts.gh ?? {});
}

export async function mergePullRequest(
  repo: string,
  number: number,
  method: PrMergeMethod,
  opts: ForgeOptions = {},
): Promise<{
  ok: boolean;
  detail: string;
  headRefName?: string;
  baseRefName?: string;
  url?: string;
}> {
  const forge = await detectForge(repo);
  if (forge === 'gitlab') return glabLib.mergeMr(repo, number, method, opts.glab ?? {});
  return ghLib.mergePr(repo, number, method, opts.gh ?? {});
}

export async function createForgeIssue(
  repo: string,
  input: { title: string; body: string; labels?: string[] },
  opts: ForgeOptions = {},
): Promise<IssueAction> {
  const forge = await detectForge(repo);
  if (forge === 'gitlab') return glabLib.createGitlabIssue(repo, input, opts.glab ?? {});
  return ghLib.createIssue(repo, input, opts.gh ?? {});
}
