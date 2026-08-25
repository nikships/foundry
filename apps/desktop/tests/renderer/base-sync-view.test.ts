import { describe, expect, it } from 'vitest';
import type { BaseSyncStatus } from '@shared/types.js';
import { baseSyncBanner, showBaseSyncOnRuns } from '@renderer/view-models/base-sync-view.js';

function status(over: Partial<BaseSyncStatus> = {}): BaseSyncStatus {
  return {
    projectId: 'p1',
    baseRef: 'main',
    remote: 'origin',
    localSha: 'a'.repeat(40),
    remoteSha: 'b'.repeat(40),
    ahead: 0,
    behind: 0,
    state: 'current',
    fetched: true,
    detail: 'main matches origin/main',
    ...over,
  };
}

describe('baseSyncBanner', () => {
  it('says the base is current and offers a re-check', () => {
    const banner = baseSyncBanner(status());
    expect(banner.tone).toBe('ready');
    expect(banner.message).toBe('main is up to date with origin/main.');
    expect(banner.action).toBe('Check again');
  });

  it('names the commit count and the update action when behind', () => {
    const banner = baseSyncBanner(status({ state: 'behind', behind: 3 }));
    expect(banner.tone).toBe('warn');
    expect(banner.message).toContain('3 commits behind origin/main');
    expect(banner.action).toBe('Update main');
  });

  it('singularizes one commit', () => {
    const banner = baseSyncBanner(status({ state: 'behind', behind: 1 }));
    expect(banner.message).toContain('1 commit behind');
    expect(banner.message).not.toContain('1 commits');
  });

  it('does not offer a rewrite when the histories diverged', () => {
    const banner = baseSyncBanner(status({ state: 'diverged', ahead: 1, behind: 2 }));
    expect(banner.tone).toBe('warn');
    expect(banner.message).toMatch(/diverged/);
    expect(banner.action).toBe('Check again');
  });

  it('hides the action while a check or update is in flight', () => {
    expect(
      baseSyncBanner(status({ state: 'behind', behind: 1 }), { busy: 'checking' }).action,
    ).toBe(null);
    expect(
      baseSyncBanner(status({ state: 'behind', behind: 1 }), { busy: 'syncing' }).message,
    ).toMatch(/Updating main/);
  });
});

describe('showBaseSyncOnRuns', () => {
  it('hides the verdicts that need nothing from the operator', () => {
    expect(showBaseSyncOnRuns(status({ state: 'current' }), null)).toBe(false);
    expect(showBaseSyncOnRuns(status({ state: 'ahead', ahead: 2 }), null)).toBe(false);
    expect(showBaseSyncOnRuns(status({ state: 'no_remote', remote: null }), null)).toBe(false);
  });

  it('hides the in-flight check and the state before the first answer', () => {
    expect(showBaseSyncOnRuns(null, 'checking')).toBe(false);
    expect(showBaseSyncOnRuns(null, null)).toBe(false);
    expect(showBaseSyncOnRuns(status({ state: 'current' }), 'checking')).toBe(false);
  });

  it('shows the verdicts that block or degrade a run', () => {
    expect(showBaseSyncOnRuns(status({ state: 'behind', behind: 1 }), null)).toBe(true);
    expect(showBaseSyncOnRuns(status({ state: 'diverged', ahead: 1, behind: 2 }), null)).toBe(true);
    expect(showBaseSyncOnRuns(status({ state: 'error' }), null)).toBe(true);
  });

  it('keeps an operator-started update visible while it runs', () => {
    expect(showBaseSyncOnRuns(status({ state: 'behind', behind: 1 }), 'syncing')).toBe(true);
    expect(showBaseSyncOnRuns(status({ state: 'current' }), 'syncing')).toBe(true);
  });
});
