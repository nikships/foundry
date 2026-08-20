/**
 * Prompt rendering: system and user stay separate, and the disk record
 * shows both roles the model actually received.
 */

import { describe, expect, it } from 'vitest';
import {
  formatPromptRecord,
  renderPrompt,
  type RenderContext,
} from '../../../src/main/engine/prompts.js';
import type { AgentDef, PhaseDef } from '../../../src/shared/types.js';

const agent: AgentDef = {
  name: 'builder',
  purpose: 'build',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.\n\nStay in {{worktree}}.',
  userPrompt: 'Do {{request}}.',
  writes: null,
  envelope: 'build',
  color: '#000',
};

const phase: PhaseDef = {
  name: 'build',
  kind: 'agent',
  agent: 'builder',
  description: 'build it',
};

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    request: 'the thing',
    runId: 'run_1',
    worktree: '/tmp/wt',
    handoffDir: '/tmp/wt/.foundry-handoff',
    handoffFiles: [],
    envelopes: new Map(),
    ...overrides,
  };
}

describe('renderPrompt', () => {
  it('keeps the persona in system and the ask in user', () => {
    const rendered = renderPrompt(agent, phase, ctx());
    expect(rendered.system).toContain('You build.');
    expect(rendered.system).toContain('/tmp/wt');
    expect(rendered.user).toContain('Do the thing.');
    expect(rendered.user).not.toContain('You build.');
  });

  it('tells the agent to call submit_envelope, not to dump JSON as the reply', () => {
    const rendered = renderPrompt(agent, phase, ctx());
    expect(rendered.user).toMatch(/submit_envelope/);
    expect(rendered.user).not.toMatch(/Reply with ONLY this JSON/);
  });

  it('uses a declared improved request in place of the raw request', () => {
    const refinedPhase: PhaseDef = {
      ...phase,
      prompt: { inputs: ['envelope:refine.improved_request'] },
    };
    const rendered = renderPrompt(
      agent,
      refinedPhase,
      ctx({
        envelopes: new Map([
          [
            'refine',
            {
              status: 'success',
              summary: 'refined',
              artifacts: [],
              notes_for_next_agent: '',
              improved_request: 'the repository-grounded brief',
            },
          ],
        ]),
      }),
    );

    expect(rendered.user).toContain('Do the repository-grounded brief.');
    expect(rendered.user).not.toContain('the thing');
    expect(rendered.user.match(/repository-grounded brief/g)).toHaveLength(1);
  });
});

describe('formatPromptRecord', () => {
  it('writes both roles so the trace matches what the model received', () => {
    const record = formatPromptRecord(renderPrompt(agent, phase, ctx()));
    expect(record).toMatch(/^# System\n/);
    expect(record).toContain('# User');
    expect(record).toContain('You build.');
    expect(record).toContain('Do the thing.');
  });
});
