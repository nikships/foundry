/**
 * Where an edit in Design lands: the app-level set, or this project's own copy.
 *
 * Agents and pipelines each have a per-project opt-in (`ProjectDef.ownRoster` /
 * `ownPipelines`). Envelopes have no project store at all — one name means one
 * shape everywhere — so their scope is informational rather than a choice.
 *
 * Pure so it can be tested under `environment: node`; the header renders what
 * these return and owns no scope logic of its own.
 */

import type { ProjectDef } from '@shared/types.js';
import type { DesignTab } from '../utils/navigation.js';

export type ScopeLevel = 'global' | 'project' | 'none';

export interface DesignScope {
  level: ScopeLevel;
  /** Badge text. */
  label: string;
  /** One sentence stating where a save lands, shown next to the badge. */
  detail: string;
  /** False for envelopes (no per-project store) and when no project is open. */
  toggleable: boolean;
}

/** Human name per tab, used in the scope sentences. */
const NOUN: Record<DesignTab, string> = {
  pipelines: 'Pipelines',
  agents: 'Agents',
  envelopes: 'Reports',
};

/** Which `ProjectDef` flag a tab toggles, or null when the tab has no copy. */
export function scopeFieldFor(tab: DesignTab): 'ownRoster' | 'ownPipelines' | null {
  if (tab === 'agents') return 'ownRoster';
  if (tab === 'pipelines') return 'ownPipelines';
  return null;
}

export function scopeFlagFor(tab: DesignTab, project: ProjectDef | null): boolean {
  const field = scopeFieldFor(tab);
  return project && field ? project[field] : false;
}

export function resolveDesignScope(tab: DesignTab, project: ProjectDef | null): DesignScope {
  if (tab === 'envelopes') {
    return {
      level: 'global',
      label: 'Global',
      detail:
        'Reports are shared by every project, so a name means one shape everywhere. There is no per-project copy.',
      toggleable: false,
    };
  }

  if (!project) {
    return {
      level: 'none',
      label: 'No project',
      detail: `Open a project to choose whether ${NOUN[tab].toLowerCase()} are shared or kept to it.`,
      toggleable: false,
    };
  }

  if (scopeFlagFor(tab, project)) {
    return {
      level: 'project',
      label: 'This project only',
      detail: `${NOUN[tab]} are a copy belonging to ${project.name}. Edits stay here, and later changes to the global set do not reach it.`,
      toggleable: true,
    };
  }

  return {
    level: 'global',
    label: 'Global',
    detail: `${NOUN[tab]} are shared by every project. An edit here changes them everywhere.`,
    toggleable: true,
  };
}

/**
 * What turning the flag on actually does, which is not the same on a second
 * visit. The project copy is seeded from the app-level set the first time it is
 * read and then kept on disk; switching back to global does not delete it, so
 * re-enabling restores that older copy rather than taking a fresh fork. Saying
 * "a copy will be made" both times would be wrong once.
 */
export function forkNotice(tab: DesignTab, hasExistingCopy: boolean): string {
  const noun = NOUN[tab].toLowerCase();
  return hasExistingCopy
    ? `This project already has its own ${noun} saved from a previous switch. Turning this on restores that copy as it was — it is not re-copied from the current global set.`
    : `A copy of the current global ${noun} is made for this project. From then on it is independent: later edits to the global set do not reach it.`;
}

/** Sentence for switching a project copy back off. The copy is kept, not deleted. */
export function revertNotice(tab: DesignTab): string {
  const noun = NOUN[tab].toLowerCase();
  return `This project goes back to the global ${noun}. Its own copy is kept on disk, so turning this on again restores it.`;
}
