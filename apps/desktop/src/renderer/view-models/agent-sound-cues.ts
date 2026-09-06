/**
 * Which agent milestones deserve a sound. Tool chatter is not a milestone:
 * only orchestrator turns, proposed pipelines, finished phases, settled runs,
 * and moments that wait on the operator.
 */

import type { OrchestratorState } from '@shared/ipc-contract.js';
import type { PhaseStatus, RunRow, RunStatus, SmithProposal } from '@shared/types.js';

export type AgentSoundCue =
  | 'orchestrator-ping'
  | 'plan-proposed'
  | 'phase-success'
  | 'phase-fail'
  | 'run-accepted'
  | 'run-rejected'
  | 'run-failed'
  | 'needs-you';

export interface OrchestratorCueSnapshot {
  planId: string;
  status: OrchestratorState['status'];
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

export function isOrchestratorPingNote(text: string): boolean {
  return (
    text.startsWith('Asking the Orchestrator') ||
    text.startsWith('Sending the validation errors back')
  );
}

export function snapshotOrchestrator(state: OrchestratorState): OrchestratorCueSnapshot {
  return {
    planId: state.planId,
    status: state.status,
    hasPlan: state.plan !== null,
    revision: state.revision,
    pingKeys: state.entries
      .filter((entry) => entry.kind === 'note' && isOrchestratorPingNote(entry.text))
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
 * the wire — that is a late join, not a new proposal.
 */
export function orchestratorCues(
  prev: OrchestratorCueSnapshot | undefined,
  next: OrchestratorCueSnapshot,
): AgentSoundCue[] {
  const cues: AgentSoundCue[] = [];
  const seenPings = new Set(prev?.pingKeys ?? []);
  if (next.pingKeys.some((key) => !seenPings.has(key))) cues.push('orchestrator-ping');
  if (prev && !prev.hasPlan && next.hasPlan) cues.push('plan-proposed');
  if (prev?.hasPlan && next.revision > prev.revision) cues.push('plan-proposed');
  return cues;
}

export function runCues(prev: RunCueSnapshot | undefined, next: RunCueSnapshot): AgentSoundCue[] {
  if (!prev) return next.status === 'running' ? [] : [settledRunCue(next.status)];
  if (prev.status === 'running' && next.status !== 'running') {
    return [settledRunCue(next.status)];
  }
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

function settledRunCue(status: RunStatus): AgentSoundCue {
  if (status === 'accepted') return 'run-accepted';
  if (status === 'rejected') return 'run-rejected';
  return 'run-failed';
}
