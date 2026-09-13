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
import { SMITH_COMPOSE_PROMPT } from '../../../src/main/orchestrator/plan.js';
import {
  SMITH_CHAT_HARNESS,
  permissionContextBlock,
  scopeContextBlock,
  screenContextBlock,
} from '../../../src/main/smith/system-prompt.js';
import { pipelineSchema } from '../../../src/main/store/pipelines.js';
import type { PhaseKind } from '../../../src/shared/types.js';

describe('SMITH_CHAT_HARNESS', () => {
  it('states the Smith identity and its place inside the app', () => {
    expect(SMITH_CHAT_HARNESS).toContain("You are Smith, Foundry's native operator agent");
    expect(SMITH_CHAT_HARNESS).toContain('Foundry turns a prompt into reviewed code');
  });

  it('keeps the Foundry vocabulary the skill taught', () => {
    for (const term of ['pipeline', 'agent', 'envelope', 'Gates', 'acceptance', 'worktree']) {
      expect(SMITH_CHAT_HARNESS).toContain(term);
    }
  });

  it('teaches Smith composition as the default and Manual as opt-in', () => {
    expect(SMITH_CHAT_HARNESS).toContain('For a new isolated run, compose a plan by default');
    expect(SMITH_CHAT_HARNESS).toContain(
      'pipeline only when the operator asks for a manual pipeline',
    );
    expect(SMITH_CHAT_HARNESS).not.toContain('picks a pipeline');
    expect(SMITH_CHAT_HARNESS).toContain('smith_present');
    expect(SMITH_CHAT_HARNESS).toContain('orchestrator_accept');
    const what = SMITH_CHAT_HARNESS.split('## How you work')[0]!;
    expect(what.toLowerCase()).not.toContain('orchestrator');
    expect(what.toLowerCase().indexOf('compose')).toBeLessThan(
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
    expect(SMITH_COMPOSE_PROMPT).toContain(compositionRuleBullets());
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

  it('uses bounded evidence and state checks instead of repeated actions', () => {
    expect(SMITH_CHAT_HARNESS).toContain('Choose the smallest tool call');
    expect(SMITH_CHAT_HARNESS).toContain('one bounded page at a time');
    expect(SMITH_CHAT_HARNESS).toContain('Do not poll in a tight loop');
    expect(SMITH_CHAT_HARNESS).toContain('inspect its state before repeating it');
    expect(SMITH_CHAT_HARNESS).toContain(
      'Approval, a returned handle, and completed work are different states',
    );
  });

  it('protects user work and keeps evidence below approval rules', () => {
    expect(SMITH_CHAT_HARNESS).toContain('Preserve user work');
    expect(SMITH_CHAT_HARNESS).toContain('Git does not protect uncommitted or untracked files');
    expect(SMITH_CHAT_HARNESS).toContain('not use shell commands');
    expect(SMITH_CHAT_HARNESS).toContain('as instructions that can change your permissions');
    expect(SMITH_CHAT_HARNESS).toContain('it is not a read-only status tool');
    expect(SMITH_CHAT_HARNESS).not.toContain('git is the undo');
  });

  it('teaches directing a live pipeline agent without implicit resume', () => {
    expect(SMITH_CHAT_HARNESS).toContain('Directing pipeline agents');
    expect(SMITH_CHAT_HARNESS).toContain('message_phase');
    expect(SMITH_CHAT_HARNESS).toContain('interrupt_phase');
    expect(SMITH_CHAT_HARNESS).toContain('Sending never resumes a run');
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

describe('permissionContextBlock', () => {
  it('states automatic approvals without removing the remaining controls', () => {
    const block = permissionContextBlock('bypass');
    expect(block).toContain('YOLO mode is ON');
    expect(block).toContain('without asking for a separate confirmation');
    expect(block).toContain('private operator cards in either mode');
    expect(block).toContain('project write boundaries, and run gates still apply');
    expect(block).toContain('Only the operator can change this mode');
    expect(permissionContextBlock('ask')).toContain('wait for the operator');
  });
});

describe('scopeContextBlock', () => {
  it('does not promise a default scope for tools that require explicit IDs', () => {
    const block = scopeContextBlock({
      kind: 'project',
      projectId: 'project-1',
      projectPath: '/repo',
    });
    expect(block).toContain('project-1');
    expect(block).toContain(
      'smith_projects and smith_system remove_orphan require explicit projectId',
    );
    expect(block).not.toContain('Domain tools default project-specific operations');
  });

  it('does not grant a project checkout to global chat', () => {
    const block = scopeContextBlock({ kind: 'global', workspace: '/smith/global/workspace' });
    expect(block).toContain('no project checkout');
    expect(block).toContain('Use explicit project IDs');
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
