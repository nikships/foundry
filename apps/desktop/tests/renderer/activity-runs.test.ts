/**
 * Sidebar Activity keeps only the selected project's live runs plus a short
 * recency cap of finished ones. The helper is pure so the filter can be
 * asserted without mounting React.
 */

import { describe, expect, it } from 'vitest';
import type { ProposalSnapshot, RunRow } from '@shared/types.js';
import {
  selectActivityItems,
  selectActivityRuns,
  type ActivityItem,
} from '@renderer/view-models/activity-runs.js';

function run(over: Partial<RunRow> = {}): RunRow {
  return {
    runId: 'run_1',
    projectId: 'proj_a',
    pipelineId: 'p',
    pipelineName: 'p',
    request: 'do the thing',
    status: 'accepted',
    engineer: 'test',
    worktreePath: '/tmp/foundry-worktree',
    branch: 'foundry/run_1',
    baseRef: 'main',
    branchPointSha: 'abc123',
    outcomeDetail: null,
    prNumber: null,
    prUrl: null,
    issueNumber: null,
    issueUrl: null,
    source: null,
    sourceSyncError: null,
    merged: false,
    archived: false,
    mode: 'pi',
    orchestrated: false,
    amendments: 0,
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    totalTokens: 0,
    ...over,
  };
}

describe('selectActivityRuns', () => {
  it('returns no rows when no project is selected, even if runs exist', () => {
    const rows = [run({ runId: 'live', status: 'running', endedAt: null })];
    expect(selectActivityRuns(rows, '')).toEqual([]);
  });

  it('keeps only the selected project’s live then recent finished runs', () => {
    const rows = [
      run({
        runId: 'a-old-live',
        projectId: 'proj_a',
        status: 'running',
        startedAt: '2026-01-01T10:00:00.000Z',
        endedAt: null,
      }),
      run({
        runId: 'a-new-live',
        projectId: 'proj_a',
        status: 'running',
        startedAt: '2026-01-01T11:00:00.000Z',
        endedAt: null,
      }),
      run({
        runId: 'a-old-done',
        projectId: 'proj_a',
        status: 'accepted',
        startedAt: '2026-01-01T08:00:00.000Z',
        endedAt: '2026-01-01T08:10:00.000Z',
      }),
      run({
        runId: 'a-new-done',
        projectId: 'proj_a',
        status: 'failed',
        startedAt: '2026-01-01T09:00:00.000Z',
        endedAt: '2026-01-01T09:10:00.000Z',
      }),
      run({
        runId: 'b-live',
        projectId: 'proj_b',
        status: 'running',
        startedAt: '2026-01-01T12:00:00.000Z',
        endedAt: null,
      }),
      run({
        runId: 'b-done',
        projectId: 'proj_b',
        status: 'accepted',
        startedAt: '2026-01-01T09:30:00.000Z',
        endedAt: '2026-01-01T09:40:00.000Z',
      }),
    ];

    expect(selectActivityRuns(rows, 'proj_a').map((r) => r.runId)).toEqual([
      'a-new-live',
      'a-old-live',
      'a-new-done',
      'a-old-done',
    ]);
    expect(selectActivityRuns(rows, 'proj_b').map((r) => r.runId)).toEqual(['b-live', 'b-done']);
  });

  it('does not show a live run from a non-selected project', () => {
    const rows = [
      run({
        runId: 'other-live',
        projectId: 'proj_b',
        status: 'running',
        startedAt: '2026-01-01T12:00:00.000Z',
        endedAt: null,
      }),
      run({
        runId: 'mine-done',
        projectId: 'proj_a',
        status: 'accepted',
        startedAt: '2026-01-01T09:00:00.000Z',
        endedAt: '2026-01-01T09:10:00.000Z',
      }),
    ];
    expect(selectActivityRuns(rows, 'proj_a').map((r) => r.runId)).toEqual(['mine-done']);
  });

  it('caps finished runs at the five newest by endedAt or startedAt', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      run({
        runId: `done-${i}`,
        projectId: 'proj_a',
        status: 'accepted',
        startedAt: `2026-01-01T0${i}:00:00.000Z`,
        endedAt: `2026-01-01T0${i}:10:00.000Z`,
      }),
    );
    expect(selectActivityRuns(rows, 'proj_a').map((r) => r.runId)).toEqual([
      'done-6',
      'done-5',
      'done-4',
      'done-3',
      'done-2',
    ]);
  });

  it('keeps every live run in the selected project, ahead of finished', () => {
    const rows = [
      run({
        runId: 'done',
        projectId: 'proj_a',
        status: 'accepted',
        startedAt: '2026-01-01T20:00:00.000Z',
        endedAt: '2026-01-01T20:10:00.000Z',
      }),
      ...Array.from({ length: 6 }, (_, i) =>
        run({
          runId: `live-${i}`,
          projectId: 'proj_a',
          status: 'running',
          startedAt: `2026-01-01T1${i}:00:00.000Z`,
          endedAt: null,
        }),
      ),
    ];
    expect(selectActivityRuns(rows, 'proj_a').map((r) => r.runId)).toEqual([
      'live-5',
      'live-4',
      'live-3',
      'live-2',
      'live-1',
      'live-0',
      'done',
    ]);
  });

  it('honours a custom recentLimit', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      run({
        runId: `done-${i}`,
        projectId: 'proj_a',
        status: 'accepted',
        startedAt: `2026-01-01T0${i}:00:00.000Z`,
        endedAt: null,
      }),
    );
    expect(selectActivityRuns(rows, 'proj_a', 2).map((r) => r.runId)).toEqual(['done-3', 'done-2']);
  });
});

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

function itemKey(item: ActivityItem): string {
  return item.kind === 'run' ? `run:${item.run.runId}` : `proposal:${item.proposal.planId}`;
}

describe('selectActivityItems', () => {
  it('returns [] for an empty project selection', () => {
    expect(
      selectActivityItems(
        [run({ runId: 'live', status: 'running', endedAt: null })],
        [proposal({ planId: 'plan_x' })],
        '',
      ),
    ).toEqual([]);
  });

  it('shows generating, ready, and failed proposals before any run exists', () => {
    const items = selectActivityItems(
      [],
      [
        proposal({ planId: 'plan_gen', status: 'generating', createdAt: 300, updatedAt: 300 }),
        proposal({ planId: 'plan_ready', status: 'ready', createdAt: 100, updatedAt: 200 }),
        proposal({ planId: 'plan_failed', status: 'failed', createdAt: 200, updatedAt: 250 }),
      ],
      'proj_a',
    );
    expect(items.map(itemKey)).toEqual([
      'proposal:plan_gen',
      'proposal:plan_failed',
      'proposal:plan_ready',
    ]);
  });

  it('orders generating proposals, live runs, settled proposals, then finished runs', () => {
    const items = selectActivityItems(
      [
        run({
          runId: 'done',
          status: 'accepted',
          startedAt: '2026-01-01T20:00:00.000Z',
          endedAt: '2026-01-01T20:10:00.000Z',
        }),
        run({
          runId: 'live',
          status: 'running',
          startedAt: '2026-01-01T19:00:00.000Z',
          endedAt: null,
        }),
      ],
      [
        proposal({ planId: 'gen_new', status: 'generating', createdAt: 500, updatedAt: 500 }),
        proposal({ planId: 'gen_old', status: 'generating', createdAt: 400, updatedAt: 400 }),
        proposal({ planId: 'ready', status: 'ready', createdAt: 100, updatedAt: 300 }),
        proposal({ planId: 'failed', status: 'failed', createdAt: 200, updatedAt: 350 }),
      ],
      'proj_a',
    );
    expect(items.map(itemKey)).toEqual([
      'proposal:gen_new',
      'proposal:gen_old',
      'run:live',
      'proposal:failed',
      'proposal:ready',
      'run:done',
    ]);
  });

  it('puts ready before failed at equal timestamps and excludes other projects', () => {
    const items = selectActivityItems(
      [run({ runId: 'b-live', projectId: 'proj_b', status: 'running', endedAt: null })],
      [
        proposal({ planId: 'a_ready', status: 'ready', updatedAt: 900, createdAt: 100 }),
        proposal({ planId: 'a_failed', status: 'failed', updatedAt: 900, createdAt: 200 }),
        proposal({ planId: 'b_gen', projectId: 'proj_b', status: 'generating' }),
      ],
      'proj_a',
    );
    expect(items.map(itemKey)).toEqual(['proposal:a_ready', 'proposal:a_failed']);
  });

  it('hides cancelled, accepted, and discarded proposals from the sidebar', () => {
    const items = selectActivityItems(
      [],
      [
        proposal({ planId: 'c', status: 'cancelled' }),
        proposal({ planId: 'a', status: 'accepted' }),
        proposal({ planId: 'd', status: 'discarded' }),
        proposal({ planId: 'g', status: 'generating' }),
      ],
      'proj_a',
    );
    expect(items.map(itemKey)).toEqual(['proposal:g']);
  });

  it('caps finished runs while keeping every live run and proposal', () => {
    const finished = Array.from({ length: 7 }, (_, i) =>
      run({
        runId: `done-${i}`,
        status: 'accepted',
        startedAt: `2026-01-01T0${i}:00:00.000Z`,
        endedAt: `2026-01-01T0${i}:10:00.000Z`,
      }),
    );
    const items = selectActivityItems(
      finished,
      [proposal({ planId: 'gen', status: 'generating' })],
      'proj_a',
      2,
    );
    expect(items.map(itemKey)).toEqual(['proposal:gen', 'run:done-6', 'run:done-5']);
  });
});
