import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RosterStore } from '../../../src/main/store/roster.js';
import type { AgentDef } from '../../../src/shared/types.js';
import { tempDir } from '../../helpers/tmp.js';

let dir: string;
let roster: RosterStore;

const custom = (name: string, model: string): AgentDef => ({
  name,
  purpose: 'Does a thing.',
  model,
  reasoningEffort: 'high',
  inheritDefaults: false,
  systemPrompt: 'Be careful.',
  userPrompt: 'Work on: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
});

beforeEach(() => {
  dir = tempDir('foundry-roster-hidden-models-');
  roster = new RosterStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hidden model pins', () => {
  it('resets matching agent models to inherit without changing reasoning defaults', () => {
    roster.save(custom('hidden_agent', 'openai/gpt-5'));
    roster.save(custom('visible_agent', 'anthropic/claude-sonnet-4'));

    roster.resetHiddenModelPins(['openai/gpt-5']);

    expect(roster.get('hidden_agent')).toMatchObject({
      model: 'inherit',
      reasoningEffort: 'high',
      inheritDefaults: false,
    });
    expect(roster.get('visible_agent')?.model).toBe('anthropic/claude-sonnet-4');
  });

  it('resets pins in an independent project roster', () => {
    const scope = { projectId: 'project-one', ownRoster: true };
    roster.save(custom('project_agent', 'openai/gpt-5'), scope);

    roster.resetHiddenModelPins(['openai/gpt-5'], scope);

    expect(roster.get('project_agent', scope)?.model).toBe('inherit');
  });
});
