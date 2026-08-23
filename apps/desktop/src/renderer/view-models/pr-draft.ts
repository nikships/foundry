/**
 * Pure helpers for the manual "Open PR…" form.
 *
 * Draft title/body live in `@shared/pr-draft` so the companion host cannot
 * invent a different formula. Writer-picker options stay renderer-only.
 */

import type { AgentDef } from '@shared/types.js';

export {
  defaultPrBody,
  defaultPrTitle,
  manualPrDraft,
  prDraftFromEnvelope,
  selectPrEnvelope,
  type PrDraft,
  type PrDraftSource,
  type ResolvedPrDraft,
} from '@shared/pr-draft.js';

export interface PrWriterOption {
  value: string;
  label: string;
  description: string;
  group: string;
}

/**
 * Roster-backed picker options. An unknown current writer stays visible so
 * settings reads never break; the operator can replace it.
 */
export function prWriterOptions(
  agents: ReadonlyArray<Pick<AgentDef, 'name' | 'purpose' | 'builtin'>>,
  current: string,
): PrWriterOption[] {
  const seen = new Set<string>();
  const options: PrWriterOption[] = [];
  const builtinsFirst = [
    ...agents.filter((agent) => agent.builtin),
    ...agents.filter((agent) => !agent.builtin),
  ];
  for (const agent of builtinsFirst) {
    if (seen.has(agent.name)) continue;
    seen.add(agent.name);
    options.push({
      value: agent.name,
      label: agent.name,
      description: agent.purpose,
      group: agent.builtin ? 'Built-in' : 'This roster',
    });
  }
  if (current && !seen.has(current)) {
    options.unshift({
      value: current,
      label: current,
      description: 'Not in this roster',
      group: 'Unavailable',
    });
  }
  return options;
}

export function isKnownPrWriter(
  name: string,
  agents: ReadonlyArray<Pick<AgentDef, 'name'>>,
): boolean {
  return agents.some((agent) => agent.name === name);
}
