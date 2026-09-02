import type { PhaseRow, PipelineDef } from '@shared/types.js';

/**
 * The latest trace row for every phase in the currently persisted pipeline.
 * Amendment failures stay in history, so callers deciding whether a run can
 * continue must not treat every old red row as active.
 */
export function activeRowsForPipeline(
  pipeline: PipelineDef,
  history: PhaseRow[],
): PhaseRow[] | null {
  const latestByName = new Map<string, PhaseRow>();
  for (const row of history) latestByName.set(row.name, row);
  const active: PhaseRow[] = [];
  for (const phase of pipeline.phases) {
    const row = latestByName.get(phase.name);
    if (!row) return null;
    active.push(row);
  }
  return active;
}
