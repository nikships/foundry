/**
 * Exactly-once proposal accept. Real `ProposalStore` over a temp DB; the
 * `startRun` seam counts starts and writes the run row through the same
 * `Tracer`, so the accepted snapshot and `runPlan` can be compared exactly.
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

function samplePlan(
  planId: string,
  projectId: string,
  model = 'scripted/strong',
): GeneratedRunPlan {
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
          model,
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

function setup(
  startImpl?: (
    plan: GeneratedRunPlan,
  ) => Promise<{ ok: true; runId: string } | { ok: false; issues: never[] }>,
) {
  const support = tempDir('foundry-proposals-accept-');
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
  const startedPlans: GeneratedRunPlan[] = [];
  let now = 1000;
  const oneShots = scriptedOneShots([
    { hangUntilAbort: true },
    { hangUntilAbort: true },
    { hangUntilAbort: true },
  ]);
  const plans = createPlans(oneShots.factory, (state) => store.onProgress(state));
  const store = new ProposalStore({
    tracerFor,
    projectIds: () => ['proj_a'],
    plans,
    broadcast: () => {},
    now: () => now,
    startRun:
      startImpl ??
      (async (plan) => {
        startedPlans.push(plan);
        const runId = `run_${startedPlans.length}`;
        tracerFor(plan.projectId)?.startRun({
          runId,
          projectId: plan.projectId,
          pipeline: plan.pipeline,
          request: plan.refinedRequest,
          engineer: 'test',
          worktreePath: null,
          branch: null,
          baseRef: 'main',
          mode: 'pi',
          plan,
        });
        return { ok: true, runId };
      }),
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
    tracerFor,
    startedPlans,
    setNow: (v: number) => (now = v),
  };
}

function readyStore(h: ReturnType<typeof setup>, planId: string, plan: GeneratedRunPlan): void {
  h.setNow(2000);
  const live = h.plans.get(planId) as OrchestratorState | null;
  const base: OrchestratorState = live ?? {
    planId,
    projectId: 'proj_a',
    status: 'running',
    model: 'inherit',
    reasoningEffort: 'medium',
    prompt: 'make it better',
    entries: [],
    plan: null,
    rawReply: '',
    detail: 'starting',
    startedAt: 1000,
    messages: [],
    revision: 0,
  };
  h.store.onProgress({
    ...base,
    status: 'done',
    detail: 'plan ready',
    plan,
    rawReply: '{}',
    revision: 1,
  });
}

describe('exactly-once accept', () => {
  it('shares one start across concurrent accepts and retains the exact snapshot', async () => {
    const h = setup();
    const started = h.store.start(
      h.project,
      { prompt: 'one', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const planId = (started as { planId: string }).planId;
    const plan = samplePlan(planId, 'proj_a');
    readyStore(h, planId, plan);

    const [first, second] = await Promise.all([h.store.accept(planId), h.store.accept(planId)]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('accept failed');
    expect(first.runId).toBe(second.runId);
    expect(h.startedPlans).toHaveLength(1);
    expect(h.startedPlans[0]).toEqual(plan);

    const stored = h.store.get(planId);
    expect(stored?.status).toBe('accepted');
    expect(stored?.acceptedRunId).toBe(first.runId);
    expect(stored?.acceptedPlan).toEqual(plan);
    // The accepted proposal becomes the persisted run plan, exactly.
    expect(h.tracerFor('proj_a')?.runPlan(first.runId)).toEqual(plan);

    // A sequential repeat returns the same run without starting again.
    const repeat = await h.store.accept(planId);
    expect(repeat).toEqual(first);
    expect(h.startedPlans).toHaveLength(1);
    h.plans.cancelAll();
  });

  it('persists the operator-overridden snapshot, not the generated one', async () => {
    const h = setup();
    const started = h.store.start(
      h.project,
      { prompt: 'one', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const planId = (started as { planId: string }).planId;
    readyStore(h, planId, samplePlan(planId, 'proj_a', 'scripted/strong'));

    const overridden = samplePlan(planId, 'proj_a', 'scripted/fast');
    const outcome = await h.store.accept(planId, overridden);
    expect(outcome.ok).toBe(true);
    expect(h.startedPlans[0]?.pipeline.phases[0]?.model).toBe('scripted/fast');
    expect(h.store.get(planId)?.acceptedPlan).toEqual(overridden);
    if (outcome.ok) {
      expect(h.tracerFor('proj_a')?.runPlan(outcome.runId)).toEqual(overridden);
    }
    h.plans.cancelAll();
  });

  it('starts nothing for discarded or missing proposals', async () => {
    const h = setup();
    const started = h.store.start(
      h.project,
      { prompt: 'one', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const planId = (started as { planId: string }).planId;
    readyStore(h, planId, samplePlan(planId, 'proj_a'));
    expect(h.store.discard(planId)).toBe(true);

    const discarded = await h.store.accept(planId);
    expect(discarded.ok).toBe(false);
    const missing = await h.store.accept('plan-missing');
    expect(missing.ok).toBe(false);
    expect(h.startedPlans).toHaveLength(0);
    h.plans.cancelAll();
  });
});
