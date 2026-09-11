/**
 * Pure shaping for durable orchestrator proposals. The DB is the source of
 * truth; these helpers keep every renderer surface (proposal list, sidebar,
 * hooks) reading the same order and the same live-patch rule without a DOM.
 */
import type { ProposalSnapshot } from '@shared/types.js';
import type { OrchestratorState } from '@shared/ipc-contract.js';

/** Newest proposal first, so concurrent submissions never reorder siblings. */
export function sortProposals(proposals: readonly ProposalSnapshot[]): ProposalSnapshot[] {
  return [...proposals].sort((a, b) => {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return b.planId.localeCompare(a.planId);
  });
}

/**
 * Patch one durable row from a live `orchestrator-progress` push without a
 * list re-read. Frozen rows (cancelled/discarded/accepted) never flip back:
 * a late completion landing after a cancel or discard is dropped, and an
 * accept sticks. A push for an unknown planId inserts a generating row so a
 * late completion with no mounted refresh still surfaces; the next
 * `proposals-changed` refresh reconciles it with the DB.
 */
export function applyProposalProgress(
  proposals: readonly ProposalSnapshot[],
  state: OrchestratorState,
): ProposalSnapshot[] {
  const at = Date.now();
  const current = proposals.find((p) => p.planId === state.planId);
  if (current) {
    if (current.status === 'cancelled' || current.status === 'discarded') return [...proposals];
    if (current.status === 'accepted') return [...proposals];
    const next = projectLiveStatus(state);
    return proposals.map((p) =>
      p.planId === state.planId
        ? {
            ...p,
            status: next.status,
            detail: state.detail,
            entries: state.entries,
            plan: next.plan,
            rawReply: state.rawReply,
            messages: state.messages.map((message) => ({ ...message })),
            revision: state.revision,
            updatedAt: at,
            ...(next.endedAt ? { endedAt: at } : {}),
          }
        : p,
    );
  }
  const next = projectLiveStatus(state);
  return sortProposals([
    ...proposals,
    {
      planId: state.planId,
      projectId: state.projectId,
      prompt: state.prompt,
      model: state.model,
      reasoningEffort: state.reasoningEffort,
      status: next.status,
      detail: state.detail,
      entries: state.entries,
      plan: next.plan,
      rawReply: state.rawReply,
      messages: state.messages.map((message) => ({ ...message })),
      revision: state.revision,
      acceptedRunId: null,
      acceptedPlan: null,
      createdAt: state.startedAt,
      updatedAt: at,
      ...(next.endedAt ? { endedAt: at } : {}),
    },
  ]);
}

function projectLiveStatus(state: OrchestratorState): {
  status: ProposalSnapshot['status'];
  plan: ProposalSnapshot['plan'];
  endedAt: boolean;
} {
  // A follow-up message returns status to running with the accepted plan
  // still standing: keep the plan so the card never vanishes mid-chat.
  if (state.status === 'running') return { status: 'generating', plan: state.plan, endedAt: false };
  if (state.status === 'cancelled') return { status: 'cancelled', plan: null, endedAt: true };
  if (state.status === 'failed') return { status: 'failed', plan: null, endedAt: true };
  if (state.plan) return { status: 'ready', plan: state.plan, endedAt: true };
  return { status: 'failed', plan: null, endedAt: true };
}

/** Prompt text for sidebar and card titles, one line, never blank. */
export function proposalTitle(proposal: ProposalSnapshot, maxLength = 80): string {
  const prompt = proposal.prompt.trim().split('\n')[0] ?? '';
  const fallback = proposal.detail.trim().split('\n')[0] ?? '';
  const text = prompt || fallback || 'Orchestrator proposal';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
