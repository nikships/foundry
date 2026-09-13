import { describe, expect, it, vi } from 'vitest';
import { composeHarness } from '../../helpers/smith-compose.js';
import { SMITH_RUN_OPERATIONS } from '../../../src/main/smith/run-tools.js';
import { warmStartPrep } from '../../../src/main/engine/operations.js';

vi.mock('../../../src/main/engine/operations.js', () => ({ warmStartPrep: vi.fn(async () => {}) }));

describe('smith_compose', () => {
  it('replaces all legacy run operations and composes immediately with Smith defaults and prep', async () => {
    const h = composeHarness();
    expect(SMITH_RUN_OPERATIONS.some((op) => op.startsWith('compose_'))).toBe(false);
    expect(h.tool.parameters).toMatchObject({
      properties: {
        operation: { enum: ['compose', 'revise', 'get', 'list', 'accept', 'discard', 'cancel'] },
      },
    });
    expect(await h.execute({ operation: 'compose', prompt: 'Improve help' })).toMatchObject({
      ok: true,
      result: { planId: 'plan-1', status: 'generating' },
      note: expect.stringContaining('Stop; do not poll'),
    });
    expect(h.queue.list()).toEqual([]);
    expect(h.starts[0]).toMatchObject({
      projectId: 'project',
      projectPath: '/fixture',
      model: 'fixture/smith',
      reasoningEffort: 'low',
    });
    expect(h.proposals.generatingForScope('project')).toBe(1);
    expect(warmStartPrep).toHaveBeenCalledWith(expect.anything(), 'project');
  });

  it('requires a target in global chat and records the global issuer, not the target', async () => {
    const h = composeHarness();
    const global = h.toolFor(undefined);
    const execute = global.execute as unknown as (id: string, params: unknown) => Promise<unknown>;
    expect(JSON.stringify(await execute('id', { operation: 'compose', prompt: 'Help' }))).toContain(
      'projectId is required',
    );
    expect(h.starts).toEqual([]);
    await execute('id', {
      operation: 'compose',
      prompt: 'Help',
      projectId: 'other',
      model: 'fixture/override',
      reasoningEffort: 'high',
    });
    expect(h.starts[0]).toMatchObject({
      projectId: 'other',
      model: 'fixture/override',
      reasoningEffort: 'high',
    });
    expect(h.proposals.issuedGlobally('plan-1')).toBe(true);
    expect(h.proposals.generatingForScope(undefined)).toBe(1);
    expect(h.proposals.generatingForScope('other')).toBe(0);
  });

  it('caps concurrent starts across target projects and frees capacity on completion', async () => {
    const h = composeHarness();
    const results = await Promise.all(
      ['project', 'other', 'project', 'other'].map((projectId) =>
        h.execute({ operation: 'compose', projectId, prompt: 'Help' }),
      ),
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[3].error).toContain('3 generating plans');
    h.ready('plan-1');
    expect((await h.execute({ operation: 'compose', prompt: 'Next' })).ok).toBe(true);
    expect(h.starts).toHaveLength(4);
  });

  it.each([
    [{ operation: 'compose' }, 'prompt'],
    [{ operation: 'compose', prompt: 'Help', reasoningEffort: 'max' }, 'reasoningEffort'],
    [{ operation: 'compose', prompt: 'Help', projectId: 'missing' }, 'project not found'],
    [{ operation: 'get' }, 'planId'],
    [{ operation: 'revise', planId: 'p' }, 'note'],
    [{ operation: 'accept', planId: 'p', plan: [] }, 'plan must be an object'],
    [{ operation: 'compose_plan' }, 'unknown operation'],
  ])('refuses invalid arguments without a turn or approval: %j', async (params, message) => {
    const h = composeHarness();
    expect(await h.execute(params)).toMatchObject({
      ok: false,
      error: expect.stringContaining(message),
    });
    expect(h.starts).toEqual([]);
    expect(h.queue.list()).toEqual([]);
  });

  it('revises immediately and preserves verbatim expired-session refusal without replacing a row', async () => {
    const h = composeHarness();
    const state = h.ready();
    h.plans.message.mockImplementation((id, note) => {
      h.proposals.onProgress({
        ...state,
        planId: id,
        status: 'running',
        messages: [{ id: 'note', role: 'operator', text: note, at: 1000 }],
      });
      return null;
    });
    expect(
      await h.execute({ operation: 'revise', planId: 'plan-1', note: 'Split the build' }),
    ).toMatchObject({ ok: true, result: { status: 'generating' } });
    expect(h.proposals.get('plan-1')?.messages[0]?.text).toBe('Split the build');
    expect(h.queue.list()).toEqual([]);
    h.ready();
    h.plans.message.mockReturnValue('session not found');
    expect(await h.execute({ operation: 'revise', planId: 'plan-1', note: 'Try again' })).toEqual({
      ok: false,
      error: 'session not found',
    });
    expect(h.proposals.get('plan-1')?.revision).toBe(1);
    expect(h.starts).toEqual([]);
  });

  it.each(['generating', 'accepted', 'discarded', 'cancelled', 'failed', 'missing'] as const)(
    'refuses revision of %s rows',
    async (status) => {
      const h = composeHarness();
      if (status !== 'missing') {
        h.ready();
        h.tracer.updateProposal('plan-1', { status, updatedAt: 2000 });
      }
      expect(
        (await h.execute({ operation: 'revise', planId: 'plan-1', note: 'Split it' })).ok,
      ).toBe(false);
      expect(h.plans.message).not.toHaveBeenCalled();
      expect(h.queue.list()).toEqual([]);
    },
  );

  it('bounds get/list and prioritizes active rows without exposing stored plans or raw evidence', async () => {
    const h = composeHarness();
    const state = h.ready();
    h.proposals.onProgress({
      ...state,
      detail: 'd'.repeat(1200),
      plan: { ...state.plan!, refinedRequest: 'b'.repeat(3000) },
    });
    h.ready('accepted', 'other');
    h.tracer.updateProposal('accepted', {
      status: 'accepted',
      acceptedRunId: 'run-old',
      updatedAt: 9000,
    });
    const result = (await h.execute({ operation: 'get', planId: 'plan-1' })).result;
    expect(result.refinedRequest).toHaveLength(2000);
    expect(result.detail).toHaveLength(1000);
    expect(result.phases).toMatchObject([
      { name: 'build', model: 'fixture/model' },
      { name: 'test', command: 'true' },
    ]);
    for (const key of [
      'plan',
      'acceptedPlan',
      'rawReply',
      'entries',
      'plan_json',
      'raw_reply',
      'entries_json',
    ])
      expect(result).not.toHaveProperty(key);
    expect(JSON.stringify(result)).not.toContain('private raw reply');
    expect((await h.execute({ operation: 'list', projectId: 'other' })).result).toEqual([]);
    const global = h.toolFor(undefined);
    const execute = global.execute as unknown as (
      id: string,
      params: unknown,
    ) => Promise<{ content: [{ text: string }] }>;
    const all = JSON.parse(
      (await execute('id', { operation: 'list', includeAccepted: true })).content[0].text,
    );
    expect(all.result.map((row: { planId: string }) => row.planId)).toEqual(['plan-1', 'accepted']);
    expect(all.result[1].acceptedRunId).toBe('run-old');
  });

  it.each(['accept', 'discard', 'cancel'] as const)(
    'requires approval for %s and leaves state alone on rejection',
    async (operation) => {
      const h = composeHarness();
      h.ready();
      const before = h.proposals.get('plan-1');
      const pending = h.execute({ operation, planId: 'plan-1' });
      expect(h.queue.list()[0]).toMatchObject({
        operation: `compose_${operation}`,
        risk: operation === 'discard' ? 'destructive' : 'write',
      });
      expect(h.startRun).not.toHaveBeenCalled();
      expect(h.proposals.get('plan-1')).toEqual(before);
      await h.queue.answer(h.queue.list()[0]!.id, { approved: false });
      expect(await pending).toMatchObject({ ok: false, rejected: true });
      expect(h.proposals.get('plan-1')).toEqual(before);
    },
  );

  it('uses durable exactly-once accept even against concurrent desktop acceptance and a later repeat', async () => {
    const h = composeHarness();
    h.ready();
    const recast = h.proposals.get('plan-1')!.plan!;
    recast.pipeline.phases[0]!.model = 'fixture/recast';
    let release!: () => void;
    h.startRun.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, runId: 'run-accepted' };
    });
    const pending = h.execute({ operation: 'accept', planId: 'plan-1', plan: recast });
    const answer = h.queue.answer(h.queue.list()[0]!.id, { approved: true });
    const competing = h.proposals.accept('plan-1');
    expect(h.startRun).toHaveBeenCalledExactlyOnceWith(recast);
    release();
    await answer;
    expect(await pending).toMatchObject({ ok: true, result: { runId: 'run-accepted' } });
    expect(await competing).toEqual({ ok: true, runId: 'run-accepted' });
    const again = h.execute({ operation: 'accept', planId: 'plan-1' });
    await h.queue.answer(h.queue.list()[0]!.id, { approved: true });
    await again;
    expect(h.startRun).toHaveBeenCalledTimes(1);
    expect(h.proposals.get('plan-1')).toMatchObject({
      status: 'accepted',
      acceptedRunId: 'run-accepted',
      acceptedPlan: recast,
    });
  });

  it('YOLO removes only waits: accepted rows still refuse discard', async () => {
    const h = composeHarness('project', true);
    h.ready();
    expect((await h.execute({ operation: 'accept', planId: 'plan-1' })).ok).toBe(true);
    expect((await h.execute({ operation: 'discard', planId: 'plan-1' })).ok).toBe(false);
    expect(h.queue.list()).toEqual([]);
    expect(h.proposals.get('plan-1')?.status).toBe('accepted');
  });
});
