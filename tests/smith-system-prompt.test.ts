/**
 * The appended system prompt that teaches a Smith droid session to drive
 * Foundry. `renderSystemPrompt` is pure, so these pin the content that must be
 * present: the helper CLI usage, the entity schemas, the project-scoped
 * inventory, and the validate-then-propose behavioral guidance.
 */

import { describe, expect, it } from 'vitest';
import type { AgentDef, EnvelopeDef, PipelineDef, ProjectDef } from '../src/shared/types.js';
import { renderSystemPrompt } from '../src/main/smith/system-prompt.js';

const project: ProjectDef = {
  id: 'proj-1',
  name: 'Acme',
  path: '/repos/acme',
  baseRef: 'main',
  isolation: true,
  mergePolicy: 'ask',
  commands: [],
  protectedPaths: [],
  ownRoster: false,
  ownPipelines: false,
  addedAt: '2026-01-01T00:00:00.000Z',
};

const agent = (name: string): AgentDef => ({
  name,
  purpose: 'Do a thing.',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 's',
  userPrompt: 'u',
  writes: null,
  envelope: 'generic',
  color: '#5ad2dd',
});

const pipeline = (id: string): PipelineDef => ({
  id,
  name: id,
  description: 'd',
  acceptance: { kind: 'all_phases_pass' },
  phases: [],
});

const envelope = (name: string): EnvelopeDef => ({ name, fields: [] });

const render = (over: Partial<Parameters<typeof renderSystemPrompt>[0]> = {}): string =>
  renderSystemPrompt({
    project,
    agents: [],
    pipelines: [],
    envelopes: [],
    cliPath: '/app/foundry-cli.js',
    ...over,
  });

describe('renderSystemPrompt', () => {
  it('names the project and scopes the session to it', () => {
    const out = render();
    expect(out).toContain('Acme');
    expect(out).toContain('/repos/acme');
  });

  it('documents the helper CLI commands', () => {
    const out = render();
    expect(out).toContain('$FOUNDRY_CLI');
    expect(out).toMatch(/list/);
    expect(out).toMatch(/show/);
    expect(out).toContain('create --file');
    expect(out).toContain('edit');
  });

  it('carries the three entity schemas', () => {
    const out = render();
    expect(out).toContain('AgentDef');
    expect(out).toContain('PipelineDef');
    expect(out).toContain('EnvelopeDef');
  });

  it('embeds the current inventory for the project scope', () => {
    const out = render({
      agents: [agent('planner'), agent('builder')],
      pipelines: [pipeline('plan-build')],
      envelopes: [envelope('severity_report')],
    });
    expect(out).toContain('planner');
    expect(out).toContain('builder');
    expect(out).toContain('plan-build');
    expect(out).toContain('severity_report');
  });

  it('says "(none yet)" for an empty scope so the agent does not invent entities', () => {
    expect(render()).toContain('(none yet)');
  });

  it('states the validate-then-propose, expect-approval behavior', () => {
    const out = render();
    expect(out.toLowerCase()).toContain('validate');
    expect(out.toLowerCase()).toContain('approval');
    // Overwrite semantics must be spelled out for the human's card.
    expect(out.toLowerCase()).toContain('overwrite');
  });
});
