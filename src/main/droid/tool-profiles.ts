/**
 * The one place that decides which tool ids a turn runs without.
 *
 * Two policies meet here. FOU-24's invocable isolation subtracts host skills an
 * agent did not select; this file's profiles subtract system tools an agent (or
 * the phase it is running) was not given. They compose by union — every rule
 * only ever takes tools away — which is what makes the composition safe to
 * reason about: no profile can hand back a skill isolation withheld, and no
 * selection can hand back a tool a profile withheld.
 *
 * Three design constraints worth stating, because each one rules out a simpler
 * implementation:
 *
 *  1. **Profiles are defined over the live inventory, not over tool names.** The
 *     CLI reports a category (`read` / `edit` / `execute` / `other`) for every
 *     tool it has, including ones that arrive from an MCP server mid-session. A
 *     hardcoded name list would silently fail to classify those, which is
 *     exactly the escape hatch a least-privilege feature cannot have.
 *  2. **The wire is subtractive.** The CLI accepts `disabledToolIds`; its
 *     allowlist counterpart is stripped by the public schemas. So an allowlist
 *     is always expressed as its complement against the inventory, and the
 *     complement is only as good as the inventory it was computed from — hence
 *     the fail-closed rules in `AgentSession`.
 *  3. **A phase narrows; it never broadens.** Phase policy is an intersection
 *     with the agent's, so authoring a phase cannot be a privilege escalation.
 */

import type { AgentDef, PhaseDef, ToolPolicySpec, ToolProfile } from '@shared/types.js';
import { hiddenSkillToolIds } from './invocables.js';

/** One tool as the policy needs to see it; a superset of `SessionTool`. */
export interface ToolInventoryEntry {
  id: string;
  displayName?: string;
  /** `read` | `edit` | `execute` | `other` as the CLI reports it. */
  category?: string;
}

/**
 * Which reported categories each profile admits. `other` is deliberately in no
 * restricted profile: it is where planning, sub-agent spawning, web access and
 * MCP tools land, and a sub-agent is a way to do anything the parent could not.
 * Foundry's own MCP tools stay reachable through `alwaysAllow`, not through this
 * table.
 */
const PROFILE_CATEGORIES: Record<Exclude<ToolProfile, 'full' | 'custom'>, ReadonlySet<string>> = {
  'read-only': new Set(['read']),
  review: new Set(['read', 'execute']),
};

/**
 * Built-in tool ids per category, for the one-shot path only.
 *
 * One-shot has no session to enumerate tools with, but its narrowing travels as
 * `--restrict-tools`, which is an allowlist — so an id this table does not know
 * about is excluded rather than admitted. That makes a stale table narrower than
 * intended and never wider, which is the only direction a least-privilege
 * fallback may be wrong in. Ids are the CLI's own `llmId`s.
 */
const ONESHOT_TOOLS_BY_CATEGORY: Record<string, readonly string[]> = {
  read: ['Read', 'LS', 'Glob', 'Grep'],
  execute: ['Execute'],
  edit: ['Create', 'Edit', 'MultiEdit', 'ApplyPatch'],
};

/** The profile a spec means, treating absent as the permissive default. */
export function profileOf(spec: ToolPolicySpec | null | undefined): ToolProfile {
  return spec?.profile ?? 'full';
}

/** Whether a spec takes anything away at all. */
export function isRestrictive(spec: ToolPolicySpec | null | undefined): boolean {
  if (!spec) return false;
  const profile = profileOf(spec);
  if (profile === 'full') return false;
  // A `custom` profile with no allowlist would disable everything, which is
  // never what an operator meant; it reads as unset instead.
  if (profile === 'custom') return (spec.allow?.length ?? 0) > 0;
  return true;
}

/**
 * The agent's authored policy.
 *
 * Back-compatible on purpose: a roster with `tools` but no profile predates
 * profiles and keeps meaning "allow exactly these", so existing rosters and
 * every built-in behave as before.
 */
export function agentPolicy(agent: Pick<AgentDef, 'toolProfile' | 'tools'>): ToolPolicySpec {
  if (agent.toolProfile) return { profile: agent.toolProfile, allow: agent.tools };
  if (agent.tools?.length) return { profile: 'custom', allow: agent.tools };
  return { profile: 'full' };
}

/** The phase's authored narrowing, or null when the phase does not narrow. */
export function phasePolicy(phase: Pick<PhaseDef, 'toolProfile' | 'tools'>): ToolPolicySpec | null {
  if (phase.toolProfile) return { profile: phase.toolProfile, allow: phase.tools };
  // A bare allowlist on a phase is a narrowing in its own right.
  if (phase.tools?.length) return { profile: 'custom', allow: phase.tools };
  return null;
}

/**
 * The ids one spec admits out of this inventory.
 *
 * `full` admits everything present — including tools this build has never heard
 * of, which is the point of computing against the inventory.
 */
export function allowedByPolicy(
  tools: readonly ToolInventoryEntry[],
  spec: ToolPolicySpec | null | undefined,
): Set<string> {
  const all = new Set(tools.map((t) => t.id));
  const profile = profileOf(spec);
  if (profile === 'full') return all;
  if (profile === 'custom') {
    const allow = new Set(spec?.allow ?? []);
    // An empty custom allowlist reads as unset rather than as "nothing", per
    // isRestrictive; a populated one is matched against what actually exists.
    if (allow.size === 0) return all;
    return new Set([...all].filter((id) => allow.has(id)));
  }
  const categories = PROFILE_CATEGORIES[profile];
  return new Set(
    tools.filter((t) => categories.has((t.category ?? '').toLowerCase())).map((t) => t.id),
  );
}

export interface EffectivePolicyInput {
  /** The live tool list. An empty list means nothing can be computed. */
  tools: readonly ToolInventoryEntry[];
  agent: ToolPolicySpec | null | undefined;
  /** The phase about to run, when it narrows further. */
  phase?: ToolPolicySpec | null;
  /** Ids the roster disables outright, regardless of profile. */
  explicitDisabled?: readonly string[];
  /** FOU-24: host skills this agent did not select. */
  hiddenSkills?: readonly { id: string; name: string }[];
  /** Ids no policy may take away — Foundry's own MCP tools. */
  alwaysAllow?: readonly string[];
}

/**
 * Every tool id this turn must run without, sorted so two equal policies
 * produce an identical request and the caller's memo can skip the round trip.
 *
 * The agent's allowed set is intersected with the phase's, so a phase can only
 * subtract. Explicit disables and withheld skills are unioned on top. Finally
 * `alwaysAllow` is removed from the result: Foundry's progress reporting is not
 * something a roster, a phase, or an isolation decision may switch off.
 */
export function effectiveDisabledToolIds(input: EffectivePolicyInput): string[] {
  const { tools, agent, phase, explicitDisabled = [], hiddenSkills = [], alwaysAllow = [] } = input;

  const disabled = new Set<string>(explicitDisabled);
  for (const id of hiddenSkillToolIds(tools as ToolInventoryEntry[], [...hiddenSkills])) {
    disabled.add(id);
  }

  // Without an inventory a complement cannot be computed. Explicit disables and
  // skill ids still apply; the profile's share is the caller's problem to fail
  // closed on, and it does — see AgentSession's daemon and one-shot rules.
  if (tools.length && (isRestrictive(agent) || isRestrictive(phase))) {
    const allowed = allowedByPolicy(tools, agent);
    if (isRestrictive(phase)) {
      const byPhase = allowedByPolicy(tools, phase);
      for (const id of [...allowed]) if (!byPhase.has(id)) allowed.delete(id);
    }
    for (const tool of tools) if (!allowed.has(tool.id)) disabled.add(tool.id);
  }

  for (const id of alwaysAllow) disabled.delete(id);
  return [...disabled].sort();
}

/**
 * The `--restrict-tools` allowlist for a one-shot turn, or null when the policy
 * takes nothing away.
 *
 * Built from the static table rather than an inventory, and safe for the reason
 * given there: an allowlist can only under-admit. A `custom` policy passes its
 * own ids straight through, which is what the detect and setup sessions have
 * always done.
 */
export function oneShotAllowlist(
  agent: ToolPolicySpec | null | undefined,
  phase?: ToolPolicySpec | null,
): string[] | null {
  if (!isRestrictive(agent) && !isRestrictive(phase)) return null;
  const resolve = (spec: ToolPolicySpec | null | undefined): Set<string> | null => {
    if (!isRestrictive(spec)) return null;
    const profile = profileOf(spec);
    if (profile === 'custom') return new Set(spec?.allow ?? []);
    const categories = PROFILE_CATEGORIES[profile as Exclude<ToolProfile, 'full' | 'custom'>];
    const ids: string[] = [];
    for (const [category, names] of Object.entries(ONESHOT_TOOLS_BY_CATEGORY)) {
      if (categories.has(category)) ids.push(...names);
    }
    return new Set(ids);
  };
  const byAgent = resolve(agent);
  const byPhase = resolve(phase);
  const merged =
    byAgent && byPhase
      ? new Set([...byAgent].filter((id) => byPhase.has(id)))
      : (byAgent ?? byPhase);
  if (!merged) return null;
  return [...merged].sort();
}

/** One line for the trace, so an operator can see what a phase narrowed to. */
export function describePolicy(
  agent: ToolPolicySpec | null | undefined,
  phase?: ToolPolicySpec | null,
): string {
  const parts = [`agent ${profileOf(agent)}`];
  if (isRestrictive(phase)) parts.push(`phase ${profileOf(phase)}`);
  return parts.join(', ');
}
