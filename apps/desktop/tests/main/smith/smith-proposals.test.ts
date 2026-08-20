/**
 * The Smith proposal queue: one pending at a time, a blocking promise the CLI
 * awaits, and a save handler that runs before an approve resolves. These pin the
 * lifecycle — propose/approve/reject, concurrent rejection, and the
 * save-refused-keeps-pending rule.
 */

import { describe, expect, it, vi } from 'vitest';
import { ProposalQueue, type ProposalInput } from '../../../src/main/smith/proposals.js';

const input = (over: Partial<ProposalInput> = {}): ProposalInput => ({
  kind: 'agent',
  mode: 'create',
  name: 'planner',
  spec: { name: 'planner' },
  validation: [],
  overwrites: false,
  projectId: 'p1',
  ...over,
});

describe('ProposalQueue', () => {
  it('exposes exactly the one pending proposal as a list', async () => {
    const onChanged = vi.fn();
    const queue = new ProposalQueue(onChanged, async () => ({ ok: true, entity: {} }));

    expect(queue.list()).toEqual([]);
    const pending = queue.propose(input());
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]!.name).toBe('planner');
    expect(onChanged).toHaveBeenCalledTimes(1);

    // Settle so the awaited promise does not dangle.
    const id = queue.list()[0]!.id;
    await queue.answer(id, { approved: false });
    await pending;
  });

  it('resolves the blocking promise with the saved entity on approve', async () => {
    const saved = { name: 'planner', model: 'inherit' };
    const save = vi.fn(async () => ({ ok: true as const, entity: saved }));
    const queue = new ProposalQueue(() => {}, save);

    const pending = queue.propose(input());
    const id = queue.list()[0]!.id;
    const ok = await queue.answer(id, { approved: true });

    expect(ok).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toEqual({ approved: true, entity: saved });
    expect(queue.list()).toEqual([]);
  });

  it('carries the reject note back to the waiting CLI without saving', async () => {
    const save = vi.fn(async () => ({ ok: true as const, entity: {} }));
    const queue = new ProposalQueue(() => {}, save);

    const pending = queue.propose(input());
    const id = queue.list()[0]!.id;
    const ok = await queue.answer(id, { approved: false, note: 'use kebab-case' });

    expect(ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual({ approved: false, note: 'use kebab-case' });
    expect(queue.list()).toEqual([]);
  });

  it('fails a concurrent proposal fast rather than stacking a queue', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );

    const first = queue.propose(input({ name: 'a' }));
    await expect(queue.propose(input({ name: 'b' }))).rejects.toThrow('proposal_pending');
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]!.name).toBe('a');

    await queue.answer(queue.list()[0]!.id, { approved: false });
    await first;
  });

  it('keeps the proposal pending when the save is refused', async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: 'name taken' }));
    const queue = new ProposalQueue(() => {}, save);

    queue.propose(input());
    const id = queue.list()[0]!.id;
    const ok = await queue.answer(id, { approved: true });

    expect(ok).toBe(false);
    // Still pending, so the human can retry once droid fixes the underlying spec.
    expect(queue.list()).toHaveLength(1);
  });

  it('ignores an answer whose id does not match the pending proposal', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );
    queue.propose(input());
    expect(await queue.answer('not-the-id', { approved: true })).toBe(false);
    expect(queue.list()).toHaveLength(1);
    await queue.answer(queue.list()[0]!.id, { approved: false });
  });

  it('cancelAll unblocks a waiting CLI on shutdown', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );
    const pending = queue.propose(input());
    queue.cancelAll();
    await expect(pending).resolves.toEqual({ approved: false, note: 'Foundry is shutting down' });
    expect(queue.list()).toEqual([]);
  });
});
