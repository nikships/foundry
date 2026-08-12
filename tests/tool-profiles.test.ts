/**
 * Per-agent and per-phase tool profiles: what each profile admits, how a phase
 * narrows an agent, how the result composes with FOU-24's invocable isolation,
 * and the one-shot allowlist.
 *
 * The inventory in these tests deliberately includes a tool this build has never
 * heard of (an MCP tool and a skill tool), because classifying those is the whole
 * reason profiles are computed against the live list instead of a name table.
 */

import { describe, expect, it } from 'vitest';
import {
  agentPolicy,
  allowedByPolicy,
  describePolicy,
  effectiveDisabledToolIds,
  isRestrictive,
  oneShotAllowlist,
  phasePolicy,
  profileOf,
  type ToolInventoryEntry,
} from '../src/main/droid/tool-profiles.js';
import { FOUNDRY_TOOL_IDS } from '../src/main/droid/sdk/mcp-tools.js';
import type { AgentDef, PhaseDef } from '../src/shared/types.js';

/** A realistic session tool list, including tools no build-time table knows. */
const INVENTORY: ToolInventoryEntry[] = [
  { id: 'Read', displayName: 'Read', category: 'read' },
  { id: 'LS', displayName: 'LS', category: 'read' },
  { id: 'Grep', displayName: 'Grep', category: 'read' },
  { id: 'Glob', displayName: 'Glob', category: 'read' },
  { id: 'Edit', displayName: 'Edit', category: 'edit' },
  { id: 'Create', displayName: 'Create', category: 'edit' },
  { id: 'MultiEdit', displayName: 'Multi Edit', category: 'edit' },
  { id: 'Execute', displayName: 'Execute', category: 'execute' },
  { id: 'TodoWrite', displayName: 'Plan', category: 'other' },
  { id: 'Task', displayName: 'Subagent', category: 'other' },
  // Arrived from an MCP server at runtime; no build-time table lists it.
  { id: 'linear___create_issue', displayName: 'create_issue', category: 'other' },
  // A host skill's tool, which FOU-24 may also be withholding.
  { id: 'Skill__pdf_forms', displayName: 'pdf-forms', category: 'other' },
  ...FOUNDRY_TOOL_IDS.map((id) => ({ id, displayName: id, category: 'other' })),
];

const ALL_IDS = INVENTORY.map((t) => t.id);

function agent(partial: Partial<AgentDef>): AgentDef {
  return {
    name: 'scout',
    purpose: 'look',
    model: 'm',
    reasoningEffort: 'off',
    systemPrompt: 's',
    userPrompt: 'u',
    writes: null,
    envelope: 'none',
    color: '#abcdef',
    ...partial,
  };
}

function phase(partial: Partial<PhaseDef>): PhaseDef {
  return { name: 'p', kind: 'agent', description: 'd', ...partial };
}

describe('authored policy', () => {
  it('treats an absent profile as full, so built-ins are untouched', () => {
    expect(agentPolicy(agent({}))).toEqual({ profile: 'full' });
    expect(profileOf(undefined)).toBe('full');
    expect(isRestrictive(agentPolicy(agent({})))).toBe(false);
  });

  it('reads a pre-profile allowlist as custom, so existing rosters keep working', () => {
    expect(agentPolicy(agent({ tools: ['Read'] }))).toEqual({
      profile: 'custom',
      allow: ['Read'],
    });
  });

  it('does not treat an empty custom allowlist as "disable everything"', () => {
    expect(isRestrictive({ profile: 'custom', allow: [] })).toBe(false);
    expect(allowedByPolicy(INVENTORY, { profile: 'custom', allow: [] }).size).toBe(
      INVENTORY.length,
    );
  });

  it('reads a phase as narrowing only when it says something', () => {
    expect(phasePolicy(phase({}))).toBeNull();
    expect(phasePolicy(phase({ toolProfile: 'read-only' }))).toEqual({
      profile: 'read-only',
      allow: undefined,
    });
    // A bare allowlist on a phase is a narrowing in its own right.
    expect(phasePolicy(phase({ tools: ['Read'] }))).toEqual({ profile: 'custom', allow: ['Read'] });
  });
});

describe('what each profile admits', () => {
  it('full admits everything present, including tools it has never heard of', () => {
    expect(allowedByPolicy(INVENTORY, { profile: 'full' })).toEqual(new Set(ALL_IDS));
  });

  it('read-only admits the read category and nothing else', () => {
    expect([...allowedByPolicy(INVENTORY, { profile: 'read-only' })].sort()).toEqual([
      'Glob',
      'Grep',
      'LS',
      'Read',
    ]);
  });

  it('review adds command execution but still no edits', () => {
    const allowed = allowedByPolicy(INVENTORY, { profile: 'review' });
    expect(allowed.has('Execute')).toBe(true);
    expect(allowed.has('Read')).toBe(true);
    expect(allowed.has('Edit')).toBe(false);
    expect(allowed.has('Create')).toBe(false);
  });

  it('classifies a runtime MCP tool rather than missing it', () => {
    // `other` is in no narrowed profile, so a tool that appeared mid-session is
    // withheld by category instead of slipping through an unknown name.
    for (const profile of ['read-only', 'review'] as const) {
      expect(allowedByPolicy(INVENTORY, { profile }).has('linear___create_issue')).toBe(false);
    }
  });

  it('custom admits exactly the named ids that exist', () => {
    const allowed = allowedByPolicy(INVENTORY, {
      profile: 'custom',
      allow: ['Read', 'Execute', 'NotInstalled'],
    });
    expect([...allowed].sort()).toEqual(['Execute', 'Read']);
  });
});

describe('effective disabled ids', () => {
  const disabledFor = (input: Parameters<typeof effectiveDisabledToolIds>[0]): Set<string> =>
    new Set(effectiveDisabledToolIds(input));

  it('disables nothing when the agent is full and no phase narrows', () => {
    expect(effectiveDisabledToolIds({ tools: INVENTORY, agent: { profile: 'full' } })).toEqual([]);
  });

  it('disables the complement of a read-only agent', () => {
    const disabled = disabledFor({ tools: INVENTORY, agent: { profile: 'read-only' } });
    expect(disabled.has('Edit')).toBe(true);
    expect(disabled.has('Execute')).toBe(true);
    expect(disabled.has('Read')).toBe(false);
  });

  it('never disables the Foundry MCP tools, whatever the policy', () => {
    const disabled = disabledFor({
      tools: INVENTORY,
      agent: { profile: 'custom', allow: ['Read'] },
      phase: { profile: 'read-only' },
      explicitDisabled: [...FOUNDRY_TOOL_IDS],
      hiddenSkills: [{ id: 'pdf-forms', name: 'pdf-forms' }],
      alwaysAllow: FOUNDRY_TOOL_IDS,
    });
    for (const id of FOUNDRY_TOOL_IDS) expect(disabled.has(id)).toBe(false);
  });

  it('lets a phase narrow the agent', () => {
    const disabled = disabledFor({
      tools: INVENTORY,
      agent: { profile: 'review' },
      phase: { profile: 'read-only' },
    });
    // Execute was the agent's, and the phase took it away.
    expect(disabled.has('Execute')).toBe(true);
    expect(disabled.has('Read')).toBe(false);
  });

  it('never lets a phase broaden the agent', () => {
    const disabled = disabledFor({
      tools: INVENTORY,
      agent: { profile: 'read-only' },
      phase: { profile: 'full' },
    });
    // A `full` phase under a read-only agent is still read-only.
    expect(disabled.has('Edit')).toBe(true);
    expect(disabled.has('Execute')).toBe(true);
    expect(disabled.has('Read')).toBe(false);
  });

  it('never lets a phase allowlist reach past the agent policy', () => {
    const disabled = disabledFor({
      tools: INVENTORY,
      agent: { profile: 'read-only' },
      phase: { profile: 'custom', allow: ['Edit', 'Read'] },
    });
    // Edit was not the agent's to give, so naming it in the phase changes nothing.
    expect(disabled.has('Edit')).toBe(true);
    expect(disabled.has('Read')).toBe(false);
  });

  it('composes with invocable isolation: a full profile cannot restore a hidden skill', () => {
    const disabled = disabledFor({
      tools: INVENTORY,
      agent: { profile: 'full' },
      hiddenSkills: [{ id: 'pdf-forms', name: 'pdf-forms' }],
      alwaysAllow: FOUNDRY_TOOL_IDS,
    });
    expect(disabled.has('Skill__pdf_forms')).toBe(true);
    // …and it has not disabled anything else on the way.
    expect(disabled.size).toBe(1);
  });

  it('keeps explicit roster disables on top of a profile', () => {
    const disabled = disabledFor({
      tools: INVENTORY,
      agent: { profile: 'full' },
      explicitDisabled: ['Task'],
    });
    expect([...disabled]).toEqual(['Task']);
  });

  it('applies what it can when the inventory is empty, and claims nothing more', () => {
    // No inventory means no complement is computable. Explicit disables still
    // travel; the profile's share is the caller's fail-closed problem.
    expect(
      effectiveDisabledToolIds({
        tools: [],
        agent: { profile: 'read-only' },
        explicitDisabled: ['Task'],
      }),
    ).toEqual(['Task']);
  });

  it('is sorted and stable, so an unchanged policy is not re-sent', () => {
    const once = effectiveDisabledToolIds({ tools: INVENTORY, agent: { profile: 'read-only' } });
    const twice = effectiveDisabledToolIds({ tools: INVENTORY, agent: { profile: 'read-only' } });
    expect(once).toEqual(twice);
    expect(once).toEqual([...once].sort());
  });
});

describe('one-shot allowlist', () => {
  it('is null when nothing narrows, so argv is untouched', () => {
    expect(oneShotAllowlist({ profile: 'full' })).toBeNull();
    expect(oneShotAllowlist(undefined, null)).toBeNull();
  });

  it('names the built-in read tools for a read-only agent', () => {
    expect(oneShotAllowlist({ profile: 'read-only' })).toEqual(['Glob', 'Grep', 'LS', 'Read']);
  });

  it('adds Execute for review', () => {
    expect(oneShotAllowlist({ profile: 'review' })).toContain('Execute');
  });

  it('intersects the phase with the agent', () => {
    expect(oneShotAllowlist({ profile: 'review' }, { profile: 'read-only' })).toEqual([
      'Glob',
      'Grep',
      'LS',
      'Read',
    ]);
  });

  it('never admits a tool the agent policy excluded', () => {
    const ids = oneShotAllowlist(
      { profile: 'read-only' },
      { profile: 'custom', allow: ['Execute'] },
    );
    expect(ids).toEqual([]);
  });

  it('passes a custom allowlist straight through', () => {
    expect(oneShotAllowlist({ profile: 'custom', allow: ['Read', 'Grep'] })).toEqual([
      'Grep',
      'Read',
    ]);
  });
});

describe('trace description', () => {
  it('names the agent profile, and the phase only when it narrows', () => {
    expect(describePolicy({ profile: 'review' })).toBe('agent review');
    expect(describePolicy({ profile: 'review' }, { profile: 'read-only' })).toBe(
      'agent review, phase read-only',
    );
    expect(describePolicy({ profile: 'review' }, null)).toBe('agent review');
  });
});
