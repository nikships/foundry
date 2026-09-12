/**
 * Smith pipeline-healing proposal adapter. One-shot, read-only, Smith-owned.
 */

import { describe, expect, it } from 'vitest';
import { FIXED_ENGINE_DEFAULTS } from '../../../src/shared/types.js';
import type { AppSettings } from '../../../src/shared/types.js';
import {
  AMENDMENT_OUTPUT_FORMAT,
  REPLAN_SYSTEM_PROMPT,
  buildReplanPrompt,
  replanningSupport,
  resolvePipelineHealingModel,
} from '../../../src/main/orchestrator/replan.js';
import { scriptedOneShots } from '../../helpers/scripted-oneshot.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import type { PhaseDef } from '../../../src/shared/types.js';

function codePhase(name: string, argv: string[]): PhaseDef {
  return { name, kind: 'code', description: `Do ${name}.`, command: { argv } };
}

function baseInput() {
  return {
    request: 'Make the thing pass.',
    pipeline: {
      id: 'p',
      name: 'p',
      description: 'test pipeline',
      acceptance: { kind: 'all_phases_pass' } as const,
      phases: [codePhase('broken', ['false'])],
    },
    allowedModels: [{ model: 'scripted', reasoningEffort: 'medium' as const }],
    roster: [
      {
        name: 'builder',
        purpose: 'build things',
        model: 'scripted',
        reasoningEffort: 'medium' as const,
        systemPrompt: 'You build.',
        userPrompt: 'Build {{request}}.',
        writes: null,
        envelope: 'build',
        color: '#5ad2dd',
      },
    ],
    commands: [{ name: 'test', argv: ['npm', 'test'] }],
    failedPhase: codePhase('broken', ['false']),
    completed: [{ phase: codePhase('prepare', ['true']) }],
    remaining: [codePhase('stale', ['true'])],
    evidence: 'broken exited 1',
    attempt: 1,
  };
}

function validReply() {
  return {
    reason: 'Repair the broken command.',
    phases: [codePhase('broken', ['true'])],
    agents: [],
  };
}

describe('Smith repair adapter', () => {
  it('opens and sends exactly once on success, even with envelope retries configured', async () => {
    expect(FIXED_ENGINE_DEFAULTS.envelopeRetries).toBeGreaterThan(0);
    const shots = scriptedOneShots([{ structuredOutput: validReply() }]);
    const support = replanningSupport(
      shots.factory,
      { model: 'smith/model', reasoningEffort: 'medium' },
      () => '/tmp',
    );
    const amendment = await support.propose(baseInput());
    expect(amendment?.reason).toBe('Repair the broken command.');
    expect(shots.calls).toHaveLength(1);
    expect(shots.prompts).toHaveLength(1);
  });

  it('opens once on schema error and throws with field issues', async () => {
    const shots = scriptedOneShots([{ structuredOutput: { reason: 'missing phases and agents' } }]);
    const support = replanningSupport(
      shots.factory,
      { model: 'smith/model', reasoningEffort: 'medium' },
      () => '/tmp',
    );
    await expect(support.propose(baseInput())).rejects.toThrow(/phases/);
    expect(shots.calls).toHaveLength(1);
  });

  it('returns null on no structured submission without throwing', async () => {
    const shots = scriptedOneShots([{ text: 'no amendment' }]);
    const support = replanningSupport(
      shots.factory,
      { model: 'smith/model', reasoningEffort: 'medium' },
      () => '/tmp',
    );
    await expect(support.propose(baseInput())).resolves.toBeNull();
    expect(shots.calls).toHaveLength(1);
  });

  it('propagates a model error after exactly one session', async () => {
    const shots = scriptedOneShots([{ throws: 'provider exploded' }]);
    const support = replanningSupport(
      shots.factory,
      { model: 'smith/model', reasoningEffort: 'medium' },
      () => '/tmp',
    );
    await expect(support.propose(baseInput())).rejects.toThrow('provider exploded');
    expect(shots.calls).toHaveLength(1);
  });

  it('returns null for an interrupted turn', async () => {
    const shots = scriptedOneShots([{ interrupted: true }]);
    const support = replanningSupport(
      shots.factory,
      { model: 'smith/model', reasoningEffort: 'medium' },
      () => '/tmp',
    );
    await expect(support.propose(baseInput())).resolves.toBeNull();
  });

  it('aborts the session in every path and prevents open after abort', async () => {
    const shots = scriptedOneShots([{ structuredOutput: validReply() }]);
    const support = replanningSupport(
      shots.factory,
      { model: 'smith/model', reasoningEffort: 'medium' },
      () => '/tmp',
    );
    support.abort?.();
    await expect(support.propose(baseInput())).resolves.toBeNull();
    expect(shots.calls).toHaveLength(0);
  });

  it('uses read-only access with a schema-bound output', async () => {
    const shots = scriptedOneShots([{ structuredOutput: validReply() }]);
    const support = replanningSupport(
      shots.factory,
      { model: 'smith/model', reasoningEffort: 'medium' },
      () => '/cwd',
    );
    await support.propose(baseInput());
    expect(shots.calls[0]).toMatchObject({
      access: 'read',
      model: 'smith/model',
      cwd: '/cwd',
      outputFormat: { type: 'json_schema' },
    });
    expect(AMENDMENT_OUTPUT_FORMAT.type).toBe('json_schema');
  });

  it('identifies as Smith and carries phase, acceptance, command, and evidence context', async () => {
    const shots = scriptedOneShots([{ structuredOutput: validReply() }]);
    const support = replanningSupport(
      shots.factory,
      { model: 'smith/model', reasoningEffort: 'medium' },
      () => '/tmp',
    );
    await support.propose({
      ...baseInput(),
      previousIssues: ['phases[1] broken: missing command'],
    });
    expect(REPLAN_SYSTEM_PROMPT).toMatch(/^You are Smith, repairing this Foundry pipeline\./);
    expect(REPLAN_SYSTEM_PROMPT).toContain('{"reason":"');
    expect(REPLAN_SYSTEM_PROMPT).toContain('phases":[]');
    expect(shots.calls[0]!.systemPrompt).toContain('You are Smith');
    const prompt = shots.prompts[0]!;
    expect(prompt).toContain('Make the thing pass.');
    expect(prompt).toContain('broken');
    expect(prompt).toContain('all_phases_pass');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('broken exited 1');
    expect(prompt).toContain('phases[1] broken: missing command');
    expect(prompt).toContain('{"reason":"');
  });

  it('never leaks full roster prompts', () => {
    const prompt = buildReplanPrompt({
      ...baseInput(),
      roster: [
        {
          name: 'secret',
          purpose: 'secret purpose',
          model: 'scripted',
          reasoningEffort: 'medium',
          systemPrompt: 'SECRET_SYSTEM_PROMPT_MUST_NOT_LEAK',
          userPrompt: 'SECRET_USER_PROMPT_MUST_NOT_LEAK',
          writes: [],
          envelope: 'build',
          color: '#000000',
        },
      ],
    });
    expect(prompt).toContain('secret: secret purpose');
    expect(prompt).not.toContain('SECRET_SYSTEM_PROMPT_MUST_NOT_LEAK');
    expect(prompt).not.toContain('SECRET_USER_PROMPT_MUST_NOT_LEAK');
  });

  it('resolves the Smith model from settings, not planning or healing models', () => {
    const base = defaultSettings();
    const concrete: AppSettings = { ...base, smithModel: 'smith/s', smithReasoningEffort: 'high' };
    expect(resolvePipelineHealingModel(concrete)).toEqual({
      model: 'smith/s',
      reasoningEffort: 'high',
    });
    const inherited: AppSettings = {
      ...base,
      smithModel: 'inherit',
      defaultModel: 'def/d',
      defaultReasoningEffort: 'low',
      smithReasoningEffort: 'high',
    };
    expect(resolvePipelineHealingModel(inherited)).toEqual({
      model: 'def/d',
      reasoningEffort: 'low',
    });
    const both: AppSettings = {
      ...base,
      smithModel: 'inherit',
      defaultModel: 'inherit',
      smithReasoningEffort: 'high',
    };
    expect(resolvePipelineHealingModel(both)).toEqual({
      model: 'inherit',
      reasoningEffort: 'high',
    });
  });
});
