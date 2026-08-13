/**
 * Readiness derivation for the Runs banner.
 *
 * The banner and the readiness modal read different things: the modal renders
 * the live session, the banner renders `readiness:inspect` (the marker as
 * committed on the project's base ref). They only agree if the banner
 * re-inspects when a session reaches a terminal phase, so the rules for "is
 * this session still moving" and "what should the banner say" live here, where
 * they can be tested without a DOM.
 */

import type { ReadinessInspectResult, ReadinessPhase } from '@shared/types.js';

const LIVE_PHASES = new Set<ReadinessPhase>([
  'inspecting',
  'evaluating',
  'remediating',
  'verifying',
  'pr_ready',
  'awaiting_merge',
  'confirming_merge',
  'finalizing',
]);

const TERMINAL_PHASES = new Set<ReadinessPhase>(['complete', 'skipped', 'failed']);

/** A session that has not settled yet, so the banner shows progress not a verdict. */
export function isReadinessLive(phase: ReadinessPhase): boolean {
  return LIVE_PHASES.has(phase);
}

/** A settled session: the banner must re-inspect rather than trust its old answer. */
export function isReadinessTerminal(phase: ReadinessPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export interface ReadinessBanner {
  tone: 'ready' | 'warn';
  message: string;
  /** Null while a check is running: re-triggering it would be noise. */
  action: string | null;
}

export const READINESS_CHECKING_MESSAGE = 'Checking whether this repository is agent-ready…';

const NOT_READY_MESSAGE =
  'This project is not agent-ready. Pipeline runs may fail mid-flight until the checklist is green.';

/**
 * `note` carries the failure detail from a terminal `failed` session so the
 * banner can say why validation could not be confirmed rather than repeating
 * the generic not-ready copy.
 */
export function readinessBanner(
  inspect: ReadinessInspectResult,
  opts: { checking?: boolean; note?: string } = {},
): ReadinessBanner {
  if (opts.checking) {
    return { tone: 'warn', message: READINESS_CHECKING_MESSAGE, action: null };
  }
  if (inspect.ready) {
    return {
      tone: 'ready',
      message: inspect.marker?.summary || 'This project is agent-ready.',
      action: null,
    };
  }
  return {
    tone: 'warn',
    message: opts.note?.trim() || NOT_READY_MESSAGE,
    action: inspect.skipped ? 'Re-run readiness' : 'Check readiness',
  };
}
