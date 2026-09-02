/**
 * Smith's chat harness: the persona and entity schemas from the skill
 * survive; the CLI reference does not. The screen context renders as a
 * compact standing block, never a payload.
 */

import { describe, expect, it } from 'vitest';
import {
  compositionRuleBullets,
  isPhaseKind,
  PHASE_KINDS,
} from '../../../src/main/orchestrator/composition-rules.js';
import { ORCHESTRATOR_PROMPT } from '../../../src/main/orchestrator/plan.js';
import { SMITH_CHAT_HARNESS, screenContextBlock } from '../../../src/main/smith/system-prompt.js';
import { pipelineSchema } from '../../../src/main/store/pipelines.js';
import type { PhaseKind } from '../../../src/shared/types.js';

describe('SMITH_CHAT_HARNESS', () => {
  it('states the Smith identity and its place inside the app', () => {
    expect(SMITH_CHAT_HARNESS).toContain("You are Smith, Foundry's entity-smith");
    expect(SMITH_CHAT_HARNESS).toContain('inside the');
    expect(SMITH_CHAT_HARNESS).toContain('Foundry app');
  });

  it('keeps the Foundry vocabulary the skill taught', () => {
    for (const term of ['pipeline', 'agent', 'envelope', 'Gates', 'acceptance', 'worktree']) {
      expect(SMITH_CHAT_HARNESS).toContain(term);
    }
  });

  it('teaches Orchestrator as the default and Manual as opt-in', () => {
    expect(SMITH_CHAT_HARNESS).toContain('The Orchestrator is the default');
    expect(SMITH_CHAT_HARNESS).toContain('Manual pipelines are opt-in');
    expect(SMITH_CHAT_HARNESS).not.toContain('picks a pipeline');
    expect(SMITH_CHAT_HARNESS).toContain('smith_present');
    expect(SMITH_CHAT_HARNESS).toContain('sdlc-pr');
    const what = SMITH_CHAT_HARNESS.split('## How you work')[0]!;
    expect(what.toLowerCase().indexOf('orchestrator')).toBeGreaterThan(-1);
    expect(what.toLowerCase().indexOf('orchestrator')).toBeLessThan(
      what.toLowerCase().indexOf('manual'),
    );
  });

  it('does not teach engineer as a phase kind', () => {
    expect(SMITH_CHAT_HARNESS).not.toMatch(/`agent` \| `code` \| `engineer`/);
    expect(SMITH_CHAT_HARNESS).not.toContain('three kinds');
    expect(SMITH_CHAT_HARNESS).not.toContain('set `question`');
    expect(SMITH_CHAT_HARNESS).toContain('(`agent` | `code`)');
    expect(PHASE_KINDS).toEqual(['agent', 'code']);
    expect(isPhaseKind('engineer')).toBe(false);
    expect(isPhaseKind('question')).toBe(false);
    expect(isPhaseKind('agent')).toBe(true);
    // Compile-time: assigning 'engineer' to PhaseKind must be an error.
    // If this @ts-expect-error goes unused, engineer was restored as a kind.
    // @ts-expect-error engineer is not a PhaseKind
    const restored: PhaseKind = 'engineer';
    expect(restored).toBe('engineer');
    const parsed = pipelineSchema.safeParse({
      id: 'test-pipe',
      name: 'Test',
      description: 'A pipeline that must not accept engineer phases.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [{ name: 'ask', kind: 'engineer', description: 'ask the human' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('includes disapproval_halts and every agent phase names model + reasoningEffort', () => {
    expect(SMITH_CHAT_HARNESS).toContain('disapproval_halts');
    expect(SMITH_CHAT_HARNESS).toContain('verdict_consistent');
    expect(SMITH_CHAT_HARNESS).toContain('proven before any commit');
    expect(SMITH_CHAT_HARNESS).toContain(
      '**Every agent phase names its own model and reasoning level.**',
    );
    expect(SMITH_CHAT_HARNESS).toContain('reasoningEffort');
    expect(SMITH_CHAT_HARNESS).toContain(compositionRuleBullets());
    expect(ORCHESTRATOR_PROMPT).toContain(compositionRuleBullets());
  });

  it('carries the entity schemas: fields, enums, and reserved names', () => {
    expect(SMITH_CHAT_HARNESS).toContain('`reasoningEffort` (required)');
    expect(SMITH_CHAT_HARNESS).toContain('`writes` (required)');
    expect(SMITH_CHAT_HARNESS).toContain('all_phases_pass');
    expect(SMITH_CHAT_HARNESS).toContain('envelope_status');
    // The reserved base fields a custom envelope may not redeclare.
    for (const field of ['status', 'summary', 'artifacts', 'notes_for_next_agent']) {
      expect(SMITH_CHAT_HARNESS).toContain(field);
    }
    // The built-in envelope kinds a custom name may not collide with.
    for (const kind of ['generic', 'brief', 'plan', 'build', 'scout', 'review']) {
      expect(SMITH_CHAT_HARNESS).toContain(kind);
    }
  });

  it('keeps the approval contract: one card, no note, never re-propose the same spec', () => {
    expect(SMITH_CHAT_HARNESS).toContain('One proposal may be pending at a time');
    expect(SMITH_CHAT_HARNESS).toContain('rejection carries no note');
    expect(SMITH_CHAT_HARNESS).toContain('Never re-propose the same spec');
    expect(SMITH_CHAT_HARNESS).toContain('`show` before `edit`');
  });

  it('documents parity approvals and private secret handling', () => {
    expect(SMITH_CHAT_HARNESS).toContain('Read-only application operations execute immediately');
    expect(SMITH_CHAT_HARNESS).toContain('API keys are never tool arguments');
    expect(SMITH_CHAT_HARNESS).toContain('private operator displays');
    expect(SMITH_CHAT_HARNESS).toContain('All projects scope');
  });

  it('drops the CLI reference — the tools carry that contract now', () => {
    for (const gone of [
      'foundry-cli',
      'FOUNDRY_SMITH_PROJECT',
      'FOUNDRY_SMITH_SOCKET',
      'unix socket',
      '--file',
      'exit 2',
      'Ghostty',
      '/opt/homebrew',
      'app.asar',
    ]) {
      expect(SMITH_CHAT_HARNESS).not.toContain(gone);
    }
  });
});

describe('screenContextBlock', () => {
  it('names the route and the entity the operator is looking at', () => {
    const block = screenContextBlock({ route: 'runs', entity: { kind: 'run', id: 'run_42' } });
    expect(block).toContain('## Operator screen context');
    expect(block).toContain('runs — run run_42');
    expect(block).toContain('"this run"');
  });

  it('renders a route with no entity without inventing one', () => {
    const block = screenContextBlock({ route: 'settings' });
    expect(block).toContain('viewing: settings.');
    expect(block).not.toContain('—');
  });

  it('names a settings pane when the operator is in Settings', () => {
    const block = screenContextBlock({
      route: 'settings',
      entity: { kind: 'settings', id: 'models' },
    });
    expect(block).toContain('settings — settings models');
  });

  it('stays compact: a descriptor, not a payload', () => {
    const block = screenContextBlock({
      route: 'pipelines',
      entity: { kind: 'pipeline', id: 'ship-it' },
    });
    expect(block.split('\n').length).toBeLessThan(10);
  });
});
