/**
 * Which agent milestones deserve a sound. Tool chatter is not a milestone:
 * only compose turns, proposed pipelines, finished phases, settled runs,
 * and moments that wait on the operator.
 *
 * First sighting of a run, plan, or Smith id is a baseline, never a concert.
 * Settled runs stay quiet even if a later list row grows phase summaries.
 */

import type { ComposeState } from '@shared/ipc-contract.js';
import type { PhaseStatus, RunRow, RunStatus, SmithProposal } from '@shared/types.js';

export type AgentSoundCue =
  | 'compose-ping'
  | 'plan-proposed'
  | 'phase-success'
  | 'phase-fail'
  | 'run-accepted'
  | 'run-rejected'
  | 'run-failed'
  | 'needs-you';

export interface ComposeCueSnapshot {
  planId: string;
  status: ComposeState['status'];
  hasPlan: boolean;
  revision: number;
  pingKeys: string[];
}

export interface RunCueSnapshot {
  runId: string;
  status: RunStatus;
  phases: { name: string; status: PhaseStatus }[];
}

export interface SmithCueSnapshot {
  proposalIds: string[];
}

export function isComposePingNote(text: string): boolean {
  return (
    text.startsWith('Asking Smith to compose') ||
    text.startsWith('Sending the validation errors back')
  );
}

export function snapshotCompose(state: ComposeState): ComposeCueSnapshot {
  return {
    planId: state.planId,
    status: state.status,
    hasPlan: state.plan !== null,
    revision: state.revision,
    pingKeys: state.entries
      .filter((entry) => entry.kind === 'note' && isComposePingNote(entry.text))
      .map((entry) => entry.id),
  };
}

export function snapshotRun(
  run: Pick<RunRow, 'runId' | 'status' | 'phaseSummary'>,
): RunCueSnapshot {
  return {
    runId: run.runId,
    status: run.status,
    phases: (run.phaseSummary ?? []).map((phase) => ({ name: phase.name, status: phase.status })),
  };
}

export function snapshotSmith(proposals: readonly Pick<SmithProposal, 'id'>[]): SmithCueSnapshot {
  return { proposalIds: proposals.map((proposal) => proposal.id) };
}

/**
 * Live planning sessions only. The first snapshot of a planId is itself a
 * transition (the operator just clicked), except a plan that is already on
 * the wire — that is a late join, not a new proposal. A finished transcript
 * that arrives as the first event is the same late join: its ask notes are
 * history, not a ping.
 */
export function composeCues(
  prev: ComposeCueSnapshot | undefined,
  next: ComposeCueSnapshot,
): AgentSoundCue[] {
  const cues: AgentSoundCue[] = [];
  const seenPings = new Set(prev?.pingKeys ?? []);
  const hasNewPing = next.pingKeys.some((key) => !seenPings.has(key));
  if (hasNewPing && (prev !== undefined || next.status === 'running')) {
    cues.push('compose-ping');
  }
  if (prev && !prev.hasPlan && next.hasPlan) cues.push('plan-proposed');
  if (prev?.hasPlan && next.revision > prev.revision) cues.push('plan-proposed');
  return cues;
}

export function runCues(prev: RunCueSnapshot | undefined, next: RunCueSnapshot): AgentSoundCue[] {
  if (!prev) return [];
  if (prev.status === 'running' && next.status !== 'running') {
    return [settledRunCue(next.status)];
  }
  if (next.status !== 'running') return [];
  const cues: AgentSoundCue[] = [];
  const previousStatus = new Map(prev.phases.map((phase) => [phase.name, phase.status]));
  for (const phase of next.phases) {
    const from = previousStatus.get(phase.name);
    if (from === phase.status) continue;
    if (phase.status === 'success') cues.push('phase-success');
    else if (phase.status === 'fail') cues.push('phase-fail');
  }
  return cues;
}

export function smithCues(
  prev: SmithCueSnapshot | undefined,
  next: SmithCueSnapshot,
): AgentSoundCue[] {
  if (!prev) return [];
  const seen = new Set(prev.proposalIds);
  return next.proposalIds.some((id) => !seen.has(id)) ? ['needs-you'] : [];
}

/**
 * A list row with no phases is incomplete, not a reset. Keep the last known
 * summary so an empty poll cannot make the next full row look like a burst
 * of brand-new successes.
 */
export function stabilizeRunSnapshot(
  prev: RunCueSnapshot | undefined,
  next: RunCueSnapshot,
): RunCueSnapshot {
  if (prev?.phases.length && next.phases.length === 0) {
    return { ...next, phases: prev.phases };
  }
  return next;
}

/**
 * Merge list rows into the cue store. Rows that drop out of the current page
 * stay remembered so they cannot replay as first-sighting settlements when
 * they return. Callers play the returned cues.
 */
export function applyRunSnapshots(
  runs: readonly Pick<RunRow, 'runId' | 'status' | 'phaseSummary'>[],
  store: Map<string, RunCueSnapshot>,
): AgentSoundCue[] {
  const cues: AgentSoundCue[] = [];
  for (const run of runs) {
    const incoming = snapshotRun(run);
    const prev = store.get(run.runId);
    const next = stabilizeRunSnapshot(prev, incoming);
    cues.push(...runCues(prev, next));
    store.set(run.runId, next);
  }
  return cues;
}

/** Union of seen Smith ids so a transient empty list cannot resurrect them as new. */
export function rememberSmithProposals(
  prev: SmithCueSnapshot | undefined,
  next: SmithCueSnapshot,
): SmithCueSnapshot {
  if (!prev) return next;
  return { proposalIds: [...new Set([...prev.proposalIds, ...next.proposalIds])] };
}

function settledRunCue(status: RunStatus): AgentSoundCue {
  if (status === 'accepted') return 'run-accepted';
  if (status === 'rejected') return 'run-rejected';
  return 'run-failed';
}
