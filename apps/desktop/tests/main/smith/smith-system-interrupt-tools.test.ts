import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../src/shared/ipc-contract.js';
import { SMITH_SYSTEM_OPERATIONS, smithSystemTool } from '../../../src/main/smith/system-tools.js';
import { ProposalQueue } from '../../../src/main/smith/proposals.js';
import type { MainInvoker } from '../../../src/main/ipc/shared.js';

const json = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);
function setup(reply: unknown = 'value') {
  const invoke = vi.fn().mockResolvedValue(reply === null ? undefined : reply);
  const queue = new ProposalQueue(
    () => {},
    async () => ({ ok: true, entity: {} }),
  );
  const deps = { invoke: invoke as MainInvoker, queue, projectId: () => undefined };
  const tool = smithSystemTool(deps);
  return {
    invoke,
    queue,
    tool,
    execute: (p: unknown) =>
      (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)('id', p),
  };
}
async function approve(h: ReturnType<typeof setup>, params: Record<string, unknown>) {
  const promise = h.execute(params);
  await vi.waitFor(() => expect(h.queue.list()).toHaveLength(1));
  const proposal = h.queue.list()[0]!;
  await h.queue.answer(proposal.id, { approved: true });
  return { proposal, output: json(await promise) };
}

describe('Smith system tools', () => {
  it('recognizes every exported system operation', () => {
    expect(
      (setup().tool.parameters as { properties: { operation: unknown } }).properties.operation,
    ).toMatchObject({
      enum: [...SMITH_SYSTEM_OPERATIONS],
    });
  });

  it.each([
    ['doctor', IPC.doctorRun],
    ['orphans', IPC.maintenanceOrphans],
    ['version', IPC.appVersion],
    ['update_status', IPC.updaterGetStatus],
  ])('runs immediate system %s and normalizes results', async (operation, channel) => {
    const h = setup(null);
    expect(json(await h.execute({ operation }))).toEqual({ ok: true, result: null });
    expect(h.invoke).toHaveBeenCalledWith(channel);
    expect(h.queue.list()).toHaveLength(0);
  });

  it.each([
    ['remove_orphan', {}, 'projectId and path'],
    ['open_external', {}, 'url'],
  ])('validates system %s arguments', async (operation, args, error) => {
    expect(json(await setup().execute({ operation, ...args }))).toEqual({
      ok: false,
      error: `${error} are required`.replace('url are', 'url is'),
    });
  });

  it.each([
    [
      'remove_orphan',
      { projectId: 'p', path: '/worktree' },
      IPC.maintenanceRemoveWorktree,
      ['p', '/worktree'],
    ],
    [
      'open_external',
      { url: 'https://example.test' },
      IPC.appOpenExternal,
      ['https://example.test'],
    ],
    ['update_download', {}, IPC.updaterDownload, []],
    ['quit', {}, IPC.appQuit, []],
  ])('gates system %s with exact channel order', async (operation, args, channel, expected) => {
    const h = setup();
    const { output } = await approve(h, { operation, ...args });
    expect(h.invoke).toHaveBeenCalledWith(channel, ...expected);
    expect(output).toEqual({ ok: true, result: 'value' });
  });
});
