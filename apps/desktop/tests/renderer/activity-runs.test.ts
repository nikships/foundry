/**
 * Sidebar Activity keeps only the selected project's live runs plus a short
 * recency cap of finished ones. The helper is pure so the filter can be
 * asserted without mounting React.
 */

import { describe, expect, it } from 'vitest';
import type { RunRow } from '@shared/types.js';
import { selectActivityRuns } from '@renderer/view-models/activity-runs.js';

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
