import { describe, expect, it } from 'vitest';
import {
  MERGEABILITY_RECHECK_MS,
  beginRecheck,
  expireRecheck,
  prConflictBadge,
  prFixButton,
  prMergeBlocked,
  prMergeHint,
  prRepairPhase,
  pruneRechecks,
} from '@renderer/view-models/pr-repair-view.js';

describe('prRepairPhase', () => {
  it('is repairing while the in-flight call holds the card', () => {
    expect(
      prRepairPhase({
        busy: true,
        mergeable: 'conflicting',
        recheckUntil: 50,
        now: 0,
      }),
    ).toBe('repairing');
  });

  it('stays rechecking after a successful repair while GitHub still says conflicting', () => {
    expect(
      prRepairPhase({
        busy: false,
        mergeable: 'conflicting',
        recheckUntil: 20_000,
        now: 1_000,
      }),
    ).toBe('rechecking');
  });

  it('re-arms once the window expires or GitHub reports a computed non-conflict', () => {
    expect(
      prRepairPhase({
        busy: false,
        mergeable: 'conflicting',
        recheckUntil: 20_000,
        now: 20_000,
      }),
    ).toBe('idle');
    expect(
      prRepairPhase({
        busy: false,
        mergeable: 'mergeable',
        recheckUntil: 20_000,
        now: 1_000,
      }),
    ).toBe('idle');
    expect(
      prRepairPhase({
        busy: false,
        mergeable: 'unknown',
        recheckUntil: 20_000,
        now: 1_000,
      }),
    ).toBe('idle');
  });
});

describe('recheck bookkeeping', () => {
  it('starts a window from now and drops it when GitHub is no longer conflicting', () => {
    const started = beginRecheck({}, 12, 1_000);
    expect(started[12]).toBe(1_000 + MERGEABILITY_RECHECK_MS);
    expect(pruneRechecks(started, [{ number: 12, mergeable: 'conflicting' }], 1_001)[12]).toBe(
      started[12],
    );
    expect(pruneRechecks(started, [{ number: 12, mergeable: 'mergeable' }], 1_001)).toEqual({});
    expect(pruneRechecks(started, [{ number: 12, mergeable: 'unknown' }], 1_001)).toEqual({});
  });

  it('drops expired windows and PRs that left the list', () => {
    const current = { 12: 5_000, 13: 8_000 };
    expect(pruneRechecks(current, [{ number: 12, mergeable: 'conflicting' }], 5_000)).toEqual({});
    expect(pruneRechecks(current, [{ number: 13, mergeable: 'conflicting' }], 1_000)).toEqual({
      13: 8_000,
    });
  });

  it('expireRecheck is a no-op when that PR is not held', () => {
    const current = { 12: 5_000 };
    expect(expireRecheck(current, 13)).toBe(current);
    expect(expireRecheck(current, 12)).toEqual({});
  });
});

describe('prFixButton', () => {
  it('is live only for a conflicting foundry PR that is not already repairing or rechecking', () => {
    expect(prFixButton({ hasFixAction: true, mergeable: 'conflicting', phase: 'idle' })).toEqual({
      disabled: false,
      label: 'Fix with agent',
      title: expect.stringContaining('rebases this branch'),
    });
    expect(
      prFixButton({ hasFixAction: true, mergeable: 'conflicting', phase: 'repairing' }),
    ).toMatchObject({ disabled: true, label: 'Repairing…' });
    expect(
      prFixButton({ hasFixAction: true, mergeable: 'conflicting', phase: 'rechecking' }),
    ).toEqual({
      disabled: true,
      label: 'Checking…',
      title: 'GitHub is recomputing mergeability after the last repair',
    });
    expect(prFixButton({ hasFixAction: false, mergeable: 'conflicting', phase: 'idle' })).toBe(
      null,
    );
    expect(prFixButton({ hasFixAction: true, mergeable: 'mergeable', phase: 'idle' })).toBe(null);
  });
});

describe('conflict badge and merge gating', () => {
  it('replaces the conflicts badge while mergeability is being recomputed', () => {
    expect(prConflictBadge('conflicting', 'idle')?.label).toBe('conflicts');
    expect(prConflictBadge('conflicting', 'rechecking')).toEqual({
      label: 'checking mergeability',
      color: 'var(--amber)',
    });
    expect(prConflictBadge('mergeable', 'idle')).toBe(null);
  });

  it('keeps Merge blocked through the recheck window', () => {
    expect(
      prMergeBlocked({
        busy: false,
        isDraft: false,
        mergeable: 'conflicting',
        phase: 'rechecking',
      }),
    ).toBe(true);
    expect(
      prMergeBlocked({ busy: false, isDraft: false, mergeable: 'mergeable', phase: 'idle' }),
    ).toBe(false);
    expect(
      prMergeHint({
        isDraft: false,
        mergeable: 'conflicting',
        phase: 'rechecking',
        number: 4,
        baseRefName: 'main',
      }),
    ).toMatch(/recomputing mergeability/);
    expect(
      prMergeHint({
        isDraft: true,
        mergeable: 'mergeable',
        phase: 'idle',
        number: 4,
        baseRefName: 'main',
      }),
    ).toMatch(/Draft/);
    expect(
      prMergeHint({
        isDraft: false,
        mergeable: 'conflicting',
        phase: 'idle',
        number: 4,
        baseRefName: 'main',
      }),
    ).toMatch(/merge conflicts/);
    expect(
      prMergeHint({
        isDraft: false,
        mergeable: 'mergeable',
        phase: 'idle',
        number: 4,
        baseRefName: 'main',
      }),
    ).toContain('Merge #4 into main');
    expect(
      prMergeBlocked({ busy: true, isDraft: false, mergeable: 'mergeable', phase: 'idle' }),
    ).toBe(true);
  });
});
