/**
 * Concurrent proposal sessions: two starts never cancel siblings.
 *
 * Real `createPlans` + `ProposalStore` over a temp DB, no Electron. The model
 * turns hang so both sessions stay live; completion of one is injected via
 * `onProgress` (the same path a late model turn takes), proving the other
 * stays `generating` and both rows remain independently visible.
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

describe('concurrent proposal generation', () => {
  it('starts two proposals without cancelling either and completes independently', async () => {
    const support = tempDir('foundry-proposals-conc-');
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
    const broadcasts: Array<{ channel: string; payload?: unknown }> = [];
    const oneShots = scriptedOneShots([{ hangUntilAbort: true }, { hangUntilAbort: true }]);

    const project = { id: 'proj_a', path: '/tmp/repo', contextSummary: '', commands: [] };
    const services = {
      rosterFor: () => [],
      envelopeDefs: [],
      defaultModel: 'inherit',
      enabledModels: async () => [],
      ghAvailable: async () => false,
    };

    // Live turns persist through the store (what `context` wires). The closure
    // runs async after both bindings exist, so the forward reference is safe.
    const livePlans = createPlans(oneShots.factory, (state) => liveStore.onProgress(state));
    const liveStore = new ProposalStore({
      tracerFor,
      projectIds: () => ['proj_a'],
      plans: livePlans,
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      now: () => now,
      startRun: async () => ({ ok: false, issues: [] }),
    });

    const first = liveStore.start(
      project,
      { prompt: 'first', model: 'inherit', reasoningEffort: 'medium' },
      services,
    );
    const second = liveStore.start(
      project,
      { prompt: 'second', model: 'inherit', reasoningEffort: 'medium' },
      services,
    );
    expect('planId' in first && 'planId' in second).toBe(true);
    const firstId = (first as { planId: string }).planId;
    const secondId = (second as { planId: string }).planId;
    expect(firstId).not.toBe(secondId);

    // Both durable rows exist immediately, before any run, and neither live
    // turn cancelled the other.
    expect(liveStore.get(firstId)?.status).toBe('generating');
    expect(liveStore.get(secondId)?.status).toBe('generating');
    expect(livePlans.get(firstId)?.status).toBe('running');
    expect(livePlans.get(secondId)?.status).toBe('running');

    // Complete the first via the progress path (late completion shape).
    now = 2000;
    const live = livePlans.get(firstId) as OrchestratorState;
    const done: OrchestratorState = {
      ...live,
      status: 'done',
      detail: 'plan ready',
      plan: samplePlan(firstId, 'proj_a'),
      rawReply: '{"ok":true}',
      revision: 1,
    };
    liveStore.onProgress(done);

    expect(liveStore.get(firstId)?.status).toBe('ready');
    expect(liveStore.get(firstId)?.plan?.refinedRequest).toContain('Improve the README');
    // The sibling is untouched.
    expect(liveStore.get(secondId)?.status).toBe('generating');
    expect(livePlans.get(secondId)?.status).toBe('running');

    // List stays newest-first by updated_at: the just-completed row leads.
    now = 3000;
    const listed = liveStore.list('proj_a');
    expect(listed.map((row) => row.planId)).toEqual([firstId, secondId]);

    // Proposals-changed fired for starts and completion; orchestrator-progress
    // still flows for live turns.
    expect(broadcasts.some((b) => b.channel === 'event:proposals-changed')).toBe(true);

    livePlans.cancelAll();
  });
});
