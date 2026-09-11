/**
 * Cancellation/discard races for durable proposals. Real `ProposalStore` over
 * a temp DB with hanging live turns; late completions are injected via
 * `onProgress`, the same path a model turn takes after a renderer went away.
 */

import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { createPlans } from '../../../src/main/orchestrator/plan-session.js';
import { ProposalStore } from '../../../src/main/orchestrator/proposals.js';
import type { GeneratedRunPlan } from '../../../src/shared/types.js';
import type { OrchestratorState } from '../../../src/shared/ipc-contract.js';
import { scriptedOneShots } from '../../helpers/scripted-oneshot.js';

function samplePlan(planId: string, projectId: string): GeneratedRunPlan {
  return {
    planId,
    projectId,
    prompt: 'make it better',
    refinedRequest: 'Improve the README.',
    rationale: 'Small change.',
    pipeline: {
      id: `generated-${planId}`,
      name: 'Build',
      description: 'One build.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [
        {
          name: 'build',
          kind: 'agent',
          agent: 'builder',
          model: 'scripted/strong',
          reasoningEffort: 'high',
          description: 'Make the change.',
          envelope: 'build',
          prompt: { inputs: ['request'] },
        },
      ],
      builtin: false,
    },
    agents: [],
    warnings: [],
    model: 'inherit',
    reasoningEffort: 'high',
  };
}

function harness() {
  const support = tempDir('foundry-proposals-races-');
  const tracers = new Map<string, Tracer>();
  const tracerFor = (projectId: string): Tracer | null => {
    if (projectId !== 'proj_a') return null;
    let tracer = tracers.get(projectId);
    if (!tracer) {
      tracer = new Tracer(
        openDb(projectDbPath(support, '/repo/a')),
        projectRunsDir(support, '/repo/a'),
      );
      tracers.set(projectId, tracer);
    }
    return tracer;
  };
  let now = 1000;
  const broadcasts: string[] = [];
  const oneShots = scriptedOneShots([
    { hangUntilAbort: true },
    { hangUntilAbort: true },
    { hangUntilAbort: true },
    { hangUntilAbort: true },
  ]);
  const plans = createPlans(oneShots.factory, (state) => store.onProgress(state));
  const store = new ProposalStore({
    tracerFor,
    projectIds: () => ['proj_a'],
    plans,
    broadcast: (channel) => broadcasts.push(channel),
    now: () => now,
    startRun: async () => ({ ok: false, issues: [] }),
  });
  const project = { id: 'proj_a', path: '/tmp/repo', contextSummary: '', commands: [] };
  const services = {
    rosterFor: () => [],
    envelopeDefs: [],
    defaultModel: 'inherit',
    enabledModels: async () => [],
    ghAvailable: async () => false,
  };
  return {
    store,
    plans,
    project,
    services,
    broadcasts,
    setNow: (value: number) => {
      now = value;
    },
  };
}

function doneFor(store: ProposalStore, planId: string, at: number): OrchestratorState {
  const current = store.get(planId);
  if (!current) throw new Error('missing proposal');
  return {
    planId,
    projectId: current.projectId,
    status: 'done',
    model: current.model,
    reasoningEffort: current.reasoningEffort,
    prompt: current.prompt,
    entries: [],
    plan: samplePlan(planId, current.projectId),
    rawReply: '{"ok":true}',
    detail: 'plan ready',
    startedAt: current.createdAt,
    messages: [],
    revision: 1,
    endedAt: at,
  } as OrchestratorState;
}

describe('proposal cancel/discard races', () => {
  it('cancels a generating proposal and ignores late completion', () => {
    const h = harness();
    const started = h.store.start(
      h.project,
      { prompt: 'one', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const planId = (started as { planId: string }).planId;

    expect(h.store.cancel(planId)).toBe(true);
    expect(h.store.get(planId)?.status).toBe('cancelled');

    // A late `done` arriving after cancel never flips back to ready.
    h.setNow(2000);
    h.store.onProgress(doneFor(h.store, planId, 2000));
    expect(h.store.get(planId)?.status).toBe('cancelled');
    h.plans.cancelAll();
  });

  it('discards a generating proposal, hides it, and drops late completion', () => {
    const h = harness();
    const started = h.store.start(
      h.project,
      { prompt: 'one', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const planId = (started as { planId: string }).planId;

    expect(h.store.discard(planId)).toBe(true);
    // Tombstone stays readable via `get` but hides from the default list.
    expect(h.store.get(planId)?.status).toBe('discarded');
    expect(h.store.list('proj_a')).toHaveLength(0);

    h.setNow(2000);
    h.store.onProgress(doneFor(h.store, planId, 2000));
    // Tombstone stays; the late plan is dropped, not resurrected.
    expect(h.store.get(planId)?.status).toBe('discarded');
    expect(h.store.list('proj_a')).toHaveLength(0);
    h.plans.cancelAll();
  });

  it('refuses accept after discard without starting a run', async () => {
    const h = harness();
    const started = h.store.start(
      h.project,
      { prompt: 'one', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const planId = (started as { planId: string }).planId;
    h.setNow(2000);
    h.store.onProgress(doneFor(h.store, planId, 2000));
    expect(h.store.get(planId)?.status).toBe('ready');
    expect(h.store.discard(planId)).toBe(true);
    // The harness `startRun` stub would fail; the discard check must win
    // first, so the refusal names the tombstone rather than a start error.
    const outcome = await h.store.accept(planId);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.issues[0]?.message).toMatch(/discarded/);
    h.plans.cancelAll();
  });

  it('cancel on a ready proposal is a no-op false', () => {
    const h = harness();
    const started = h.store.start(
      h.project,
      { prompt: 'one', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const planId = (started as { planId: string }).planId;
    h.setNow(2000);
    h.store.onProgress(doneFor(h.store, planId, 2000));
    expect(h.store.get(planId)?.status).toBe('ready');
    expect(h.store.cancel(planId)).toBe(false);
    expect(h.store.get(planId)?.status).toBe('ready');
    h.plans.cancelAll();
  });
});
