/**
 * Every decision the restore UI makes, kept out of the components so it is
 * testable without Electron: whether the affordance is offered at all, how a
 * checkpoint reads in the picker, what the operator is told before the
 * destructive call, and what the call is allowed to send.
 *
 * The refusal copy is never restated here. Split 2 owns those sentences in
 * `RESTORE_REFUSAL_COPY`, and a surface that paraphrases them is a second,
 * softer answer to the same question. This layer quotes them and adds only
 * what the engine cannot know: that the operator is looking at a button.
 */

import type {
  RestorableCheckpoint,
  RestorableCheckpointList,
  RestoreRecord,
  RestoreResult,
  RestoreRunInput,
  RunRow,
} from '@shared/types.js';
import { RESTORE_REFUSAL_COPY } from '@shared/types.js';

/** Whether the outcome banner shows Restore, and why it is not usable. */
export interface RestoreAvailability {
  /** False only where the whole action set is irrelevant: merged, or no worktree. */
  offered: boolean;
  enabled: boolean;
  /** Why it is disabled, in the engine's words. Empty exactly when enabled. */
  reason: string;
}

export interface RestoreAvailabilityInput {
  run: RunRow | null;
  /** Null until the checkpoint query answers. */
  list: RestorableCheckpointList | null;
  /** The query is still in flight. */
  loading?: boolean;
  /** The query itself failed, as opposed to answering with a refusal. */
  error?: string;
  /** Another worktree action holds the run. */
  busy?: boolean;
}

const HIDDEN: RestoreAvailability = { offered: false, enabled: false, reason: '' };

function disabled(reason: string): RestoreAvailability {
  return { offered: true, enabled: false, reason };
}

/**
 * A run whose worktree is gone or already merged has no Restore, for the same
 * reason it has no Merge: there is nothing left to act on. Everything else
 * shows the control and says why it cannot be pressed, so an operator learns
 * the rule rather than hunting for a button that was never drawn.
 */
export function restoreAvailability(input: RestoreAvailabilityInput): RestoreAvailability {
  const { run, list, loading, error, busy } = input;
  if (!run) return HIDDEN;
  if (run.status === 'running') return HIDDEN;
  if (run.merged || !run.worktreePath) return HIDDEN;
  if (loading) return disabled('Looking for recorded checkpoints…');
  if (error) return disabled(error);
  if (!list) return disabled('Could not read this run’s checkpoints.');
  if (list.refusal) return disabled(list.detail || RESTORE_REFUSAL_COPY[list.refusal]);
  if (!list.checkpoints.length) return disabled(RESTORE_REFUSAL_COPY.no_checkpoints);
  if (busy) return disabled('Another worktree action is still running.');
  return { offered: true, enabled: true, reason: '' };
}

/** One checkpoint as the picker shows it. */
export interface RestoreOptionView {
  checkpointId: string;
  phaseName: string;
  generation: number;
  /** “Implement · attempt 2”. */
  label: string;
  createdAt: string;
  /** Abbreviated commit the phase started from. */
  sha: string;
  /** Model and agent, when the phase had them. */
  attribution: string;
  /** “12 files, 3 untracked” — what the record covers. */
  scope: string;
  exact: boolean;
  /** “Exact” / “Partial”, for the indicator. */
  exactnessLabel: string;
  /** The full sentence under the indicator. Never claims exactness it lacks. */
  exactnessDetail: string;
  /** False when nothing can be put back at all, exactly or partially. */
  selectable: boolean;
  /** Why nothing can be put back, verbatim. Empty when selectable. */
  blockedReason: string;
  /** What a restore would move off the branch, or empty when HEAD has not moved. */
  commitNote: string;
  omittedPaths: string[];
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function attributionOf(checkpoint: RestorableCheckpoint): string {
  return [checkpoint.agent, checkpoint.model].filter((part): part is string => !!part).join(' · ');
}

function scopeOf(checkpoint: RestorableCheckpoint): string {
  const parts = [plural(checkpoint.fileCount, 'file')];
  if (checkpoint.untrackedCount) parts.push(`${checkpoint.untrackedCount} untracked`);
  return parts.join(', ');
}

/**
 * The commits a restore to this checkpoint would move off, named by sha.
 *
 * `commitsSinceShas` is newest first, so its head is where the branch stands
 * now and the checkpoint's own sha is where it would stand after. Both ends
 * are stated because a sha the operator cannot see is a sha they cannot
 * recover from the reflog.
 */
function commitNoteOf(checkpoint: RestorableCheckpoint): string {
  if (!checkpoint.commitsSince) return '';
  const from = checkpoint.commitsSinceShas[0] ?? 'the current tip';
  const moved = plural(checkpoint.commitsSince, 'commit');
  return `${moved} would be reset off the branch, from ${from} back to ${checkpoint.headSha.slice(0, 8)}. They stay reachable through git reflog.`;
}

/**
 * How exact a restore can be, said plainly in both directions.
 *
 * The partial sentence leads with what is impossible rather than with what
 * works: a truncated record puts most of the tree back, and describing that
 * as a phase-start replay would be the one lie this feature cannot afford.
 */
function exactnessDetailOf(checkpoint: RestorableCheckpoint): string {
  if (checkpoint.exactRestorePossible) {
    return 'This record reproduces phase start byte for byte.';
  }
  if (!checkpoint.omittedPaths.length) {
    return 'This record cannot reproduce phase start exactly; a restore would be partial.';
  }
  return `This record cannot reproduce phase start exactly. ${plural(checkpoint.omittedPaths.length, 'path')} were never recorded and would be left exactly as they are now: ${checkpoint.omittedPaths.join(', ')}.`;
}

export function restoreOptions(list: RestorableCheckpointList | null): RestoreOptionView[] {
  if (!list) return [];
  return list.checkpoints.map((checkpoint) => ({
    checkpointId: checkpoint.checkpointId,
    phaseName: checkpoint.phaseName,
    generation: checkpoint.generation,
    label: `${checkpoint.phaseName} · attempt ${checkpoint.generation}`,
    createdAt: checkpoint.createdAt,
    sha: checkpoint.headSha.slice(0, 8),
    attribution: attributionOf(checkpoint),
    scope: scopeOf(checkpoint),
    exact: checkpoint.exactRestorePossible,
    exactnessLabel: checkpoint.exactRestorePossible ? 'Exact' : 'Partial',
    exactnessDetail: exactnessDetailOf(checkpoint),
    selectable: checkpoint.restorable,
    blockedReason:
      checkpoint.restorable || !checkpoint.blocker ? '' : RESTORE_REFUSAL_COPY[checkpoint.blocker],
    commitNote: commitNoteOf(checkpoint),
    omittedPaths: checkpoint.omittedPaths,
  }));
}

/** What the operator is shown before the destructive call, and what it costs. */
export interface RestoreConfirmation {
  title: string;
  confirmLabel: string;
  message: string;
  /** True when accepting this confirmation is what accepts a partial restore. */
  acceptsPartial: boolean;
}

/**
 * Everything a restore does, before it does any of it.
 *
 * Three facts an operator cannot recover after the fact lead: which phase,
 * which commits stop being on the branch, and which paths the record cannot
 * put back. The last line exists because the obvious wrong assumption is that
 * a restore resumes the run.
 */
export function restoreConfirmation(checkpoint: RestorableCheckpoint): RestoreConfirmation {
  const lines = [
    `Restore this run’s worktree to the start of “${checkpoint.phaseName}” (attempt ${checkpoint.generation})?`,
  ];
  const commitNote = commitNoteOf(checkpoint);
  if (commitNote) lines.push(commitNote);
  lines.push(exactnessDetailOf(checkpoint));
  if (!checkpoint.exactRestorePossible) {
    lines.push('Confirming accepts a partial restore.');
  }
  lines.push('Nothing is started: review the worktree, then Continue run yourself.');
  return {
    title: checkpoint.exactRestorePossible ? 'Restore checkpoint' : 'Accept a partial restore',
    confirmLabel: checkpoint.exactRestorePossible ? 'Restore' : 'Restore partially',
    message: lines.join('\n\n'),
    acceptsPartial: !checkpoint.exactRestorePossible,
  };
}

/**
 * The call, or nothing.
 *
 * `acceptPartial` is set here and only here, from one input: an operator who
 * accepted a confirmation that named the paths it cannot put back. A caller
 * that did not confirm gets null rather than a call with the flag dropped,
 * because a silently exact-only retry would be a second, confusing refusal.
 */
export function restoreRequest(
  checkpoint: RestorableCheckpoint,
  confirmed: boolean,
): RestoreRunInput | null {
  if (!confirmed || !checkpoint.restorable) return null;
  const input: RestoreRunInput = {
    runId: checkpoint.runId,
    checkpointId: checkpoint.checkpointId,
  };
  if (!checkpoint.exactRestorePossible) input.acceptPartial = true;
  return input;
}

/** What the operator is told after the call, refusal and success alike. */
export interface RestoreOutcomeView {
  tone: 'ok' | 'bad';
  /** The engine's own sentence, quoted rather than rewritten. */
  detail: string;
  /** Where the operator now stands. Empty on a refusal. */
  standing: string;
  /** The next act, which is always theirs. Empty on a refusal. */
  nextStep: string;
}

function standingOf(record: RestoreRecord): string {
  const parts = [
    `The worktree is back at the start of “${record.phaseName}” (attempt ${record.generation}), on ${record.headSha.slice(0, 8)}.`,
  ];
  if (record.partial) {
    parts.push(
      `This was a partial restore: ${plural(record.omittedPaths.length, 'path')} could not be put back and were left as they were — ${record.omittedPaths.join(', ')}.`,
    );
  }
  if (record.droppedCommits.length) {
    parts.push(
      `${plural(record.droppedCommits.length, 'commit')} moved off the branch and stay reachable through git reflog: ${record.droppedCommits.join(', ')}.`,
    );
  }
  return parts.join(' ');
}

export function restoreOutcome(result: RestoreResult | null): RestoreOutcomeView | null {
  if (!result) return null;
  if (!result.ok || !result.restored) {
    return { tone: 'bad', detail: result.detail, standing: '', nextStep: '' };
  }
  const record = result.restored;
  const agentNote = record.freshSessionAgent
    ? ` ${record.freshSessionAgent} will start a new session; the abandoned one is kept as evidence.`
    : '';
  return {
    tone: 'ok',
    detail: result.detail,
    standing: standingOf(record),
    nextStep: `The run is not running. Review the worktree, then press Continue run to resume from here.${agentNote}`,
  };
}
