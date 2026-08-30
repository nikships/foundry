import type { RunRow } from '@shared/types.js';

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
