/**
 * Views derived from trace rows. Usage is not a column on `phases`: it lives in
 * the `agent_end` events, one per turn, so a phase that took three turns has
 * three of them. Summing here keeps the trace normalised and keeps a retry's
 * real cost visible instead of overwriting it.
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
  credits: 0,
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
    sum.credits += usage.credits ?? 0;
    // One reporting turn is enough to show real numbers for the phase.
    sum.reported = sum.reported || !!usage.reported;
  }
  sum.totalTokens =
    sum.inputTokens + sum.outputTokens + sum.cacheCreationTokens + sum.cacheReadTokens;
  return sum;
}

export function runDuration(run: RunRow, now = Date.now()): number | null {
  if (!run.startedAt) return null;
  const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
  return end - new Date(run.startedAt).getTime();
}

export function phaseDuration(phase: PhaseRow, now: number): number | null {
  if (!phase.startedAt) return null;
  const end = phase.endedAt ? new Date(phase.endedAt).getTime() : now;
  return end - new Date(phase.startedAt).getTime();
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
  engineer: 'checkpoint',
};

/**
 * Phase-kind hues. `agent` is per-agent, so callers pass the resolved owner
 * colour; `code` and `engineer` are fixed. Unknown kinds fall back to cyan.
 */
const KIND_COLOR: Record<string, string> = { code: 'var(--blue)', engineer: 'var(--amber)' };

export function phaseKindColor(kind: string, ownerColor: string): string {
  return kind === 'agent' ? ownerColor : (KIND_COLOR[kind] ?? 'var(--cyan)');
}
