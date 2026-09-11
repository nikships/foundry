import type { ProposalSnapshot, RunRow } from '@shared/types.js';

/**
 * Sidebar Activity: the selected project's live runs plus a short recency cap
 * of finished ones. Empty selection yields no rows.
 */
export function selectActivityRuns(
  runs: readonly RunRow[],
  projectId: string,
  recentLimit = 5,
): RunRow[] {
  if (!projectId) return [];
  const scoped = runs.filter((r) => r.projectId === projectId);
  const running = scoped
    .filter((r) => r.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const finished = scoped
    .filter((r) => r.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
    .slice(0, recentLimit);
  return [...running, ...finished];
}

/**
 * One ordered Activity row. Proposals appear before a run exists: generating,
 * ready, and failed proposals are independently visible and actionable, while
 * cancelled/accepted/discarded rows stay out of the sidebar (audit history
 * lives in the durable list, not in Activity).
 */
export type ActivityItem =
  { kind: 'run'; run: RunRow } | { kind: 'proposal'; proposal: ProposalSnapshot };

function isSidebarProposal(status: ProposalSnapshot['status']): boolean {
  return status === 'generating' || status === 'ready' || status === 'failed';
}

/**
 * Ordered Activity for the sidebar, project-scoped. Order is normative:
 * generating proposals (newest created first), live runs (newest started
 * first), ready then failed proposals (newest updated first, ready before
 * failed at equal timestamps), finished runs (newest ended/started first,
 * capped at recentLimit). Empty projectId yields []. Cross-project rows never
 * appear. The component renders this order verbatim and never re-sorts.
 */
export function selectActivityItems(
  runs: readonly RunRow[],
  proposals: readonly ProposalSnapshot[],
  projectId: string,
  recentLimit = 5,
): ActivityItem[] {
  if (!projectId) return [];
  const scopedRuns = runs.filter((r) => r.projectId === projectId);
  const scopedProposals = proposals.filter(
    (p) => p.projectId === projectId && isSidebarProposal(p.status),
  );
  const generating = scopedProposals
    .filter((p) => p.status === 'generating')
    .sort((a, b) => b.createdAt - a.createdAt);
  const liveRuns = scopedRuns
    .filter((r) => r.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const settledProposals = scopedProposals
    .filter((p) => p.status === 'ready' || p.status === 'failed')
    .sort((a, b) => {
      if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
      if (a.status === b.status) return b.createdAt - a.createdAt;
      return a.status === 'ready' ? -1 : 1;
    });
  const finishedRuns = scopedRuns
    .filter((r) => r.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
    .slice(0, recentLimit);
  return [
    ...generating.map((proposal): ActivityItem => ({ kind: 'proposal', proposal })),
    ...liveRuns.map((run): ActivityItem => ({ kind: 'run', run })),
    ...settledProposals.map((proposal): ActivityItem => ({ kind: 'proposal', proposal })),
    ...finishedRuns.map((run): ActivityItem => ({ kind: 'run', run })),
  ];
}
