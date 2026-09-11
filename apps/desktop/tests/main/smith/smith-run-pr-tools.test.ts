import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../src/shared/ipc-contract.js';
import { SMITH_RUN_OPERATIONS, smithRunsTool } from '../../../src/main/smith/run-tools.js';
import { SMITH_PR_OPERATIONS, smithPrsTool } from '../../../src/main/smith/pr-tools.js';
import { ProposalQueue } from '../../../src/main/smith/proposals.js';
import type { MainInvoker } from '../../../src/main/ipc/shared.js';

const json = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);
function setup(kind: 'runs' | 'prs', projectId: string | null = 'session') {
  const invoke = vi.fn().mockResolvedValue('normalized');
  const queue = new ProposalQueue(
    () => {},
    async () => ({ ok: true, entity: {} }),
  );
  const deps = { invoke: invoke as MainInvoker, queue, projectId: () => projectId ?? undefined };
  const tool = kind === 'runs' ? smithRunsTool(deps) : smithPrsTool(deps);
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
  await h.queue.answer(h.queue.list()[0]!.id, { approved: true });
  return json(await promise);
}

describe('Smith run and PR tools', () => {
  it.each([
    ['runs', SMITH_RUN_OPERATIONS],
    ['prs', SMITH_PR_OPERATIONS],
  ] as const)('recognizes all %s operations', async (kind, operations) => {
    expect(
      (setup(kind).tool.parameters as { properties: { operation: unknown } }).properties.operation,
    ).toMatchObject({
      enum: [...operations],
    });
  });

  it.each(['runs', 'prs'] as const)(
    'requires an explicit project in global %s scope',
    async (kind) => {
      expect(json(await setup(kind, null).execute({ operation: 'list' }))).toEqual({
        ok: false,
        error: 'projectId is required in All projects scope',
      });
    },
  );

  it('defaults run reads to the session project and uses exact argument order', async () => {
    const h = setup('runs');
    expect(json(await h.execute({ operation: 'events', runId: 'r1', afterChangeId: 7 }))).toEqual({
      ok: true,
      result: 'normalized',
    });
    expect(h.invoke).toHaveBeenCalledWith(IPC.runsEvents, 'session', 'r1', 7);
    await h.execute({ operation: 'live_tail', phaseId: 'ph1' });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.runsLiveTail, 'ph1');
    await h.execute({ operation: 'plan', runId: 'r1' });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.runsPlan, 'session', 'r1');
    // Listing restore targets is a read; performing one is gated below.
    await h.execute({ operation: 'checkpoints', runId: 'r1' });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.runsRestorableCheckpoints, 'session', 'r1');
    await h.execute({ operation: 'linear_issues', query: 'FOU-190' });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.linearIssues, 'FOU-190');
    await h.execute({ operation: 'linear_issue', issueId: 'issue-uuid' });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.linearIssue, 'issue-uuid');
    await h.execute({ operation: 'linear_workflow_states', teamId: 'team-1' });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.linearWorkflowStates, 'team-1');
  });

  it('compacts a fat events page before it reaches the model', async () => {
    const h = setup('runs');
    const events = Array.from({ length: 80 }, (_, i) => ({
      rowid: i + 1,
      changeId: i + 1,
      eventId: `e${i + 1}`,
      runId: 'r1',
      phaseId: 'p1',
      parentId: null,
      type: 'log',
      name: 'reviewer: text',
      payload: { text: 'z'.repeat(2_000) },
      tokens: 0,
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: null,
    }));
    h.invoke.mockResolvedValueOnce({ events, cursor: 80 });
    const result = json(await h.execute({ operation: 'events', runId: 'r1', afterChangeId: 0 }));
    expect(result).toMatchObject({ ok: true, result: { hasMore: true, truncated: true } });
    const page = result.result as { events: unknown[]; cursor: number };
    expect(page.events.length).toBeLessThan(80);
    expect(JSON.stringify(result).length).toBeLessThan(80_000);
  });

  it.each([
    ['detail', {}, 'runId'],
    ['events', { runId: 'r' }, 'afterChangeId'],
    ['context', { runId: 'r' }, 'agent'],
    ['start', {}, 'pipelineId and request'],
    ['linear_start', {}, 'pipelineId and issueId'],
    ['linear_issue', {}, 'issueId'],
    ['linear_workflow_states', {}, 'teamId'],
    ['archive', { runId: 'r' }, 'archived'],
    ['export_plan', { runId: 'r' }, 'pipeline or at least one agent'],
    ['export_plan', { runId: 'r', agents: 'builder' }, 'agents must be an array'],
    ['restore_checkpoint', { runId: 'r' }, 'checkpointId is required'],
    ['checkpoints', {}, 'runId'],
  ])('validates run %s arguments', async (operation, args, error) => {
    expect(json(await setup('runs').execute({ operation, ...args }))).toMatchObject({
      ok: false,
      error: expect.stringContaining(error),
    });
  });

  it.each([
    [
      'start',
      { pipelineId: 'pipe', request: 'do it' },
      IPC.runsStart,
      [{ projectId: 'session', pipelineId: 'pipe', request: 'do it' }],
    ],
    [
      'linear_start',
      { pipelineId: 'pipe', issueId: 'issue-uuid' },
      IPC.linearStartRun,
      [{ projectId: 'session', pipelineId: 'pipe', issueId: 'issue-uuid' }],
    ],
    ['archive', { runId: 'r', archived: false }, IPC.runsArchive, ['session', 'r', false]],
    ['merge', { runId: 'r' }, IPC.runsMergeWorktree, ['session', 'r']],
    [
      'export_plan',
      { runId: 'r', pipeline: true, agents: ['builder'] },
      IPC.runsExportPlan,
      ['session', 'r', { pipeline: true, agents: ['builder'] }],
    ],
    [
      'restore_checkpoint',
      { runId: 'r', checkpointId: 'cp_1' },
      IPC.runsRestoreCheckpoint,
      // A partial restore is never assumed: an unstated `acceptPartial` is
      // false, so a truncated checkpoint still refuses.
      ['session', { runId: 'r', checkpointId: 'cp_1', acceptPartial: false }],
    ],
    [
      'restore_checkpoint',
      { runId: 'r', checkpointId: 'cp_1', acceptPartial: true },
      IPC.runsRestoreCheckpoint,
      ['session', { runId: 'r', checkpointId: 'cp_1', acceptPartial: true }],
    ],
  ])('gates run %s and invokes exact channel', async (operation, args, channel, expected) => {
    const h = setup('runs');
    expect(await approve(h, { operation, ...args })).toEqual({ ok: true, result: 'normalized' });
    expect(h.invoke).toHaveBeenCalledWith(channel, ...expected);
  });

  it('covers PR immediate and gated channels', async () => {
    const h = setup('prs');
    expect(json(await h.execute({ operation: 'status' }))).toEqual({
      ok: true,
      result: 'normalized',
    });
    expect(h.invoke).toHaveBeenCalledWith(IPC.prsStatus, 'session');
    expect(await approve(h, { operation: 'create', runId: 'r', title: 'T', body: 'B' })).toEqual({
      ok: true,
      result: 'normalized',
    });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.prsCreate, 'session', 'r', 'T', 'B');
  });

  it.each([
    ['create', {}, 'runId, title, and body'],
    ['merge', {}, 'prNumber'],
    ['merge', { prNumber: 4, method: 'rebase' }, 'method must be merge or squash'],
    ['fix_conflicts', {}, 'prNumber'],
  ])('validates PR %s arguments', async (operation, args, error) => {
    expect(json(await setup('prs').execute({ operation, ...args }))).toMatchObject({
      ok: false,
      error: expect.stringContaining(error),
    });
  });
});
