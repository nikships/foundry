/**
 * Whether a settled run may be continued, and how.
 *
 * The decision is separated from `RunRegistry` because launching is the
 * expensive half: every caller that offers Continue (the desktop banner
 * through IPC, the Companion route, Smith's run tool) has to refuse for the
 * same reasons and in the same words, and a test must be able to ask the
 * question without opening a model.
 */

import { existsSync } from 'node:fs';
import type { ContinueStrategy, PhaseRow, PipelineDef, RunRow } from '@shared/types.js';
import { CONTINUE_STATUS_REFUSAL, continuableStatus, continueStrategyFor } from '@shared/types.js';
import { activeRowsForPipeline } from './phase-history.js';

export type ContinueEligibility =
  | { ok: true; strategy: ContinueStrategy; failedPhase: PhaseRow; pipeline: PipelineDef }
  | { ok: false; detail: string };

/**
 * Decides on the run's own record: its status, whether it landed, the pipeline
 * it was started from, and the latest row for each of that pipeline's phases.
 *
 * A killed run is continuable on the same terms as a rejected or failed one —
 * what differs is the strategy, which the executor reads to decide whether the
 * interrupted phase's agent reopens its conversation or starts a new one. That
 * needs the interrupted phase, so the status check that gates the search is
 * `continuableStatus` and the strategy is only settled once the phase is known.
 */
export function continueEligibility(input: {
  run: RunRow;
  pipeline: PipelineDef | null;
  phases: PhaseRow[];
  /** Injected so a test can answer for a path it never created. */
  worktreeExists?: (path: string) => boolean;
}): ContinueEligibility {
  const { run } = input;
  if (!continuableStatus(run.status)) return { ok: false, detail: CONTINUE_STATUS_REFUSAL };
  if (run.merged) return { ok: false, detail: 'a merged run cannot be continued' };

  const pipeline = input.pipeline;
  if (!pipeline?.phases?.length || pipeline.id !== run.pipelineId) {
    return { ok: false, detail: 'this run’s saved pipeline is no longer available' };
  }
  const active = activeRowsForPipeline(pipeline, input.phases);
  if (!active) {
    return { ok: false, detail: 'the saved pipeline no longer matches this run’s phase history' };
  }
  const failedPhase = active.find((phase) => phase.status === 'fail');
  if (!failedPhase) return { ok: false, detail: 'this run has no failed phase to continue' };

  const exists = input.worktreeExists ?? existsSync;
  if (run.worktreePath && !exists(run.worktreePath)) {
    return { ok: false, detail: 'this run’s worktree is no longer available' };
  }
  // Only now is the strategy answerable: a killed shell command has no
  // conversation to abandon, so it is continued the ordinary way.
  const strategy = continueStrategyFor(run.status, failedPhase.kind);
  if (!strategy) return { ok: false, detail: CONTINUE_STATUS_REFUSAL };
  return { ok: true, strategy, failedPhase, pipeline };
}

/** What the operator is told when Continue is accepted. */
export function continueDetail(strategy: ContinueStrategy, phase: string): string {
  return strategy === 'fresh_session'
    ? `Restarting “${phase}” in a new session…`
    : `Continuing from “${phase}”…`;
}
