/**
 * Copy for a settled run's outcome banner, and the rule that decides whether
 * Continue is offered at all.
 *
 * Lives here rather than in the component because the two must agree: a banner
 * that offers Continue while describing the run as finished, or that promises a
 * clean replay of a phase the operator killed mid-write, is worse than one that
 * says nothing.
 */

import type { PhaseRow, RunRow } from '@shared/types.js';
import { continuableStatus, continueStrategyFor } from '@shared/types.js';

/**
 * Whether the operator may continue this run.
 *
 * `hasActiveFailure` is supplied rather than derived from `phases`: an
 * orchestrated run's amendment history keeps superseded red rows the operator
 * must not be offered a retry of.
 */
export function canResumeRun(run: RunRow, hasActiveFailure: boolean): boolean {
  if (!continuableStatus(run.status)) return false;
  return !!run.worktreePath && !run.merged && hasActiveFailure;
}

/**
 * The phase Continue would pick up, which is the first one still red.
 *
 * The engine picks the same row (`activeRowsForPipeline` order), so the copy
 * here describes the phase that will actually re-run.
 */
function interruptedPhase(phases: PhaseRow[]): PhaseRow | undefined {
  return phases.find((p) => p.status === 'fail');
}

/**
 * What the Continue button promises, which differs by how the run stopped and
 * by what it stopped in the middle of: only an agent phase gets a new session.
 */
export function resumeTitleFor(run: RunRow, phases: PhaseRow[]): string {
  return continueStrategyFor(run.status, interruptedPhase(phases)?.kind) === 'fresh_session'
    ? 'Restart the interrupted phase in a new session, in the same worktree'
    : 'Retry the first failed phase and continue this pipeline in the same worktree';
}

export function outcomeHeadline(status: RunRow['status']): string {
  switch (status) {
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Not accepted';
    case 'killed':
      return 'Stopped';
    default:
      return 'Failed';
  }
}

/**
 * The banner's explanation.
 *
 * A killed run reads differently depending on whether it can be picked up
 * again: with a worktree and an interrupted phase, the honest description is
 * that the phase restarts on a new conversation over the files the kill left
 * behind — not that the phase replays from a clean start, and not that the work
 * is gone. A killed command phase is continued too, but there is no
 * conversation involved, so it must not be described as one.
 */
export function outcomeExplanation(
  run: RunRow,
  phases: PhaseRow[],
  opts: { canResume?: boolean } = {},
): string {
  const failed = phases.filter((p) => p.status === 'fail');
  switch (run.status) {
    case 'accepted':
      return run.outcomeDetail || 'Every phase passed and the acceptance criterion was met.';
    case 'rejected': {
      const failNote = failed.length ? ` (${failed.map((p) => p.name).join(', ')} failed)` : '';
      return (
        run.outcomeDetail ||
        `The pipeline ran to the end, but its acceptance criterion was not met${failNote}.`
      );
    }
    case 'killed': {
      const stopped = failed[0];
      const where = stopped ? ` during “${stopped.name}”` : '';
      if (!opts.canResume) {
        return `You stopped this run${where}. Anything it had already committed is still on its branch.`;
      }
      if (stopped?.kind !== 'agent') {
        return (
          `You stopped this run${where}. Continue re-runs that phase in this worktree, ` +
          'over the files the interrupted attempt left behind.'
        );
      }
      return (
        `You stopped this run${where}. Continue restarts that phase in a new session, in this worktree — ` +
        'the agent picks up whatever the interrupted attempt had already written and reconciles it.'
      );
    }
    default:
      return run.outcomeDetail || 'The engine could not finish this run.';
  }
}
