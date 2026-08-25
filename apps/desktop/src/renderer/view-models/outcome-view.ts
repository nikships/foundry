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
import { continueStrategyFor } from '@shared/types.js';

/**
 * Whether the operator may continue this run.
 *
 * `hasActiveFailure` is supplied rather than derived from `phases`: an
 * orchestrated run's amendment history keeps superseded red rows the operator
 * must not be offered a retry of.
 */
export function canResumeRun(run: RunRow, hasActiveFailure: boolean): boolean {
  if (!continueStrategyFor(run.status)) return false;
  return !!run.worktreePath && !run.merged && hasActiveFailure;
}

/** What the Continue button promises, which differs by how the run stopped. */
export function resumeTitleFor(run: RunRow): string {
  return continueStrategyFor(run.status) === 'fresh_session'
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
 * is gone.
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
      const stopped = failed[0]?.name;
      const where = stopped ? ` during “${stopped}”` : '';
      if (!opts.canResume) {
        return `You stopped this run${where}. Anything it had already committed is still on its branch.`;
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
