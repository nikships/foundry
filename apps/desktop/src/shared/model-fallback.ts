/**
 * Model failover warnings, shared by both processes.
 *
 * The mid-turn failover path (`main/pi/model-failover.ts`) emits one warning
 * per hop in the form `<failed> failed after 5 retries; continuing this turn
 * on <replacement>`. Both the trace writer and the agent displays read that
 * same sentence, so its parsing lives here rather than in two places that
 * could disagree about what counts as a fallback.
 */

import type { EventRow } from './types.js';

/** One mid-turn failover, with the sentence that announced it. */
export interface ModelFallback {
  /** The model that exhausted its retries on this hop. */
  failedModel: string;
  /** The model the turn continued on. */
  fallbackModel: string;
  /** The emitted warning text, verbatim. */
  message: string;
}

const FAILOVER_RE = /^(.+) failed after 5 retries; continuing this turn on (.+)$/;

/**
 * Parse one emitted failover warning. Returns null for any other model
 * warning (startup substitution, extension errors), so callers only treat a
 * mid-turn failover as a fallback display.
 */
export function parseModelFallbackWarning(message: unknown): ModelFallback | null {
  if (typeof message !== 'string') return null;
  const match = message.match(FAILOVER_RE);
  if (!match) return null;
  const failedModel = match[1]!.trim();
  const fallbackModel = match[2]!.trim();
  if (!failedModel || !fallbackModel) return null;
  return { failedModel, fallbackModel, message };
}

/**
 * Whether a trace row carries a failover warning, via the emitted sentence or
 * via structured failover fields. Structured fields win when both are present
 * because they survive any future copy change to the sentence.
 */
function fallbackInPayload(payload: Record<string, unknown>): ModelFallback | null {
  const failed = payload.failedModel;
  const fallback = payload.fallbackModel;
  if (typeof failed === 'string' && typeof fallback === 'string' && failed && fallback) {
    const message = payload.message;
    return {
      failedModel: failed,
      fallbackModel: fallback,
      message: typeof message === 'string' && message ? message : `${failed} → ${fallback}`,
    };
  }
  return parseModelFallbackWarning(payload.message);
}

/**
 * The active fallback for a phase's events, if any hop failed over.
 *
 * Multiple hops collapse to one display: the first failure names what was
 * lost and the last replacement names what is running, with every emitted
 * sentence preserved in order for the tooltip.
 */
export function modelFallbackForEvents(
  events: readonly Pick<EventRow, 'type' | 'name' | 'payload'>[],
): ModelFallback | null {
  const found: ModelFallback[] = [];
  for (const event of events) {
    if (event.type !== 'log') continue;
    if (!event.name.endsWith(': model')) continue;
    const parsed = fallbackInPayload(event.payload);
    if (parsed) found.push(parsed);
  }
  if (!found.length) return null;
  const first = found[0]!;
  const last = found[found.length - 1]!;
  return {
    failedModel: first.failedModel,
    fallbackModel: last.fallbackModel,
    message: found.map((entry) => entry.message).join('\n'),
  };
}
