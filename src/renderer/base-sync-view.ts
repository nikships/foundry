/**
 * Copy for the base-ref sync bar. The bar and Settings share this so they
 * cannot disagree about what "behind" means.
 */

import type { BaseSyncStatus } from '@shared/types.js';

export type BaseSyncBusy = 'checking' | 'syncing';

export interface BaseSyncBanner {
  tone: 'ready' | 'warn' | 'quiet';
  message: string;
  /** Update when behind; Check again otherwise. Null while busy or with no remote. */
  action: string | null;
}

function commits(n: number): string {
  return n === 1 ? '1 commit' : `${n} commits`;
}

function tracking(status: BaseSyncStatus): string {
  const name = status.baseRef.replace(/^refs\/heads\//, '');
  return status.remote ? `${status.remote}/${name}` : name;
}

export function baseSyncBanner(
  status: BaseSyncStatus | null,
  opts: { busy?: BaseSyncBusy | null } = {},
): BaseSyncBanner {
  const baseRef = status?.baseRef || 'main';
  if (opts.busy === 'checking') {
    return {
      tone: 'quiet',
      message: `Checking whether ${baseRef} is current with the remote…`,
      action: null,
    };
  }
  if (opts.busy === 'syncing') {
    return {
      tone: 'quiet',
      message: `Updating ${baseRef} from the remote…`,
      action: null,
    };
  }
  if (!status) {
    return { tone: 'quiet', message: 'Could not check the base branch.', action: 'Check again' };
  }

  const remoteName = tracking(status);
  switch (status.state) {
    case 'current':
      return {
        tone: 'ready',
        message: status.fetched
          ? `${status.baseRef} is up to date with ${remoteName}.`
          : `Last we saw, ${status.baseRef} matched ${remoteName} — could not reach ${status.remote}.`,
        action: 'Check again',
      };
    case 'behind':
      return {
        tone: 'warn',
        message: `${status.baseRef} is ${commits(status.behind)} behind ${remoteName}. New runs branch from here.`,
        action: `Update ${status.baseRef}`,
      };
    case 'ahead':
      return {
        tone: 'quiet',
        message: `Local ${status.baseRef} is ${commits(status.ahead)} ahead of ${remoteName}.`,
        action: 'Check again',
      };
    case 'diverged':
      return {
        tone: 'warn',
        message: `Local ${status.baseRef} and ${remoteName} have diverged (${commits(status.ahead)} ahead, ${commits(status.behind)} behind). Foundry only fast-forwards — update ${status.baseRef} in git first.`,
        action: 'Check again',
      };
    case 'no_remote':
      return {
        tone: 'quiet',
        message: `This repo has no remote. Runs branch from the local ${status.baseRef}.`,
        action: null,
      };
    case 'error':
      return {
        tone: 'warn',
        message: status.detail || `Could not compare ${status.baseRef} to the remote.`,
        action: 'Check again',
      };
  }
}

/** The Runs banner hides "no remote" — there is nothing to sync. */
export function showBaseSyncOnRuns(
  status: BaseSyncStatus | null,
  busy: BaseSyncBusy | null,
): boolean {
  if (busy) return true;
  if (!status) return true;
  return status.state !== 'no_remote';
}
