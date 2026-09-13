import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../src/shared/ipc-contract.js';
import { smithRunsTool } from '../../../src/main/smith/run-tools.js';
import { ProposalQueue } from '../../../src/main/smith/proposals.js';
import type { MainInvoker } from '../../../src/main/ipc/shared.js';

describe('Smith assigned-work Linear reads', () => {
  it.each([
    [{ assigned: true }, ['', { assigned: true }]],
    [{ query: 'FOU-190' }, ['FOU-190']],
    [{ query: 'FOU-190', assigned: false }, ['FOU-190']],
    [{ query: "what's assigned to me" }, ['', { assigned: true }]],
    [{ query: 'my tickets for the auth bug' }, ['auth bug', { assigned: true }]],
  ])('keeps explicit and voice-style assigned reads: %j', async (params, args) => {
    const invoke = vi.fn(async () => 'normalized') as unknown as MainInvoker;
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );
    const tool = smithRunsTool({ invoke, queue, projectId: () => undefined });
    const execute = tool.execute as unknown as (id: string, params: unknown) => Promise<unknown>;
    await execute('id', { operation: 'linear_issues', ...params });
    expect(invoke).toHaveBeenCalledExactlyOnceWith(IPC.linearIssues, ...args);
    expect(queue.list()).toEqual([]);
  });

  it('rejects a non-boolean assigned flag without invoking', async () => {
    const invoke = vi.fn() as unknown as MainInvoker;
    const queue = new ProposalQueue(
      () => {},
      async () => ({ ok: true, entity: {} }),
    );
    const tool = smithRunsTool({ invoke, queue, projectId: () => undefined });
    const execute = tool.execute as unknown as (
      id: string,
      params: unknown,
    ) => Promise<{ content: unknown }>;
    const result = await execute('id', { operation: 'linear_issues', assigned: 'yes' });
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ ok: false, error: 'assigned must be a boolean' }) },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
