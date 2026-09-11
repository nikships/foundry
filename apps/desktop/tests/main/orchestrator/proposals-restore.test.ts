/**
 * Boot restore and hook-independent late completion. Real `ProposalStore`
 * over a temp DB; a "restart" is a fresh store over the same tracer with an
 * empty live registry.
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

function setup() {
  const support = tempDir('foundry-proposals-restore-');
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
  const project = { id: 'proj_a', path: '/tmp/repo', contextSummary: '', commands: [] };
  const services = {
    rosterFor: () => [],
    envelopeDefs: [],
    defaultModel: 'inherit',
    enabledModels: async () => [],
    ghAvailable: async () => false,
  };
  return { tracerFor, project, services, nowRef: () => now, setNow: (v: number) => (now = v) };
}

describe('proposal restore on boot', () => {
  it('marks generating interrupted while keeping ready/failed', () => {
    const h = setup();
    const broadcasts: string[] = [];
    const oneShots = scriptedOneShots([
      { hangUntilAbort: true },
      { hangUntilAbort: true },
      { hangUntilAbort: true },
    ]);
    const plans = createPlans(oneShots.factory, (state) => store.onProgress(state));
    const store = new ProposalStore({
      tracerFor: h.tracerFor,
      projectIds: () => ['proj_a'],
      plans,
      broadcast: (channel) => broadcasts.push(channel),
      now: () => h.nowRef(),
      startRun: async () => ({ ok: false, issues: [] }),
    });

    const first = store.start(
      h.project,
      { prompt: 'one', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const second = store.start(
      h.project,
      { prompt: 'two', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const third = store.start(
      h.project,
      { prompt: 'three', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const firstId = (first as { planId: string }).planId;
    const secondId = (second as { planId: string }).planId;
    const thirdId = (third as { planId: string }).planId;

    h.setNow(2000);
    const ready: OrchestratorState = {
      ...(plans.get(secondId) as OrchestratorState),
      status: 'done',
      detail: 'plan ready',
      plan: samplePlan(secondId, 'proj_a'),
      rawReply: '{}',
      revision: 1,
    };
    store.onProgress(ready);
    const failed: OrchestratorState = {
      ...(plans.get(thirdId) as OrchestratorState),
      status: 'failed',
      detail: 'no plan',
      plan: null,
      rawReply: '',
      revision: 0,
    };
    store.onProgress(failed);
    expect(store.get(firstId)?.status).toBe('generating');
    expect(store.get(secondId)?.status).toBe('ready');
    expect(store.get(thirdId)?.status).toBe('failed');

    // Simulated restart: fresh live map, same DB.
    const freshBroadcasts: string[] = [];
    const freshPlans = createPlans(scriptedOneShots([]).factory, () => {});
    const fresh = new ProposalStore({
      tracerFor: h.tracerFor,
      projectIds: () => ['proj_a'],
      plans: freshPlans,
      broadcast: (channel) => freshBroadcasts.push(channel),
      now: () => h.nowRef(),
      startRun: async () => ({ ok: false, issues: [] }),
    });
    h.setNow(3000);
    fresh.restoreOnBoot(['proj_a']);

    expect(fresh.get(firstId)?.status).toBe('failed');
    expect(fresh.get(firstId)?.detail).toMatch(/interrupted by restart/);
    expect(fresh.get(secondId)?.status).toBe('ready');
    expect(fresh.get(thirdId)?.status).toBe('failed');
    expect(freshBroadcasts.filter((c) => c === 'event:proposals-changed')).toHaveLength(1);

    plans.cancelAll();
    freshPlans.cancelAll();
  });

  it('applies late completion with no live renderer attached', () => {
    const h = setup();
    const oneShots = scriptedOneShots([{ hangUntilAbort: true }]);
    const plans = createPlans(oneShots.factory, (state) => store.onProgress(state));
    const store = new ProposalStore({
      tracerFor: h.tracerFor,
      projectIds: () => ['proj_a'],
      plans,
      broadcast: () => {},
      now: () => h.nowRef(),
      startRun: async () => ({ ok: false, issues: [] }),
    });
    const started = store.start(
      h.project,
      { prompt: 'late', model: 'inherit', reasoningEffort: 'medium' },
      h.services,
    );
    const planId = (started as { planId: string }).planId;
    expect(store.get(planId)?.status).toBe('generating');

    // Reconnect: a store with no live session for this id still lands the turn.
    const lonelyPlans = createPlans(scriptedOneShots([]).factory, () => {});
    const lonely = new ProposalStore({
      tracerFor: h.tracerFor,
      projectIds: () => ['proj_a'],
      plans: lonelyPlans,
      broadcast: () => {},
      now: () => h.nowRef(),
      startRun: async () => ({ ok: false, issues: [] }),
    });
    h.setNow(2000);
    const done: OrchestratorState = {
      planId,
      projectId: 'proj_a',
      status: 'done',
      model: 'inherit',
      reasoningEffort: 'medium',
      prompt: 'late',
      entries: [],
      plan: samplePlan(planId, 'proj_a'),
      rawReply: '{}',
      detail: 'plan ready',
      startedAt: 1000,
      messages: [],
      revision: 1,
    };
    lonely.onProgress(done);
    expect(lonely.get(planId)?.status).toBe('ready');
    expect(lonely.get(planId)?.plan?.refinedRequest).toContain('Improve the README');

    plans.cancelAll();
    lonelyPlans.cancelAll();
  });
});
