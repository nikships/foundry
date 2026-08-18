/**
 * Compare the project's local base ref to the preferred remote, and
 * fast-forward it when the operator asks.
 *
 * Inspect updates the remote-tracking ref only. Sync reuses `fastForwardBase`,
 * so it never creates a merge commit and never moves the operator off their
 * branch. A diverged base is reported, not rewritten.
 */

import type { BaseSyncState, BaseSyncStatus } from '@shared/types.js';
import {
  aheadBehind,
  fastForwardBase,
  fetchTrackingRef,
  preferredRemote,
  resolveRef,
} from './git.js';

type BaseSyncSnapshot = Omit<BaseSyncStatus, 'projectId'>;

function branchName(baseRef: string): string {
  return baseRef.replace(/^refs\/heads\//, '');
}

function snapshot(
  over: Partial<BaseSyncSnapshot> & Pick<BaseSyncSnapshot, 'baseRef'>,
): BaseSyncSnapshot {
  return {
    remote: null,
    localSha: null,
    remoteSha: null,
    ahead: 0,
    behind: 0,
    state: 'error',
    fetched: false,
    detail: '',
    ...over,
  };
}

function classify(
  baseRef: string,
  remote: string,
  localSha: string,
  remoteSha: string,
  ahead: number,
  behind: number,
  fetched: boolean,
): BaseSyncSnapshot {
  const tracking = `${remote}/${branchName(baseRef)}`;
  let state: BaseSyncState;
  let detail: string;
  if (ahead === 0 && behind === 0) {
    state = 'current';
    detail = `${baseRef} matches ${tracking}`;
  } else if (ahead > 0 && behind > 0) {
    state = 'diverged';
    detail = `local ${baseRef} and ${tracking} have diverged`;
  } else if (behind > 0) {
    state = 'behind';
    detail = `${baseRef} is ${behind} commit${behind === 1 ? '' : 's'} behind ${tracking}`;
  } else {
    state = 'ahead';
    detail = `local ${baseRef} is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of ${tracking}`;
  }
  return snapshot({
    baseRef,
    remote,
    localSha,
    remoteSha,
    ahead,
    behind,
    state,
    fetched,
    detail: fetched ? detail : `could not reach ${remote}; compared to last fetched ${tracking}`,
  });
}

export async function inspectBase(repo: string, baseRef: string): Promise<BaseSyncSnapshot> {
  const ref = baseRef.trim() || 'main';
  const remote = await preferredRemote(repo);
  if (!remote) {
    return snapshot({
      baseRef: ref,
      state: 'no_remote',
      detail: 'this repo has no git remote',
    });
  }

  const fetched = await fetchTrackingRef(repo, remote, ref);
  const localSha = (await resolveRef(repo, ref)) || null;
  const tracking = `${remote}/${branchName(ref)}`;
  const remoteSha = (await resolveRef(repo, tracking)) || null;

  if (!localSha) {
    return snapshot({
      baseRef: ref,
      remote,
      remoteSha,
      fetched: fetched.ok,
      detail: `${ref} does not resolve locally`,
    });
  }
  if (!remoteSha) {
    return snapshot({
      baseRef: ref,
      remote,
      localSha,
      fetched: fetched.ok,
      detail: fetched.ok
        ? `${tracking} does not resolve`
        : fetched.stdout.trim() || `could not fetch ${ref} from ${remote}`,
    });
  }

  if (localSha === remoteSha) {
    return classify(ref, remote, localSha, remoteSha, 0, 0, fetched.ok);
  }
  const counts = await aheadBehind(repo, localSha, remoteSha);
  if (!counts) {
    return snapshot({
      baseRef: ref,
      remote,
      localSha,
      remoteSha,
      fetched: fetched.ok,
      detail: `could not compare ${ref} to ${tracking}`,
    });
  }
  return classify(ref, remote, localSha, remoteSha, counts.ahead, counts.behind, fetched.ok);
}

export async function syncBase(
  repo: string,
  baseRef: string,
): Promise<{ ok: boolean; status: BaseSyncSnapshot }> {
  const before = await inspectBase(repo, baseRef);
  if (before.state === 'no_remote' || before.state === 'error') {
    return { ok: false, status: before };
  }
  if (before.state === 'current' || before.state === 'ahead') {
    return { ok: true, status: before };
  }
  if (before.state === 'diverged' || !before.remote) {
    return {
      ok: false,
      status: {
        ...before,
        detail: `${before.detail} — Foundry only fast-forwards`,
      },
    };
  }

  const ff = await fastForwardBase(repo, before.remote, before.baseRef);
  const after = await inspectBase(repo, before.baseRef);
  if (!ff.ok) {
    return {
      ok: false,
      status: {
        ...after,
        detail: ff.stdout.trim() || `could not fast-forward ${before.baseRef}`,
      },
    };
  }
  return { ok: after.state === 'current', status: after };
}
