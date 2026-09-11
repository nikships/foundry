import { describe, expect, it } from 'vitest';
import type { EnvelopeRow, PhaseRow } from '@shared/types.js';
import {
  defaultPrBody,
  defaultPrTitle,
  manualPrDraft,
  prDraftFromEnvelope,
  selectPrEnvelope,
} from '@renderer/view-models/pr-draft.js';

const run = {
  pipelineName: 'Plan → Build → Test',
  request: 'Add a settings selector for the PR writer.',
  outcomeDetail: 'Accepted: all phases passed',
  runId: 'run_abc123',
  branch: 'foundry/run_abc123',
};

function envelope(partial: Partial<EnvelopeRow> & Pick<EnvelopeRow, 'envelopeId'>): EnvelopeRow {
  return {
    runId: 'run_abc123',
    phaseId: 'phase_pr',
    agent: 'pr_writer',
    schemaKind: 'pr',
    payload: { title: 'Add PR writer setting', body: '## Summary\nShips the selector.' },
    valid: true,
    attempt: 1,
    createdAt: '2026-08-12T00:00:00.000Z',
    ...partial,
  };
}

function phase(partial: Partial<PhaseRow> & Pick<PhaseRow, 'phaseId' | 'name'>): PhaseRow {
  return {
    runId: 'run_abc123',
    seq: 1,
    kind: 'agent',
    owner: 'pr_writer',
    description: 'Open the pull request.',
    status: 'success',
    attempt: 1,
    error: null,
    startedAt: '2026-08-12T00:00:00.000Z',
    endedAt: '2026-08-12T00:01:00.000Z',
    ...partial,
  };
}

describe('default PR form prefill', () => {
  it('titles from the pipeline name and truncated request', () => {
    expect(defaultPrTitle(run)).toBe(
      'Plan → Build → Test: Add a settings selector for the PR writer.',
    );
  });

  it('bodies from the raw request and outcome, matching the current form', () => {
    expect(defaultPrBody(run)).toBe(
      [
        'Add a settings selector for the PR writer.',
        '',
        'Accepted: all phases passed',
        '',
        '---',
        'Opened by Foundry from run run_abc123 (branch `foundry/run_abc123`).',
      ].join('\n'),
    );
  });

  it('omits the outcome block when the run has none', () => {
    expect(defaultPrBody({ ...run, outcomeDetail: null })).toBe(
      [
        'Add a settings selector for the PR writer.',
        '',
        '---',
        'Opened by Foundry from run run_abc123 (branch `foundry/run_abc123`).',
      ].join('\n'),
    );
  });
});

describe('prDraftFromEnvelope', () => {
  it('reads a valid title and body', () => {
    expect(
      prDraftFromEnvelope({ title: '  Ship the writer  ', body: '## Summary\nDone.' }),
    ).toEqual({ title: 'Ship the writer', body: '## Summary\nDone.' });
  });

  it('rejects missing, blank, or non-string fields', () => {
    expect(prDraftFromEnvelope(undefined)).toBeNull();
    expect(prDraftFromEnvelope({})).toBeNull();
    expect(prDraftFromEnvelope({ title: 'Only title' })).toBeNull();
    expect(prDraftFromEnvelope({ title: '  ', body: 'body' })).toBeNull();
    expect(prDraftFromEnvelope({ title: 'title', body: 12 })).toBeNull();
  });
});

describe('selectPrEnvelope', () => {
  it('ignores invalid or non-pr envelopes', () => {
    expect(
      selectPrEnvelope([
        envelope({ envelopeId: 'review', schemaKind: 'review', valid: true }),
        envelope({ envelopeId: 'bad', valid: false }),
      ]),
    ).toBeUndefined();
  });

  it('picks the latest valid pr envelope', () => {
    const chosen = selectPrEnvelope([
      envelope({
        envelopeId: 'old',
        createdAt: '2026-08-12T00:00:00.000Z',
        payload: { title: 'Old', body: 'old' },
      }),
      envelope({
        envelopeId: 'new',
        createdAt: '2026-08-12T01:00:00.000Z',
        payload: { title: 'New', body: 'new' },
      }),
    ]);
    expect(chosen?.envelopeId).toBe('new');
  });

  it('prefers a valid envelope from the open_pr phase when one exists', () => {
    const chosen = selectPrEnvelope(
      [
        envelope({
          envelopeId: 'other',
          phaseId: 'phase_other',
          createdAt: '2026-08-12T02:00:00.000Z',
          payload: { title: 'Other', body: 'other' },
        }),
        envelope({
          envelopeId: 'named',
          phaseId: 'phase_open',
          createdAt: '2026-08-12T00:00:00.000Z',
          payload: { title: 'Named', body: 'named' },
        }),
      ],
      [phase({ phaseId: 'phase_open', name: 'open_pr' })],
    );
    expect(chosen?.envelopeId).toBe('named');
  });
});

describe('manualPrDraft', () => {
  it('keeps the raw request/outcome draft when no PR envelope exists', () => {
    const draft = manualPrDraft(run, [
      envelope({ envelopeId: 'review', schemaKind: 'review', valid: true }),
    ]);
    expect(draft.source).toBe('run');
    expect(draft.title).toBe(defaultPrTitle(run));
    expect(draft.body).toBe(defaultPrBody(run));
  });

  it('prefills from a valid PR envelope when automatic creation did not finish', () => {
    const draft = manualPrDraft(run, [
      envelope({
        envelopeId: 'pr',
        payload: { title: 'Add PR writer setting', body: '## Summary\nShips the selector.' },
      }),
    ]);
    expect(draft).toEqual({
      source: 'pr-envelope',
      title: 'Add PR writer setting',
      body: '## Summary\nShips the selector.',
    });
  });

  it('falls back to the raw draft when the PR envelope is invalid', () => {
    const draft = manualPrDraft(run, [
      envelope({
        envelopeId: 'pr',
        valid: false,
        payload: { title: 'Would have been used', body: 'ignored' },
      }),
    ]);
    expect(draft.source).toBe('run');
    expect(draft.title).toBe(defaultPrTitle(run));
  });
});
