import { describe, expect, it } from 'vitest';
import type {
  AgentReadyMarker,
  ReadinessInspectResult,
  ReadinessPhase,
  ReadinessState,
} from '../src/shared/types.js';
import { READINESS_CRITERION_IDS } from '../src/shared/types.js';
import {
  READINESS_CHECKING_MESSAGE,
  isReadinessLive,
  isReadinessTerminal,
  readinessBanner,
  readinessExitAction,
  readinessFailureNote,
} from '../src/renderer/readiness-view.js';

function marker(summary: string): AgentReadyMarker {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-13T00:00:00Z',
    commit: 'abc1234',
    agent: { harness: 'pi', model: 'inherit', reasoningEffort: 'high' },
    verdict: 'ready',
    summary,
    stack: { languages: ['swift'], monorepo: false, packages: [] },
    criteria: READINESS_CRITERION_IDS.map((id) => ({ id, status: 'pass' as const, notes: 'ok' })),
  };
}

function inspect(over: Partial<ReadinessInspectResult> = {}): ReadinessInspectResult {
  return {
    projectId: 'p1',
    markerValid: false,
    marker: null,
    markerDetail: 'missing .agents/agent-ready.json',
    skipped: false,
    validatedCache: false,
    ready: false,
    ...over,
  };
}

function state(over: Partial<ReadinessState> = {}): ReadinessState {
  return {
    sessionId: 's1',
    projectId: 'p1',
    phase: 'failed',
    model: 'inherit',
    reasoningEffort: 'high',
    marker: null,
    markerValid: false,
    markerDetail: '',
    evaluation: null,
    entries: [],
    pendingAsk: null,
    pr: null,
    mergeDetail: '',
    skipDetail: '',
    detail: '',
    startedAt: 0,
    ...over,
  };
}

describe('readiness phase classification', () => {
  const live: ReadinessPhase[] = [
    'inspecting',
    'evaluating',
    'remediating',
    'verifying',
    'confirming_merge',
    'finalizing',
  ];
  const terminal: ReadinessPhase[] = ['complete', 'skipped', 'failed'];

  it('treats every in-flight phase as live and none of them as terminal', () => {
    for (const phase of live) {
      expect(isReadinessLive(phase)).toBe(true);
      expect(isReadinessTerminal(phase)).toBe(false);
    }
  });

  it('treats settled phases as terminal so the banner re-inspects', () => {
    for (const phase of terminal) {
      expect(isReadinessTerminal(phase)).toBe(true);
      expect(isReadinessLive(phase)).toBe(false);
    }
  });

  it('leaves the pre-check phases out of both sets', () => {
    for (const phase of ['idle', 'confirming', 'not_ready'] as ReadinessPhase[]) {
      expect(isReadinessLive(phase)).toBe(false);
      expect(isReadinessTerminal(phase)).toBe(false);
    }
  });

  it('does not call waiting on the operator live', () => {
    // These wait on a human merging the PR for unbounded wall-clock time, so
    // claiming "checking" would hide the Check readiness button indefinitely.
    for (const phase of ['pr_ready', 'awaiting_merge'] as ReadinessPhase[]) {
      expect(isReadinessLive(phase)).toBe(false);
      expect(isReadinessTerminal(phase)).toBe(false);
    }
  });
});

describe('readinessExitAction', () => {
  const allPhases: ReadinessPhase[] = [
    'idle',
    'inspecting',
    'confirming',
    'evaluating',
    'not_ready',
    'remediating',
    'verifying',
    'pr_ready',
    'awaiting_merge',
    'confirming_merge',
    'finalizing',
    'complete',
    'skipped',
    'failed',
  ];

  it('gives every phase a visible cancel or close action', () => {
    for (const phase of allPhases) {
      const exit = readinessExitAction(phase);
      expect(['cancel', 'close']).toContain(exit.kind);
      expect(exit.label).toBe(exit.kind === 'cancel' ? 'Cancel' : 'Close');
    }
  });

  it('cancels in-flight work instead of leaving it running behind a closed modal', () => {
    for (const phase of [
      'inspecting',
      'evaluating',
      'remediating',
      'verifying',
      'confirming_merge',
      'finalizing',
    ] as ReadinessPhase[]) {
      expect(readinessExitAction(phase)).toEqual({ kind: 'cancel', label: 'Cancel' });
    }
  });

  it('closes waiting and settled phases without cancelling', () => {
    for (const phase of [
      'idle',
      'confirming',
      'not_ready',
      'pr_ready',
      'awaiting_merge',
      'complete',
      'skipped',
      'failed',
    ] as ReadinessPhase[]) {
      expect(readinessExitAction(phase)).toEqual({ kind: 'close', label: 'Close' });
    }
  });
});

describe('readinessFailureNote', () => {
  it('surfaces a verification failure', () => {
    const note = readinessFailureNote(
      state({ failedPhase: 'verifying', detail: 'Verification still failing: tests' }),
    );
    expect(note).toBe('Verification still failing: tests');
  });

  it('surfaces a finalization failure', () => {
    const note = readinessFailureNote(
      state({ failedPhase: 'finalizing', detail: 'not committed on main' }),
    );
    expect(note).toBe('not committed on main');
  });

  it('says nothing for a cancelled session', () => {
    // cancel() fails from whatever phase was running and sets detail to
    // "cancelled"; that word is not an explanation of repository readiness.
    expect(readinessFailureNote(state({ failedPhase: 'evaluating', detail: 'cancelled' }))).toBe(
      '',
    );
  });

  it('says nothing for a remediation failure', () => {
    expect(
      readinessFailureNote(state({ failedPhase: 'remediating', detail: 'agent gave up' })),
    ).toBe('');
  });

  it('says nothing for a non-failed session', () => {
    expect(readinessFailureNote(state({ phase: 'complete', detail: 'Ready.' }))).toBe('');
    expect(readinessFailureNote(state({ phase: 'skipped', detail: 'skipped' }))).toBe('');
  });

  it('says nothing when no failed phase was recorded', () => {
    expect(readinessFailureNote(state({ detail: 'something' }))).toBe('');
  });
});

describe('readinessBanner', () => {
  it('shows the marker summary and offers no action when ready', () => {
    const banner = readinessBanner(
      inspect({ ready: true, markerValid: true, marker: marker('Swift package is ready.') }),
    );
    expect(banner.tone).toBe('ready');
    expect(banner.message).toBe('Swift package is ready.');
    expect(banner.action).toBeNull();
  });

  it('falls back to generic ready copy when the marker has no summary', () => {
    const bare = { ...marker('x'), summary: '' } as AgentReadyMarker;
    const banner = readinessBanner(inspect({ ready: true, markerValid: true, marker: bare }));
    expect(banner.message).toBe('This project is agent-ready.');
  });

  it('offers Check readiness when not ready', () => {
    const banner = readinessBanner(inspect());
    expect(banner.tone).toBe('warn');
    expect(banner.action).toBe('Check readiness');
    expect(banner.message).toMatch(/not agent-ready/);
  });

  it('offers Re-run readiness once the project was skipped', () => {
    expect(readinessBanner(inspect({ skipped: true })).action).toBe('Re-run readiness');
  });

  it('holds a checking state that outranks a stale ready verdict', () => {
    const banner = readinessBanner(
      inspect({ ready: true, markerValid: true, marker: marker('Ready.') }),
      { checking: true },
    );
    expect(banner.message).toBe(READINESS_CHECKING_MESSAGE);
    expect(banner.tone).toBe('warn');
    expect(banner.action).toBeNull();
  });

  it('surfaces the failure detail from a failed session instead of generic copy', () => {
    const banner = readinessBanner(inspect(), {
      note: '.agents/agent-ready.json is not committed on main',
    });
    expect(banner.message).toBe('.agents/agent-ready.json is not committed on main');
    expect(banner.action).toBe('Check readiness');
  });

  it('ignores a blank note', () => {
    expect(readinessBanner(inspect(), { note: '   ' }).message).toMatch(/not agent-ready/);
  });
});
