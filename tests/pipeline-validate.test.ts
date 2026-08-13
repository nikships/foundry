import { describe, expect, it } from 'vitest';
import { validate } from '../src/main/store/pipelines.js';
import { effectivePhaseEnvelope } from '../src/shared/types.js';
import type { AgentDef, PhaseDef, PipelineDef } from '../src/shared/types.js';

function agent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    name: 'builder',
    purpose: 'Implements the plan.',
    model: 'inherit',
    reasoningEffort: 'medium',
    systemPrompt: 'Be careful.',
    userPrompt: 'Work on: {{request}}',
    writes: null,
    envelope: 'build',
    color: '#5ad2dd',
    ...over,
  };
}

function phase(over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    name: 'review',
    kind: 'agent',
    description: 'Judge the work against the request.',
    agent: 'reviewer',
    prompt: { template: 'user', inputs: ['request'] },
    ...over,
  };
}

function pipeline(over: Partial<PipelineDef> = {}): PipelineDef {
  return {
    id: 'test-pipe',
    name: 'Test',
    description: 'A test pipeline for envelope inheritance.',
    acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
    phases: [phase()],
    ...over,
  };
}

const reviewer = agent({ name: 'reviewer', envelope: 'review' });
const builder = agent();

describe('effectivePhaseEnvelope', () => {
  it('inherits the agent envelope when the phase has no override', () => {
    expect(effectivePhaseEnvelope(phase(), [reviewer])).toBe('review');
  });

  it('keeps an explicit phase override even when the agent differs', () => {
    expect(effectivePhaseEnvelope(phase({ envelope: 'scout' }), [reviewer])).toBe('scout');
  });

  it('returns undefined when neither the phase nor a matching agent declares one', () => {
    expect(effectivePhaseEnvelope(phase({ agent: 'missing' }), [reviewer])).toBeUndefined();
  });
});

describe('pipeline.validate acceptance envelope', () => {
  it('accepts approved when the phase inherits review from its agent', () => {
    expect(validate(pipeline(), [reviewer], [])).toEqual([]);
  });

  it('accepts approved when the phase explicitly declares review', () => {
    const issues = validate(pipeline({ phases: [phase({ envelope: 'review' })] }), [reviewer], []);
    expect(issues).toEqual([]);
  });

  it('warns when an explicit non-review envelope is pinned on the phase', () => {
    const issues = validate(pipeline({ phases: [phase({ envelope: 'build' })] }), [reviewer], []);
    expect(issues).toEqual([
      {
        level: 'warning',
        where: 'acceptance',
        message: '"approved" comes from a review envelope; "review" declares build',
      },
    ]);
  });

  it('warns when the inherited agent envelope is not review', () => {
    const issues = validate(
      pipeline({ phases: [phase({ agent: 'builder' })] }),
      [builder, reviewer],
      [],
    );
    expect(issues).toEqual([
      {
        level: 'warning',
        where: 'acceptance',
        message: '"approved" comes from a review envelope; "review" declares build',
      },
    ]);
  });

  it('warns with none when the phase agent is missing from the roster', () => {
    const issues = validate(pipeline(), [builder], []);
    expect(
      issues.some((issue) => issue.level === 'error' && issue.message.includes('no agent')),
    ).toBe(true);
    expect(issues).toContainEqual({
      level: 'warning',
      where: 'acceptance',
      message: '"approved" comes from a review envelope; "review" declares none',
    });
  });

  it('warns when an explicit envelope is not in the library', () => {
    const issues = validate(
      pipeline({
        acceptance: { kind: 'last_phase_pass' },
        phases: [phase({ envelope: 'deleted_shape' })],
      }),
      [reviewer],
      [],
    );
    expect(issues).toEqual([
      {
        level: 'warning',
        where: 'phases[0] review',
        message: 'envelope "deleted_shape" is not in the library — runs will fall back to generic',
      },
    ]);
  });

  it('errors when acceptance names a phase that does not exist', () => {
    const issues = validate(
      pipeline({ acceptance: { kind: 'phase_flag', phase: 'missing', flag: 'approved' } }),
      [reviewer],
      [],
    );
    expect(issues).toContainEqual({
      level: 'error',
      where: 'acceptance',
      message: 'acceptance names phase "missing", which does not exist',
    });
  });

  it('allows a new agent phase with no envelope override', () => {
    const fresh = pipeline({
      acceptance: { kind: 'last_phase_pass' },
      phases: [
        phase({
          name: 'new_agent',
          agent: 'builder',
          description: 'Do the implementation work for this run.',
        }),
      ],
    });
    expect(fresh.phases[0]!.envelope).toBeUndefined();
    expect(validate(fresh, [builder], [])).toEqual([]);
  });
});
