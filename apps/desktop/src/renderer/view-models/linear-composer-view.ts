import type { LinearIssueSnapshot, ValidationIssue } from '@shared/types.js';

/**
 * Composer-local Linear fields that a sidebar project switch must drop.
 * Linear issues are workspace-wide, but a Foundry run is not — keeping a
 * selected issue across projects would start on B linked to A's issue.
 */
export type LinearComposerSelection = {
  query: string;
  issues: LinearIssueSnapshot[];
  activeIndex: number;
  issue: LinearIssueSnapshot | null;
  mappingOpen: boolean;
  showMappingErrors: boolean;
  searching: boolean;
  evidenceLoading: boolean;
  searchError: string;
  startIssues: ValidationIssue[];
  planStartIssues: ValidationIssue[];
};

export function emptyLinearComposerSelection(): LinearComposerSelection {
  return {
    query: '',
    issues: [],
    activeIndex: 0,
    issue: null,
    mappingOpen: false,
    showMappingErrors: false,
    searching: false,
    evidenceLoading: false,
    searchError: '',
    startIssues: [],
    planStartIssues: [],
  };
}

/** Null on the initial mount; a real project-id change returns a cleared draft. */
export function linearComposerSelectionForProject(
  previousProjectId: string,
  nextProjectId: string,
): LinearComposerSelection | null {
  if (previousProjectId === nextProjectId) return null;
  return emptyLinearComposerSelection();
}
