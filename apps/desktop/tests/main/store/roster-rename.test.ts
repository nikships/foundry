/**
 * Renaming used to be a save under a new key, and `save` upserts by name: every
 * keystroke in the name field appended another agent, each inheriting
 * `builtin: true` from its source and so rendering without a Delete button.
 * These tests pin that a rename moves or forks, never accumulates.
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RosterStore } from '../../../src/main/store/roster.js';
import { PipelineStore } from '../../../src/main/store/pipelines.js';
import { JsonStore } from '../../../src/main/store/json-store.js';
import { BUILTIN_AGENTS } from '../../../src/shared/builtin-agents.js';
import type { AgentDef } from '../../../src/shared/types.js';

let dir: string;
let roster: RosterStore;

const custom = (name: string): AgentDef => ({
  name,
  purpose: 'Does a thing.',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 'Be careful.',
  userPrompt: 'Work on: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
});

beforeEach(() => {
  dir = tempDir('foundry-roster-');
  roster = new RosterStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('renaming a custom agent', () => {
  it('moves it rather than adding a second one', () => {
    roster.save(custom('helper'));
    const before = roster.list().length;

    const result = roster.rename('helper', 'assistant');

    expect(result.ok).toBe(true);
    expect(roster.list()).toHaveLength(before);
    expect(roster.get('helper')).toBeNull();
    expect(roster.get('assistant')).not.toBeNull();
  });

  it('keeps its position, so the strip does not reshuffle', () => {
    roster.save(custom('one'));
    roster.save(custom('two'));
    const index = roster.list().findIndex((a) => a.name === 'one');

    roster.rename('one', 'uno');

    expect(roster.list().findIndex((a) => a.name === 'uno')).toBe(index);
  });

  it('carries every other field across untouched', () => {
    roster.save({ ...custom('helper'), purpose: 'Distinct purpose.', color: '#c89bff' });

    roster.rename('helper', 'assistant');

    const moved = roster.get('assistant');
    expect(moved?.purpose).toBe('Distinct purpose.');
    expect(moved?.color).toBe('#c89bff');
  });
});

describe('renaming a shipped agent', () => {
  it('forks instead of moving, because absent built-ins are restored on read', () => {
    const result = roster.rename('planner', 'my-planner');

    expect(result.ok && result.forked).toBe(true);
    expect(roster.get('planner')).not.toBeNull();
    expect(roster.get('my-planner')).not.toBeNull();
  });

  it('clears builtin on the fork, so it can be deleted', () => {
    roster.rename('planner', 'my-planner');

    expect(roster.get('my-planner')?.builtin).toBe(false);
    expect(roster.remove('my-planner').some((a) => a.name === 'my-planner')).toBe(false);
  });

  it('reports edited shipped agents and resets only the selected agent', () => {
    const planner = roster.get('planner')!;
    roster.save({ ...planner, purpose: 'My custom planner.' });
    roster.save(custom('helper'));

    expect(roster.staleBuiltins()).toContain('planner');
    roster.resetBuiltin('planner');

    expect(roster.staleBuiltins()).not.toContain('planner');
    expect(roster.get('planner')).toEqual(BUILTIN_AGENTS.find((agent) => agent.name === 'planner'));
    expect(roster.get('helper')).not.toBeNull();
  });

  it('flags a shipped agent whose prompt no longer matches the seed', () => {
    const planner = roster.get('planner')!;
    roster.save({ ...planner, systemPrompt: 'Turn a request into a plan.' });

    expect(roster.staleBuiltins()).toContain('planner');
  });
});

describe('a rejected rename', () => {
  it('refuses a name another agent already holds', () => {
    roster.save(custom('helper'));

    const result = roster.rename('helper', 'planner');

    expect(result.ok).toBe(false);
    expect(roster.get('helper')).not.toBeNull();
  });

  it('refuses a name the schema would not accept', () => {
    roster.save(custom('helper'));

    const result = roster.rename('helper', 'Not Valid');

    expect(result.ok).toBe(false);
    expect(roster.list().some((a) => a.name === 'Not Valid')).toBe(false);
  });

  it('refuses to rename an agent that does not exist', () => {
    expect(roster.rename('ghost', 'phantom').ok).toBe(false);
  });

  it('treats renaming to the current name as a no-op', () => {
    roster.save(custom('helper'));
    const before = roster.list().length;

    expect(roster.rename('helper', 'helper').ok).toBe(true);
    expect(roster.list()).toHaveLength(before);
  });
});

describe('pipeline references', () => {
  it('repoints phases that name the renamed agent', () => {
    const pipelines = new PipelineStore(dir);
    const named = pipelines.list().filter((p) => p.phases.some((ph) => ph.agent === 'planner'));
    expect(named.length).toBeGreaterThan(0);

    pipelines.renameAgentRefs('planner', 'my-planner');

    for (const pipeline of pipelines.list()) {
      expect(pipeline.phases.some((ph) => ph.agent === 'planner')).toBe(false);
    }
    expect(
      pipelines.list().filter((p) => p.phases.some((ph) => ph.agent === 'my-planner')),
    ).toHaveLength(named.length);
  });

  it('leaves pipelines that never named it alone', () => {
    const pipelines = new PipelineStore(dir);
    const before = JSON.stringify(pipelines.list());

    pipelines.renameAgentRefs('nobody', 'someone');

    expect(JSON.stringify(pipelines.list())).toBe(before);
  });
});

describe('loading a roster written before pr_writer shipped', () => {
  it('restores the missing builtin without clobbering the rest of the file', () => {
    const older = BUILTIN_AGENTS.filter((a) => a.name !== 'pr_writer');
    expect(older.some((a) => a.name === 'pr_writer')).toBe(false);
    new JsonStore<AgentDef[]>(join(dir, 'roster.json'), () => []).write(older);

    const reloaded = new RosterStore(dir);
    const writer = reloaded.get('pr_writer');
    expect(writer?.builtin).toBe(true);
    expect(writer?.envelope).toBe('pr');
    expect(writer?.writes).toEqual([]);
    expect(reloaded.get('planner')?.builtin).toBe(true);
  });
});

describe('loading a roster written before the tool knobs were removed', () => {
  /** An agent as an older build wrote it: two tool lists nothing ever read. */
  const legacy = (): Record<string, unknown> => ({
    ...custom('helper'),
    tools: ['read', 'bash'],
    disabledTools: ['write'],
  });

  it('loads the agent and drops the fields nothing consumed', () => {
    new JsonStore<unknown[]>(join(dir, 'roster.json'), () => []).write([legacy()]);

    const helper = new RosterStore(dir).get('helper');

    expect(helper?.purpose).toBe('Does a thing.');
    expect(helper).not.toHaveProperty('tools');
    expect(helper).not.toHaveProperty('disabledTools');
  });

  it('drops a toolProfile from the wider enum rather than narrowing on a guess', () => {
    // `review` and `custom` were never wired to a tool list. Reading one as
    // read-only would take the shell away from an agent whose prompt expects it.
    new JsonStore<unknown[]>(join(dir, 'roster.json'), () => []).write([
      { ...custom('helper'), toolProfile: 'review' },
    ]);

    expect(new RosterStore(dir).get('helper')?.toolProfile).toBeUndefined();
  });

  it('keeps a profile this build still honours', () => {
    new JsonStore<unknown[]>(join(dir, 'roster.json'), () => []).write([
      { ...custom('helper'), toolProfile: 'read-only' },
    ]);

    expect(new RosterStore(dir).get('helper')?.toolProfile).toBe('read-only');
  });

  it('does not report a shipped agent as edited just because the file was normalized', () => {
    const stored = BUILTIN_AGENTS.map((agent) =>
      agent.name === 'scout' ? { ...agent, tools: ['read'], disabledTools: [] } : agent,
    );
    new JsonStore<unknown[]>(join(dir, 'roster.json'), () => []).write(stored);

    expect(new RosterStore(dir).staleBuiltins()).not.toContain('scout');
  });
});

describe('loading a roster written by the broken build', () => {
  it('clears builtin on a name that was never shipped, so it can be deleted', () => {
    const stranded = { ...BUILTIN_AGENTS[0]!, name: 'jjl', builtin: true };
    new JsonStore<AgentDef[]>(join(dir, 'roster.json'), () => []).write([
      ...BUILTIN_AGENTS,
      stranded,
    ]);

    const reloaded = new RosterStore(dir);

    expect(reloaded.get('jjl')?.builtin).toBe(false);
    expect(reloaded.get('planner')?.builtin).toBe(true);
  });
});
