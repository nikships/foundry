import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollWhileVisible } from '@renderer/utils/visible-poll.js';

let page: EventTarget & { hidden: boolean };
let polls: ReturnType<typeof pollWhileVisible>[];

function visibility(hidden: boolean): void {
  page.hidden = hidden;
  page.dispatchEvent(new Event('visibilitychange'));
}

function start(
  read: (signal: AbortSignal) => void | Promise<void>,
  cadence: () => number | null = () => 500,
): ReturnType<typeof pollWhileVisible> {
  const poll = pollWhileVisible(read, cadence);
  polls.push(poll);
  return poll;
}

beforeEach(() => {
  vi.useFakeTimers();
  page = Object.assign(new EventTarget(), { hidden: false });
  polls = [];
  vi.stubGlobal('document', page);
  vi.stubGlobal('window', { setTimeout, clearTimeout });
});

afterEach(() => {
  for (const poll of polls) poll.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('visual polling lifecycle', () => {
  it('keeps visible cadence, cancels hidden work, and refreshes immediately on return', async () => {
    const read = vi.fn();
    const poll = start(read);
    await vi.advanceTimersByTimeAsync(499);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    visibility(true);
    await poll.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    visibility(false);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(read).toHaveBeenCalledTimes(4);
  });

  it('does not even initialize a hidden view until it becomes visible', async () => {
    visibility(true);
    const read = vi.fn();
    start(read);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).not.toHaveBeenCalled();
    visibility(false);
    expect(read).toHaveBeenCalledOnce();
  });

  it('coalesces refreshes during slow IPC into one follow-up, without overlapping reads', async () => {
    let finish!: () => void;
    const read = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const poll = start(read);
    const first = poll.refresh();
    const second = poll.refresh();
    await vi.advanceTimersByTimeAsync(2000);
    expect(read).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('rechecks after a hide/show during IPC, but never schedules while hidden', async () => {
    let finish!: () => void;
    const read = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          finish = r;
        }),
    );
    const poll = start(read);
    visibility(true);
    visibility(false);
    const pending = poll.refresh();
    expect(read).toHaveBeenCalledOnce();
    finish();
    await pending;
    expect(read).toHaveBeenCalledTimes(2);
    visibility(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts stale results on disposal without poisoning a replacement poller', async () => {
    let finish!: () => void;
    let applied = 0;
    const old = start(async (signal) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      if (!signal.aborted) applied++;
    });
    const pending = old.refresh();
    old.stop();
    const replacement = vi.fn();
    start(replacement);
    finish();
    await pending;
    expect(applied).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(replacement).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('takes the next cadence from the completed read, and permits terminal refreshes', async () => {
    let ms: number | null = 500;
    const read = vi.fn(() => {
      ms = null;
    });
    const poll = start(read, () => ms);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await poll.refresh();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
