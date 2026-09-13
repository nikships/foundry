/**
 * The Smith proposal queue: one pending at a time, a blocking promise the CLI
 * awaits, and a save handler that runs before an approve resolves. These pin the
 * lifecycle — propose/approve/reject, concurrent rejection, and the
 * save-refused-keeps-pending rule.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SmithActionProposal } from '../../../src/shared/types.js';
import {
  ProposalQueue,
  type EntityProposalInput,
  type ProposalInput,
} from '../../../src/main/smith/proposals.js';
import type { ActionExecutionRecord } from '../../../src/main/smith/receipts.js';

const input = (over: Partial<EntityProposalInput> = {}): ProposalInput => ({
  type: 'entity',
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
  it('automatically saves entities without exposing an approval card', async () => {
    const save = vi.fn(async () => ({ ok: true as const, entity: { name: 'planner' } }));
    const queue = new ProposalQueue(
      () => {},
      save,
      undefined,
      () => true,
    );
    const pending = queue.propose(input());
    expect(queue.list()).toEqual([]);
    await expect(pending).resolves.toEqual({
      approved: true,
      result: { ok: true, entity: { name: 'planner' } },
    });
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([
    'write',
    'destructive',
    'credential',
    'shell',
    'git',
    'external',
    'network',
    'lifecycle',
    'maintenance',
  ] as const)('automatically executes %s actions and records their actual result', async (risk) => {
    const settled = vi.fn();
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
      settled,
      () => true,
    );
    const execute = vi.fn(() => ({
      ok: true as const,
      modelResult: { ok: true, completed: true },
    }));
    await expect(
      queue.propose(
        {
          type: 'action',
          operation: 'test',
          title: 'Test action',
          summary: 'Test action.',
          args: {},
          risk,
        },
        execute,
      ),
    ).resolves.toMatchObject({ approved: true, result: { completed: true } });
    expect(execute).toHaveBeenCalledOnce();
    expect(queue.list()).toEqual([]);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ risk }),
      expect.objectContaining({ outcome: 'succeeded' }),
    );
  });

  it('returns automatic entity failures instead of waiting for an invisible retry card', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: false, error: 'save refused' }),
      undefined,
      () => true,
    );
    await expect(queue.propose(input())).resolves.toEqual({
      approved: true,
      result: { ok: false, error: 'save refused' },
    });
    expect(queue.list()).toEqual([]);
    await expect(queue.propose(input())).resolves.toMatchObject({ result: { ok: false } });
  });

  it('records a failed automatic action and releases the slot', async () => {
    const settled = vi.fn();
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
      settled,
      () => true,
    );
    await expect(
      queue.propose(
        {
          type: 'action',
          operation: 'merge',
          title: 'Merge',
          summary: 'Merge run.',
          args: {},
          risk: 'git',
        },
        () => {
          throw new Error('merge refused');
        },
      ),
    ).resolves.toEqual({ approved: true, result: { ok: false, error: 'merge refused' } });
    expect(settled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'failed', error: 'merge refused' }),
    );
    expect(queue.list()).toEqual([]);
  });

  it('keeps the global single-executor slot while an automatic action runs', async () => {
    let finish!: () => void;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const queue = new ProposalQueue(
      () => {},
      async () => {
        await wait;
        return { ok: true, entity: {} };
      },
      undefined,
      () => true,
    );
    const pending = queue.propose(input());
    expect(queue.list()).toEqual([]);
    await expect(queue.propose(input())).rejects.toThrow('proposal_pending');
    finish();
    await expect(pending).resolves.toMatchObject({ approved: true });
  });

  it.each(['set_api_key', 'pairing'] as const)(
    'keeps %s interactive in YOLO mode',
    async (operation) => {
      const execute = vi.fn(() => ({ ok: true as const, modelResult: { ok: true } }));
      const queue = new ProposalQueue(
        () => {},
        async () => ({ ok: true, entity: {} }),
        undefined,
        () => true,
      );
      const pending = queue.propose(
        {
          type: 'action',
          operation,
          title: 'Private input',
          summary: 'Private input.',
          args: {},
          risk: 'credential',
          ...(operation === 'set_api_key'
            ? { secretRequest: { kind: 'api-key' as const, label: 'API key' } }
            : {}),
        },
        execute,
      );
      expect(queue.list()).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      if (operation === 'set_api_key') {
        await expect(queue.answer(queue.list()[0]!.id, { approved: true })).resolves.toMatchObject({
          ok: false,
        });
        expect(execute).not.toHaveBeenCalled();
      }
      await queue.answer(queue.list()[0]!.id, { approved: false });
      await expect(pending).resolves.toMatchObject({ approved: false });
    },
  );

  it('does not retroactively approve a card and reads the mode for each new proposal', async () => {
    let bypass = false;
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
      undefined,
      () => bypass,
    );
    const pending = queue.propose(input());
    bypass = true;
    expect(queue.list()).toHaveLength(1);
    await queue.answer(queue.list()[0]!.id, { approved: false });
    await pending;
    await expect(queue.propose(input())).resolves.toMatchObject({ approved: true });
    bypass = false;
    const next = queue.propose(input());
    expect(queue.list()).toHaveLength(1);
    await queue.answer(queue.list()[0]!.id, { approved: false });
    await next;
  });

  it('exposes exactly the one pending proposal as a list', async () => {
    const onChanged = vi.fn();
    const queue = new ProposalQueue(onChanged, async () => ({ ok: true, entity: {} }));

    expect(queue.list()).toEqual([]);
    const pending = queue.propose(input());
    expect(queue.list()).toHaveLength(1);
    expect(queue.list()[0]).toMatchObject({ type: 'entity', name: 'planner' });
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

    expect(ok).toEqual({ ok: true });
    expect(save).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toEqual({
      approved: true,
      result: { ok: true, entity: saved },
    });
    expect(queue.list()).toEqual([]);
  });

  it('carries the reject note back to the waiting CLI without saving', async () => {
    const save = vi.fn(async () => ({ ok: true as const, entity: {} }));
    const queue = new ProposalQueue(() => {}, save);

    const pending = queue.propose(input());
    const id = queue.list()[0]!.id;
    const ok = await queue.answer(id, { approved: false, note: 'use kebab-case' });

    expect(ok).toEqual({ ok: true });
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
    expect(queue.list()[0]).toMatchObject({ type: 'entity', name: 'a' });

    await queue.answer(queue.list()[0]!.id, { approved: false });
    await first;
  });

  it('keeps the proposal pending when the save is refused', async () => {
    const save = vi.fn(async () => ({ ok: false as const, error: 'name taken' }));
    const queue = new ProposalQueue(() => {}, save);

    queue.propose(input());
    const id = queue.list()[0]!.id;
    const ok = await queue.answer(id, { approved: true });

    expect(ok).toEqual({ ok: false, error: 'name taken' });
    // Still pending, so the human can retry once droid fixes the underlying spec.
    expect(queue.list()).toHaveLength(1);
  });

  it('ignores an answer whose id does not match the pending proposal', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );
    queue.propose(input());
    expect(await queue.answer('not-the-id', { approved: true })).toEqual({
      ok: false,
      error: 'proposal not found',
    });
    expect(queue.list()).toHaveLength(1);
    await queue.answer(queue.list()[0]!.id, { approved: false });
  });

  it('executes actions once and clears ordinary failures without retrying', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );
    const execute = vi.fn(async () => ({ ok: false as const, error: 'offline' }));
    const pending = queue.propose(
      {
        type: 'action',
        operation: 'update_check',
        title: 'Check for updates',
        summary: 'Contact the update service.',
        args: {},
        risk: 'network',
      },
      execute,
    );
    const result = await queue.answer(queue.list()[0]!.id, { approved: true });
    expect(result).toEqual({ ok: false, error: 'offline' });
    await expect(pending).resolves.toEqual({
      approved: true,
      result: { ok: false, error: 'offline' },
    });
    expect(queue.list()).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects a duplicate answer while the approved action is executing', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = queue.propose(
      {
        type: 'action',
        operation: 'start',
        title: 'Start run',
        summary: 'Start one run.',
        args: {},
        risk: 'lifecycle',
      },
      async () => {
        await running;
        return { ok: true, modelResult: { ok: true } };
      },
    );
    const id = queue.list()[0]!.id;
    const first = queue.answer(id, { approved: true });

    await expect(queue.answer(id, { approved: true })).resolves.toEqual({
      ok: false,
      error: 'proposal is already executing',
    });
    finish();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(pending).resolves.toEqual({ approved: true, result: { ok: true } });
  });

  it('keeps secrets out of proposals/model results and returns private displays separately', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );
    const secret = 'super-secret-key';
    const pending = queue.propose(
      {
        type: 'action',
        operation: 'set_api_key',
        title: 'Set API key',
        summary: 'Store a provider key.',
        args: { providerId: 'acme' },
        risk: 'credential',
        secretRequest: { kind: 'api-key', label: 'API key' },
      },
      () => ({
        ok: true,
        modelResult: { ok: true },
        privateDisplay: {
          kind: 'companion-pairing',
          payload: {
            protocolVersion: 1,
            origin: 'https://example.test',
            desktopId: 'desktop',
            desktopName: 'Foundry',
            secret,
            expiresAt: '2026-08-22T00:00:00Z',
          },
        },
      }),
    );
    const serializedProposal = JSON.stringify(queue.list());
    expect(serializedProposal).not.toContain(secret);
    const answer = await queue.answer(queue.list()[0]!.id, { approved: true, secret });
    expect(answer.ok).toBe(true);
    expect(JSON.stringify(await pending)).not.toContain(secret);
    expect(JSON.stringify(answer)).toContain(secret);
  });

  it('reports a settled action once, with what the executor returned', async () => {
    const settled: Array<[SmithActionProposal, ActionExecutionRecord]> = [];
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
      (proposal, execution) => settled.push([proposal, execution]),
    );
    const pending = queue.propose(
      {
        type: 'action',
        operation: 'create',
        title: 'create pull request',
        summary: 'create using GitHub.',
        args: { runId: 'run_7' },
        risk: 'git',
      },
      () => ({ ok: true, modelResult: { ok: true, url: 'https://x.test/pull/1' } }),
    );
    await queue.answer(queue.list()[0]!.id, { approved: true });
    await pending;

    expect(settled).toHaveLength(1);
    const [proposal, execution] = settled[0]!;
    expect(proposal.operation).toBe('create');
    expect(execution.outcome).toBe('succeeded');
    expect(execution.result).toEqual({ ok: true, url: 'https://x.test/pull/1' });
    expect(execution.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a failed action too — approval is not success', async () => {
    const settled: ActionExecutionRecord[] = [];
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
      (_proposal, execution) => settled.push(execution),
    );
    const pending = queue.propose(
      {
        type: 'action',
        operation: 'update_check',
        title: 'Check for updates',
        summary: 'Contact the update service.',
        args: {},
        risk: 'network',
      },
      () => {
        throw new Error('offline');
      },
    );
    await queue.answer(queue.list()[0]!.id, { approved: true });
    await pending;

    expect(settled).toEqual([expect.objectContaining({ outcome: 'failed', error: 'offline' })]);
  });

  it('reports nothing for a rejected action or an entity save', async () => {
    const settled: unknown[] = [];
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
      (proposal, execution) => settled.push([proposal, execution]),
    );

    const rejected = queue.propose(
      {
        type: 'action',
        operation: 'kill',
        title: 'kill run',
        summary: 'kill the selected run.',
        args: { runId: 'run_7' },
        risk: 'destructive',
      },
      () => ({ ok: true, modelResult: { ok: true } }),
    );
    await queue.answer(queue.list()[0]!.id, { approved: false });
    await rejected;
    expect(settled).toEqual([]);

    // An entity save's evidence is the stored definition, not a receipt.
    const entity = queue.propose(input());
    await queue.answer(queue.list()[0]!.id, { approved: true });
    await entity;
    expect(settled).toEqual([]);
  });

  it('keeps the action outcome when recording the receipt throws', async () => {
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
      () => {
        throw new Error('transcript is gone');
      },
    );
    const pending = queue.propose(
      {
        type: 'action',
        operation: 'archive',
        title: 'archive run',
        summary: 'archive the selected run.',
        args: { runId: 'run_7' },
        risk: 'write',
      },
      () => ({ ok: true, modelResult: { ok: true } }),
    );
    await expect(queue.answer(queue.list()[0]!.id, { approved: true })).resolves.toEqual({
      ok: true,
    });
    await expect(pending).resolves.toEqual({ approved: true, result: { ok: true } });
    expect(queue.list()).toEqual([]);
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
