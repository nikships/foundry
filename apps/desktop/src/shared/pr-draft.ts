/**
 * Pure helpers for the manual "Open PR…" form and the companion confirm sheet.
 *
 * Pipelines without a PR phase keep the raw request/outcome draft. When a
 * valid `pr` envelope exists (automatic creation failed after the writer
 * succeeded), the form uses that title/body instead.
 *
 * Lives in shared so the desktop form, `createRunPr`, and GET /pr-draft cannot
 * invent different titles.
 */

import type { EnvelopeRow, PhaseRow, RunRow } from './types.js';

export interface PrDraft {
  title: string;
  body: string;
}

export type PrDraftSource = 'pr-envelope' | 'run';

export interface ResolvedPrDraft extends PrDraft {
  source: PrDraftSource;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function defaultPrTitle(run: Pick<RunRow, 'pipelineName' | 'request'>): string {
  return `${run.pipelineName}: ${truncate(run.request, 64)}`;
}

export function defaultPrBody(
  run: Pick<RunRow, 'request' | 'outcomeDetail' | 'runId' | 'branch'>,
): string {
  const outcome = run.outcomeDetail ? `${run.outcomeDetail}\n\n` : '';
  return `${run.request}\n\n${outcome}---\nOpened by Foundry from run ${run.runId} (branch \`${run.branch ?? ''}\`).`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Title/body from a parsed PR envelope, or null when the payload is unusable. */
export function prDraftFromEnvelope(
  payload: Record<string, unknown> | undefined | null,
): PrDraft | null {
  if (!payload) return null;
  if (!isNonEmptyString(payload.title) || !isNonEmptyString(payload.body)) return null;
  return { title: payload.title.trim(), body: payload.body };
}

function latestEnvelope(rows: readonly EnvelopeRow[]): EnvelopeRow | undefined {
  if (rows.length === 0) return undefined;
  return [...rows]
    .sort((a, b) => {
      const byTime = a.createdAt.localeCompare(b.createdAt);
      if (byTime !== 0) return byTime;
      return a.attempt - b.attempt;
    })
    .at(-1);
}

/**
 * Prefer a valid `pr` envelope. If a phase is named `open_pr`, that phase
 * wins; otherwise the latest valid PR envelope on the run is used.
 */
export function selectPrEnvelope(
  envelopes: readonly EnvelopeRow[],
  phases: readonly PhaseRow[] = [],
): EnvelopeRow | undefined {
  const valid = envelopes.filter((row) => row.valid && row.schemaKind === 'pr');
  if (valid.length === 0) return undefined;
  const openPrPhaseIds = new Set(
    phases.filter((phase) => phase.name === 'open_pr').map((phase) => phase.phaseId),
  );
  const named = openPrPhaseIds.size ? valid.filter((row) => openPrPhaseIds.has(row.phaseId)) : [];
  return latestEnvelope(named.length ? named : valid);
}

/** Manual form draft: PR envelope when valid, otherwise the raw run prefill. */
export function manualPrDraft(
  run: Pick<RunRow, 'pipelineName' | 'request' | 'outcomeDetail' | 'runId' | 'branch'>,
  envelopes: readonly EnvelopeRow[],
  phases: readonly PhaseRow[] = [],
): ResolvedPrDraft {
  const fromEnvelope = prDraftFromEnvelope(selectPrEnvelope(envelopes, phases)?.payload);
  if (fromEnvelope) return { ...fromEnvelope, source: 'pr-envelope' };
  return { title: defaultPrTitle(run), body: defaultPrBody(run), source: 'run' };
}
