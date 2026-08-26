/**
 * Views derived from trace rows. Usage is not a column on `phases`: it lives in
 * the `agent_end` events, one per turn, so a phase that took three turns has
 * three of them. Summing here keeps the trace normalised and keeps a retry's
 * real usage visible instead of overwriting it.
 */

import type { EventRow, PhaseRow, RunRow, UsageBreakdown } from '@shared/types.js';

export interface PhaseUsage extends UsageBreakdown {
  totalTokens: number;
  turns: number;
}

const EMPTY: PhaseUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  thinkingTokens: 0,
  reported: false,
  totalTokens: 0,
  turns: 0,
};

export function usageFor(events: EventRow[]): PhaseUsage {
  const turns = events.filter((e) => e.type === 'agent_end');
  if (!turns.length) return { ...EMPTY };

  const sum = { ...EMPTY, turns: turns.length };
  for (const event of turns) {
    const usage = event.payload.usage as UsageBreakdown | undefined;
    if (!usage) continue;
    sum.inputTokens += usage.inputTokens ?? 0;
    sum.outputTokens += usage.outputTokens ?? 0;
    sum.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
    sum.cacheReadTokens += usage.cacheReadTokens ?? 0;
    sum.thinkingTokens += usage.thinkingTokens ?? 0;
    // One reporting turn is enough to show real numbers for the phase.
    sum.reported = sum.reported || !!usage.reported;
  }
  sum.totalTokens =
    sum.inputTokens + sum.outputTokens + sum.cacheCreationTokens + sum.cacheReadTokens;
  return sum;
}

/** Elapsed time of a span, measured to `now` while it is still open. */
function elapsed(startedAt: string | null, endedAt: string | null, now: number): number | null {
  if (!startedAt) return null;
  const end = endedAt ? new Date(endedAt).getTime() : now;
  return end - new Date(startedAt).getTime();
}

export function runDuration(run: RunRow, now = Date.now()): number | null {
  return elapsed(run.startedAt, run.endedAt, now);
}

export function phaseDuration(phase: PhaseRow, now: number): number | null {
  return elapsed(phase.startedAt, phase.endedAt, now);
}

/** The model a phase actually ran on, recorded when its agent session opened. */
export function modelFor(events: EventRow[]): string | null {
  const start = events.find((e) => e.type === 'agent_start');
  return (start?.payload.model as string | undefined) ?? null;
}

/**
 * Phase-kind labels for consistent UI display across ribbon, phase list, and inspectors.
 */
export const KIND_LABEL: Record<string, string> = {
  agent: 'agent',
  code: 'command',
};

/**
 * Phase-kind hues. `agent` is per-agent, so callers pass the resolved owner
 * colour; `code` is fixed. Unknown kinds fall back to cyan.
 */
const KIND_COLOR: Record<string, string> = { code: 'var(--blue)' };

export function phaseKindColor(kind: string, ownerColor: string): string {
  return kind === 'agent' ? ownerColor : (KIND_COLOR[kind] ?? 'var(--accent)');
}

/**
 * Auto-allow policy verdicts. Older runs recorded one `interrupt` per tool
 * call (`allow (policy)`), which doubled the Inspector. New runs no longer
 * write them; views still drop leftovers so a reopened trace stays readable.
 */
export function isAutoAllowPolicy(event: EventRow): boolean {
  return (
    event.type === 'interrupt' && event.payload.auto === true && event.name === 'allow (policy)'
  );
}
