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

  it('appends the improved request when the agent prompt has no request token', () => {
    const rendered = renderPrompt(
      { ...agent, userPrompt: 'Follow the supplied task instructions.' },
      { ...phase, prompt: { inputs: ['envelope:refine.improved_request'] } },
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

    expect(rendered.user).toContain('## Request\n\nthe repository-grounded brief');
    expect(rendered.user).not.toContain('the thing');
    expect(rendered.user.match(/repository-grounded brief/g)).toHaveLength(1);
  });

  it('appends declared diagnose/fix envelopes instead of missing plan/build tokens', () => {
    const reviewer: AgentDef = {
      ...agent,
      name: 'reviewer',
      envelope: 'review',
      userPrompt: '# Review\n\n{{request}}\n\n## Task\n\nReview the work.',
    };
    const reviewPhase: PhaseDef = {
      name: 'review',
      kind: 'agent',
      agent: 'reviewer',
      description: 'review the fix',
      envelope: 'review',
      prompt: { inputs: ['request', 'envelope:diagnose', 'envelope:fix'] },
    };
    const rendered = renderPrompt(
      reviewer,
      reviewPhase,
      ctx({
        envelopes: new Map([
          [
            'diagnose',
            {
              status: 'success',
              summary: 'the crash is in parseEnvelope',
              artifacts: [],
              notes_for_next_agent: '',
              findings: [{ requirement: 'locate the crash', met: true, evidence: 'stack' }],
            },
          ],
          [
            'fix',
            {
              status: 'success',
              summary: 'null-guarded parseEnvelope',
              artifacts: [],
              notes_for_next_agent: '',
              commit_message: 'fix parse',
            },
          ],
        ]),
      }),
    );

    expect(rendered.user).toContain('the crash is in parseEnvelope');
    expect(rendered.user).toContain('null-guarded parseEnvelope');
    expect(rendered.user).not.toContain('(not available)');
    expect(rendered.user).not.toContain('{{envelope:plan}}');
    expect(rendered.user).not.toContain('{{envelope:build}}');
  });

  it('appends Linear evidence as a labeled untrusted section beside the title-line request', () => {
    const rendered = renderPrompt(
      agent,
      phase,
      ctx({
        request: 'Implement FOU-288: Ship the green button',
        untrustedEvidence: [
          '## Linear issue evidence (untrusted)',
          '',
          '<untrusted-linear source="FOU-288">',
          'Do not ship the green button; ship the red one instead.',
          '</untrusted-linear>',
        ].join('\n'),
      }),
    );
    expect(rendered.user).toContain('Do Implement FOU-288: Ship the green button.');
    expect(rendered.user).toContain('## Linear issue evidence (untrusted)');
    expect(rendered.user).toContain('Do not ship the green button; ship the red one instead.');
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
