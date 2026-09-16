/**
 * Readiness derivation for the Runs screen.
 *
 * The tab and the readiness panel read different things: the panel renders
 * the live session, the tab glow renders `readiness:inspect` (the marker as
 * committed on the project's base ref). They only agree if the panel
 * re-inspects when a session reaches a terminal phase, so the rules for "is
 * this session still moving" and "what should the tab show" live here, where
 * they can be tested without a DOM.
 */

import type {
  ReadinessCriterion,
  ReadinessInspectResult,
  ReadinessPhase,
  ReadinessState,
} from '@shared/types.js';

/**
 * In-flight work. `ReadinessPanel` and the Runs tab share this set.
 * `pr_ready` and `awaiting_merge` wait on the operator to merge, not on work
 * in flight — calling those "checking" would claim progress for unbounded
 * wall-clock time while hiding the button that starts a check.
 */
const LIVE_PHASES = new Set<ReadinessPhase>([
  'inspecting',
  'evaluating',
  'remediating',
  'verifying',
  'confirming_merge',
  'finalizing',
]);

const TERMINAL_PHASES = new Set<ReadinessPhase>(['complete', 'skipped', 'failed']);

/** Parked after verify: worktree is kept, waiting on Continue or Start over. */
export function isReadinessNeedsContinue(phase: ReadinessPhase): boolean {
  return phase === 'needs_continue';
}

/** A session that has not settled yet, so the tab shows progress not a verdict. */
export function isReadinessLive(phase: ReadinessPhase): boolean {
  return LIVE_PHASES.has(phase);
}

/** A settled session: the tab must re-inspect rather than trust its old answer. */
export function isReadinessTerminal(phase: ReadinessPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

export type ReadinessExitAction = {
  kind: 'cancel' | 'close';
  label: 'Cancel' | 'Close';
};

/**
 * The readiness modal is not backdrop-dismissible, so every phase needs a
 * visible exit. In-flight work is cancelled on the way out; waiting and
 * settled phases just close. Skip, Retry, and OK stay separate actions.
 */
export function readinessExitAction(phase: ReadinessPhase): ReadinessExitAction {
  return isReadinessLive(phase)
    ? { kind: 'cancel', label: 'Cancel' }
    : { kind: 'close', label: 'Close' };
}

/**
 * The phases whose failure detail explains why readiness could not be
 * confirmed. A session can also end `failed` because the operator cancelled or
 * the remediating agent gave up; neither says anything about the repository, and
 * `cancel()` sets the detail to the bare word "cancelled", which would otherwise
 * become the panel's entire message.
 */
const VALIDATION_PHASES = new Set<ReadinessPhase>(['verifying', 'finalizing']);

/** The tab note for a settled session, or '' when it has nothing to add. */
export function readinessFailureNote(state: ReadinessState): string {
  if (state.phase === 'needs_continue') return state.detail;
  const explains = state.failedPhase != null && VALIDATION_PHASES.has(state.failedPhase);
  return state.phase === 'failed' && explains ? state.detail : '';
}

export interface ReadinessTab {
  /** True once the marker is valid on the base ref: no glow needed. */
  ready: boolean;
  /** True while a check is running: re-triggering it would be noise. */
  checking: boolean;
  message: string;
  /** Null while a check is running: re-triggering it would be noise. */
  action: string | null;
}

export const READINESS_CHECKING_MESSAGE = 'Checking whether this repository is agent-ready…';

export const READINESS_NOT_READY_MESSAGE =
  'This project is not agent-ready. Pipeline runs may fail mid-flight until the checklist is green.';

/**
 * `note` carries the failure detail from a terminal `failed` session so the
 * tab can say why validation could not be confirmed rather than repeating
 * the generic not-ready copy.
 */
export function readinessTab(
  inspect: ReadinessInspectResult,
  opts: { checking?: boolean; note?: string } = {},
): ReadinessTab {
  if (opts.checking) {
    return {
      ready: false,
      checking: true,
      message: READINESS_CHECKING_MESSAGE,
      action: null,
    };
  }
  if (inspect.ready) {
    return {
      ready: true,
      checking: false,
      message: inspect.marker?.summary || 'This project is agent-ready.',
      action: null,
    };
  }
  return {
    ready: false,
    checking: false,
    message: opts.note?.trim() || READINESS_NOT_READY_MESSAGE,
    action: inspect.skipped ? 'Re-run readiness' : 'Check readiness',
  };
}

/**
 * The Runs tab glows red only for a verdict the operator has to act on.
 * A ready project is the normal case and earns no glow; an in-flight check
 * is progress, not a problem.
 */
export function showReadinessAlert(tab: ReadinessTab): boolean {
  return !tab.ready && !tab.checking;
}

/** Human label for each checklist criterion id, falling back to the raw id. */
export const READINESS_CRITERION_LABELS: Record<string, string> = {
  lint_format: 'Lint & format',
  typecheck: 'Typecheck',
  tests: 'Tests',
  build: 'Build',
  setup: 'Setup',
  agents_md: 'AGENTS.md',
  env_example: 'Env example',
  ci_parity: 'CI parity',
  templates: 'Templates',
  precommit: 'Pre-commit',
  coverage: 'Coverage',
};

export interface ReadinessScore {
  pass: number;
  fail: number;
  total: number;
  /** Null until a session or marker produces a checklist to count. */
  percent: number | null;
}

/** Counts pass and N/A as green: N/A is a recorded adaptation, not a gap. */
export function readinessScore(criteria: ReadonlyArray<ReadinessCriterion>): ReadinessScore {
  const pass = criteria.filter((c) => c.status === 'pass' || c.status === 'n/a').length;
  const fail = criteria.filter((c) => c.status === 'fail').length;
  const total = criteria.length;
  return {
    pass,
    fail,
    total,
    percent: total === 0 ? null : Math.round((pass / total) * 100),
  };
}
