/**
 * Pick GitHub (`gh`) or GitLab (`glab`) from the repo remote, then run the
 * shared forge-ops surface. Callers stay forge-agnostic; create-on-GitHub
 * flows keep using system/gh.ts directly.
 */

import type { GhStatus, PrMergeMethod } from '@shared/types.js';
import type { IssueAction, PrAction, PrList } from '@shared/ipc-contract.js';
import { preferredRemote, remoteUrl } from '../engine/git.js';
import {
  forgeCreateIssue,
  forgeList,
  forgeMerge,
  forgeOpen,
  forgeStatus,
  forgeView,
  forgeViewMergeState,
  type ForgeBinOptions,
  type ForgeKind,
  type MergeOutcome,
  type PrMergeState,
  type PrRef,
} from './forge-ops.js';

export type { ForgeKind, ForgeBinOptions, PrRef, PrMergeState, MergeOutcome };
export { summarizeChecks } from './forge-ops.js';

export interface ForgeOptions {
  gh?: ForgeBinOptions;
  glab?: ForgeBinOptions;
}

/**
 * Classify a git remote URL. Self-managed hosts with "gitlab" in the name map
 * to GitLab; github.com / ghe.com / github.* map to GitHub. Unknown hosts keep
 * today's default (GitHub) so existing projects are unchanged.
 */
export function classifyRemoteUrl(url: string): ForgeKind {
  const normalized = url.trim().toLowerCase();
  if (!normalized) return 'github';
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

function bins(kind: ForgeKind, opts: ForgeOptions): ForgeBinOptions {
  return kind === 'gitlab' ? (opts.glab ?? {}) : (opts.gh ?? {});
}

export async function scmStatus(repo: string, opts: ForgeOptions = {}): Promise<GhStatus> {
  const kind = await detectForge(repo);
  return forgeStatus(kind, repo, bins(kind, opts));
}

export async function openPullRequest(
  repo: string,
  input: { branch: string; baseRef: string; title: string; body: string },
  opts: ForgeOptions = {},
): Promise<PrAction> {
  const kind = await detectForge(repo);
  return forgeOpen(kind, repo, input, bins(kind, opts));
}

export async function viewPullRequest(
  repo: string,
  ref: string | number,
  opts: ForgeOptions = {},
): Promise<PrRef | null> {
  const kind = await detectForge(repo);
  return forgeView(kind, repo, ref, bins(kind, opts));
}

export async function viewPullRequestMergeState(
  repo: string,
  ref: string | number,
  opts: ForgeOptions = {},
): Promise<PrMergeState | null> {
  const kind = await detectForge(repo);
  return forgeViewMergeState(kind, repo, ref, bins(kind, opts));
}

export async function listOpenPullRequests(repo: string, opts: ForgeOptions = {}): Promise<PrList> {
  const kind = await detectForge(repo);
  return forgeList(kind, repo, bins(kind, opts));
}

export async function mergePullRequest(
  repo: string,
  number: number,
  method: PrMergeMethod,
  opts: ForgeOptions = {},
): Promise<MergeOutcome> {
  const kind = await detectForge(repo);
  return forgeMerge(kind, repo, number, method, bins(kind, opts));
}

export async function createForgeIssue(
  repo: string,
  input: { title: string; body: string; labels?: string[] },
  opts: ForgeOptions = {},
): Promise<IssueAction> {
  const kind = await detectForge(repo);
  return forgeCreateIssue(kind, repo, input, bins(kind, opts));
}
