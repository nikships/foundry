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

  it('leaves envelope submission instructions to the system harness', () => {
    const rendered = renderPrompt(agent, phase, ctx());
    expect(rendered.user).not.toMatch(/submit_envelope/);
    expect(rendered.user).not.toMatch(/Reply with ONLY this JSON/);
    expect(rendered.user).toContain('"commit_message"');
  });

  it('renders supplied bounded git context before the report schema', () => {
    const rendered = renderPrompt(
      agent,
      phase,
      ctx({
        branch: 'foundry/run_1',
        baseRef: 'main',
        gitContext: { branchPointSha: 'abc123', diffStat: 'README.md | 2 +-' },
      }),
    );
    expect(rendered.user).toContain('## Accumulated git context');
    expect(rendered.user).toContain('- Branch: foundry/run_1');
    expect(rendered.user).toContain('- Base ref: main');
    expect(rendered.user).toContain('- Branch point: abc123');
    expect(rendered.user).toContain('README.md | 2 +-');
    expect(rendered.user.indexOf('## Accumulated git context')).toBeLessThan(
      rendered.user.indexOf('## Report'),
    );
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
