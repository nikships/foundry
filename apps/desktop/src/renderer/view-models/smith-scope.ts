import type { ProjectDef } from '@shared/types.js';
import type { SmithCapabilityId } from './smith-chat-view.js';

/** Resolve Smith's persisted/global scope after the project registry changes. */
export function resolveSmithProjectId(
  projects: Pick<ProjectDef, 'id'>[],
  selectedProjectId: string,
  current: string | null,
  hasSavedPreference: boolean,
): string | null {
  const fallback = projects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : (projects[0]?.id ?? null);
  if (!hasSavedPreference) return fallback;
  if (current === null) return null;
  return projects.some((project) => project.id === current) ? current : fallback;
}

/** Capabilities that name a project of their own and work fine from All projects. */
const GLOBAL_SMITH_CAPABILITIES: ReadonlySet<SmithCapabilityId> = new Set([
  'assigned-work',
  'ticket-status',
  'voice-key-state',
]);

/**
 * Whether a capability works from the current scope. Assigned work, ticket
 * status, and the voice-key state are viewer-global; orchestrator plans and
 * lists, pipeline runs, and context refreshes need an explicit project, so
 * in All-projects scope Smith must ask which project before proposing.
 */
export function smithCapabilityScopeNote(
  capability: SmithCapabilityId,
  scopeId: string | null,
): string | null {
  if (scopeId !== null) return null;
  if (GLOBAL_SMITH_CAPABILITIES.has(capability)) return null;
  return 'Pick a project scope first — this action needs an explicit project.';
}
