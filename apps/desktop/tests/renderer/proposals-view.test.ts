/**
 * Durable parallel proposals, renderer slice: ordering, concurrent
 * submissions, cancellation/discard races, late completion, and empty/failed
 * states. Pure view-model helpers — no DOM, no model, no IPC.
 */
import { describe, expect, it } from 'vitest';
import type { ProposalSnapshot } from '@shared/types.js';
import type { OrchestratorState } from '@shared/ipc-contract.js';
import {
  applyProposalProgress,
  proposalTitle,
  sortProposals,
} from '@renderer/view-models/proposals-view.js';

function proposal(over: Partial<ProposalSnapshot> = {}): ProposalSnapshot {
  return {
    planId: 'plan_1',
    projectId: 'proj_a',
    prompt: 'do the thing',
    model: 'fixture/model',
    reasoningEffort: 'medium',
    status: 'generating',
    detail: 'planning',
    entries: [],
    plan: null,
    rawReply: '',
    messages: [],
    revision: 0,
    acceptedRunId: null,
    acceptedPlan: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

function liveState(over: Partial<OrchestratorState> = {}): OrchestratorState {
  return {
    planId: 'plan_1',
    projectId: 'proj_a',
    status: 'running',
    model: 'fixture/model',
    reasoningEffort: 'medium',
    prompt: 'do the thing',
    entries: [],
    plan: null,
    rawReply: '',
    detail: 'working',
    startedAt: 1_000,
    messages: [],
    revision: 0,
    ...over,
  };
}

describe('sortProposals', () => {
  it('orders newest first so concurrent submissions never reorder siblings', () => {
    const rows = [
      proposal({ planId: 'first', createdAt: 100 }),
      proposal({ planId: 'third', createdAt: 300 }),
      proposal({ planId: 'second', createdAt: 200 }),
    ];
    expect(sortProposals(rows).map((p) => p.planId)).toEqual(['third', 'second', 'first']);
    // The input is not mutated: a second submit appends without disturbing order.
    expect(rows.map((p) => p.planId)).toEqual(['first', 'third', 'second']);
  });

  it('returns [] for the empty state', () => {
    expect(sortProposals([])).toEqual([]);
  });
});

describe('applyProposalProgress', () => {
  it('patches only the matching proposal, leaving concurrent siblings untouched', () => {
    const rows = [
      proposal({ planId: 'plan_a', detail: 'a-working' }),
      proposal({ planId: 'plan_b', detail: 'b-working' }),
    ];
    const next = applyProposalProgress(
      rows,
      liveState({ planId: 'plan_a', detail: 'a-still-working' }),
    );
    expect(next.find((p) => p.planId === 'plan_a')?.detail).toBe('a-still-working');
    expect(next.find((p) => p.planId === 'plan_b')?.detail).toBe('b-working');
    expect(next).toHaveLength(2);
  });

  it('marks done-with-plan as ready and done-without-plan as failed', () => {
    const ready = applyProposalProgress(
      [proposal()],
      liveState({ status: 'done', detail: 'Plan ready.', plan: { planId: 'plan_1' } as never }),
    );
    expect(ready[0]?.status).toBe('ready');
    const failed = applyProposalProgress([proposal()], liveState({ status: 'done' }));
    expect(failed[0]?.status).toBe('failed');
  });

  it('drops late completion after cancel or discard (cancellation/discard race)', () => {
    for (const frozen of ['cancelled', 'discarded', 'accepted'] as const) {
      const rows = [proposal({ status: frozen, detail: 'settled' })];
      const next = applyProposalProgress(
        rows,
        liveState({ status: 'done', detail: 'late plan', plan: { planId: 'plan_1' } as never }),
      );
      expect(next[0]?.status).toBe(frozen);
      expect(next[0]?.detail).toBe('settled');
    }
  });

  it('inserts a late completion for an unknown planId (reload/reconnect recovery)', () => {
    const next = applyProposalProgress(
      [],
      liveState({
        planId: 'plan_late',
        status: 'done',
        detail: 'Plan ready.',
        plan: { planId: 'plan_late' } as never,
        revision: 1,
      }),
    );
    expect(next.map((p) => p.planId)).toEqual(['plan_late']);
    expect(next[0]?.status).toBe('ready');
  });

  it('keeps the plan standing during a follow-up reply (running with a plan)', () => {
    const plan = { planId: 'plan_1' } as never;
    const rows = [proposal({ status: 'ready', plan })];
    const next = applyProposalProgress([rows[0]!], liveState({ status: 'running', plan }));
    expect(next[0]?.plan).toBe(plan);
    expect(next[0]?.status).toBe('generating');
  });
});

describe('proposalTitle', () => {
  it('uses the first prompt line and truncates long prompts', () => {
    expect(proposalTitle(proposal({ prompt: '  first line\nsecond line  ' }))).toBe('first line');
    const long = proposalTitle(proposal({ prompt: `x`.repeat(200) }), 80);
    expect(long).toHaveLength(80);
    expect(long.endsWith('…')).toBe(true);
  });

  it('falls back to detail, then to a stable label for empty states', () => {
    expect(proposalTitle(proposal({ prompt: '  ', detail: 'reading the repo' }))).toBe(
      'reading the repo',
    );
    expect(proposalTitle(proposal({ prompt: '', detail: '' }))).toBe('Orchestrator proposal');
  });
});
