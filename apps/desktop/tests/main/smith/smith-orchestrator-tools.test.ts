/**
 * Smith's orchestrator and assigned-work access: the seven `orchestrator_*`
 * operations on `smith_runs` plus the assigned-aware `linear_issues` read.
 * Voice reaches all of these through `smith_work` into the same session, so
 * pinning the text tool pins voice too.
 */

import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../src/shared/ipc-contract.js';
import { SMITH_RUN_OPERATIONS, smithRunsTool } from '../../../src/main/smith/run-tools.js';
import { ProposalQueue } from '../../../src/main/smith/proposals.js';
import type { MainInvoker } from '../../../src/main/ipc/shared.js';

const json = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

function setup(projectId: string | null = 'session') {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === IPC.settingsGet) {
      return { defaultModel: 'provider/runner', defaultReasoningEffort: 'high' };
    }
    return 'normalized';
  });
  const queue = new ProposalQueue(
    () => {},
    async () => ({ ok: true, entity: {} }),
  );
  const deps = { invoke: invoke as MainInvoker, queue, projectId: () => projectId ?? undefined };
  const tool = smithRunsTool(deps);
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

describe('Smith orchestrator operations', () => {
  it('declares all seven orchestrator operations on the tool schema', () => {
    const h = setup();
    const schema = h.tool.parameters as { properties: { operation: { enum: string[] } } };
    for (const operation of [
      'orchestrator_plan',
      'orchestrator_message',
      'orchestrator_cancel',
      'orchestrator_list',
      'orchestrator_get',
      'orchestrator_accept',
      'orchestrator_discard',
    ]) {
      expect(SMITH_RUN_OPERATIONS).toContain(operation);
      expect(schema.properties.operation.enum).toContain(operation);
    }
  });

  it('reads the proposal list in project scope and the plan by id without scope', async () => {
    const h = setup();
    expect(json(await h.execute({ operation: 'orchestrator_list' }))).toEqual({
      ok: true,
      result: 'normalized',
    });
    expect(h.invoke).toHaveBeenCalledWith(IPC.orchestratorList, 'session');

    // Polling a known plan must work from All-projects scope too.
    const global = setup(null);
    expect(json(await global.execute({ operation: 'orchestrator_get', planId: 'plan_1' }))).toEqual(
      {
        ok: true,
        result: 'normalized',
      },
    );
    expect(global.invoke).toHaveBeenCalledWith(IPC.orchestratorGet, 'plan_1');
    expect(global.queue.list()).toHaveLength(0);
  });

  it('requires a project for the list and a plan id for the fetch', async () => {
    expect(json(await setup(null).execute({ operation: 'orchestrator_list' }))).toEqual({
      ok: false,
      error: 'projectId is required in All projects scope',
    });
    expect(json(await setup().execute({ operation: 'orchestrator_get' }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('planId'),
    });
  });

  it('validates plan arguments before proposing', async () => {
    const h = setup();
    expect(json(await h.execute({ operation: 'orchestrator_plan' }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('prompt'),
    });
    expect(
      json(
        await h.execute({
          operation: 'orchestrator_plan',
          prompt: 'Draft a fix',
          reasoningEffort: 'max',
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('reasoningEffort'),
    });
    expect(h.queue.list()).toHaveLength(0);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('gates planning as a write and defaults the model from Settings', async () => {
    const h = setup();
    const pending = h.execute({ operation: 'orchestrator_plan', prompt: 'Draft a fix' });
    await vi.waitFor(() => expect(h.queue.list()).toHaveLength(1));
    const proposal = h.queue.list()[0]!;
    expect(proposal).toMatchObject({
      operation: 'orchestrator_plan',
      risk: 'write',
      args: { projectId: 'session', prompt: 'Draft a fix' },
    });
    await h.queue.answer(proposal.id, { approved: true });
    expect(json(await pending)).toEqual({ ok: true, result: 'normalized' });
    expect(h.invoke).toHaveBeenCalledWith(
      IPC.orchestratorPlan,
      'session',
      'Draft a fix',
      'provider/runner',
      'high',
    );
  });

  it('honours an explicit model and effort without reading Settings', async () => {
    const h = setup();
    await approve(h, {
      operation: 'orchestrator_plan',
      prompt: 'Draft a fix',
      model: 'provider/chosen',
      reasoningEffort: 'low',
    });
    expect(h.invoke).not.toHaveBeenCalledWith(IPC.settingsGet, expect.anything());
    expect(h.invoke).toHaveBeenCalledWith(
      IPC.orchestratorPlan,
      'session',
      'Draft a fix',
      'provider/chosen',
      'low',
    );
  });

  it('falls back to inherit/medium when Settings cannot be read', async () => {
    const h = setup();
    h.invoke.mockImplementation(async (channel: string) => {
      if (channel === IPC.settingsGet) throw new Error('settings unavailable');
      return 'normalized';
    });
    await approve(h, { operation: 'orchestrator_plan', prompt: 'Draft a fix' });
    expect(h.invoke).toHaveBeenCalledWith(
      IPC.orchestratorPlan,
      'session',
      'Draft a fix',
      'inherit',
      'medium',
    );
  });

  it.each([
    [
      'orchestrator_message',
      { planId: 'plan_1', text: 'Prefer X' },
      IPC.orchestratorMessage,
      ['plan_1', 'Prefer X'],
      'write',
    ],
    ['orchestrator_cancel', { planId: 'plan_1' }, IPC.orchestratorCancel, ['plan_1'], 'write'],
    ['orchestrator_accept', { planId: 'plan_1' }, IPC.orchestratorAccept, ['plan_1'], 'write'],
    [
      'orchestrator_discard',
      { planId: 'plan_1' },
      IPC.orchestratorDiscard,
      ['plan_1'],
      'destructive',
    ],
  ])(
    'gates %s with risk %s on its own channel',
    async (operation, args, channel, expected, risk) => {
      const h = setup();
      const pending = h.execute({ operation, ...args });
      await vi.waitFor(() => expect(h.queue.list()).toHaveLength(1));
      expect(h.queue.list()[0]).toMatchObject({ operation, risk });
      await h.queue.answer(h.queue.list()[0]!.id, { approved: true });
      expect(json(await pending)).toEqual({ ok: true, result: 'normalized' });
      expect(h.invoke).toHaveBeenCalledWith(channel, ...expected);
    },
  );

  it('passes an operator plan override through accept', async () => {
    const h = setup();
    const plan = { phases: [] };
    await approve(h, { operation: 'orchestrator_accept', planId: 'plan_1', plan });
    expect(h.invoke).toHaveBeenCalledWith(IPC.orchestratorAccept, 'plan_1', plan);
  });

  it.each([
    ['orchestrator_message', { planId: 'plan_1' }, 'planId and text'],
    ['orchestrator_message', { text: 'hi' }, 'planId and text'],
    ['orchestrator_cancel', {}, 'planId'],
    ['orchestrator_accept', {}, 'planId'],
    ['orchestrator_accept', { planId: 'plan_1', plan: 'nope' }, 'plan must be an object'],
    ['orchestrator_discard', {}, 'planId'],
  ])('validates %s arguments', async (operation, args, error) => {
    expect(json(await setup().execute({ operation, ...args }))).toMatchObject({
      ok: false,
      error: expect.stringContaining(error),
    });
  });

  it('lets plan-keyed actions run from All-projects scope', async () => {
    const h = setup(null);
    await approve(h, { operation: 'orchestrator_message', planId: 'plan_1', text: 'Prefer X' });
    expect(h.invoke).toHaveBeenCalledWith(IPC.orchestratorMessage, 'plan_1', 'Prefer X');
  });

  it('never starts a run directly for a proposal', async () => {
    const h = setup();
    await approve(h, { operation: 'orchestrator_accept', planId: 'plan_1' });
    expect(h.invoke).not.toHaveBeenCalledWith(IPC.runsStart, expect.anything());
  });
});

describe('Smith assigned-work Linear reads', () => {
  it('forwards an explicit assigned flag to the Linear channel', async () => {
    const h = setup();
    expect(json(await h.execute({ operation: 'linear_issues', assigned: true }))).toEqual({
      ok: true,
      result: 'normalized',
    });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.linearIssues, '', { assigned: true });
  });

  it('keeps plain searches on the single-argument call', async () => {
    const h = setup();
    await h.execute({ operation: 'linear_issues', query: 'FOU-190' });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.linearIssues, 'FOU-190');
    await h.execute({ operation: 'linear_issues', query: 'FOU-190', assigned: false });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.linearIssues, 'FOU-190');
  });

  it('reads assigned intent out of a voice-style transcript', async () => {
    const h = setup();
    await h.execute({ operation: 'linear_issues', query: "what's assigned to me" });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.linearIssues, '', { assigned: true });
    await h.execute({ operation: 'linear_issues', query: 'my tickets for the auth bug' });
    expect(h.invoke).toHaveBeenLastCalledWith(IPC.linearIssues, 'auth bug', { assigned: true });
  });

  it('rejects a non-boolean assigned flag', async () => {
    const h = setup();
    expect(
      json(await h.execute({ operation: 'linear_issues', query: 'x', assigned: 'yes' })),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('assigned must be a boolean'),
    });
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
