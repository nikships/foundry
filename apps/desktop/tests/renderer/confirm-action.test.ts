import { describe, expect, it } from 'vitest';
import { confirmManager } from '../../src/renderer/hooks/useConfirmAction.js';

describe('confirmManager', () => {
  it('notifies subscribers and resolves confirmation true/false', async () => {
    let notified: unknown = null;
    const unsub = confirmManager.subscribe((req) => {
      notified = req;
    });

    const promise = confirmManager.ask('Delete item?');
    expect(notified).not.toBeNull();
    expect((notified as { message: string }).message).toBe('Delete item?');

    confirmManager.resolve((notified as { id: string }).id, true);
    const result = await promise;
    expect(result).toBe(true);
    unsub();
  });

  it('queues concurrent confirmation requests sequentially without dropping', async () => {
    const events: (string | null)[] = [];
    const unsub = confirmManager.subscribe((req) => {
      events.push(req ? req.message : null);
    });

    const promise1 = confirmManager.ask('First request');
    const promise2 = confirmManager.ask('Second request');

    expect(events[events.length - 1]).toBe('First request');

    // Resolve first request
    let currentReq: { id: string } | null = null;
    const sub2 = confirmManager.subscribe((r) => {
      currentReq = r;
    });

    confirmManager.resolve(currentReq!.id, false);
    const result1 = await promise1;
    expect(result1).toBe(false);

    // Second request is now active
    expect(events[events.length - 1]).toBe('Second request');
    confirmManager.resolve(currentReq!.id, true);
    const result2 = await promise2;
    expect(result2).toBe(true);

    sub2();
    unsub();
  });

  it('carries custom options to subscribers', async () => {
    let currentOpts: unknown = null;
    const unsub = confirmManager.subscribe((req) => {
      currentOpts = req?.opts;
    });

    const promise = confirmManager.ask('Discard worktree?', {
      title: 'Discard Worktree',
      confirmLabel: 'Discard',
      variant: 'danger',
    });

    expect(currentOpts).toEqual({
      title: 'Discard Worktree',
      confirmLabel: 'Discard',
      variant: 'danger',
    });

    let currentReq: { id: string } | null = null;
    const sub2 = confirmManager.subscribe((r) => {
      currentReq = r;
    });
    confirmManager.resolve(currentReq!.id, true);
    await promise;

    sub2();
    unsub();
  });
});
