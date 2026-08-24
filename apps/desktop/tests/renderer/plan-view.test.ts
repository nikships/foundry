import { describe, expect, it } from 'vitest';
import type { GeneratedRunPlan } from '@shared/types.js';
import {
  boundaryLabel,
  groupPlanWarnings,
  phaseNote,
  planCardView,
} from '@renderer/view-models/plan-view.js';

function generatedPlan(): GeneratedRunPlan {
  return {
    planId: 'plan-123',
    projectId: 'project-1',
    prompt: 'Fix the flaky search results.',
    refinedRequest:
      'Make search result ordering deterministic and prove the behavior with focused tests.',
    rationale: 'A bounded implementation followed by tests and an independent review.',
    pipeline: {
      id: 'generated-plan-123',
      name: 'Stabilize search results',
      description: 'Implement, prove, and independently review deterministic ordering.',
      builtin: false,
      acceptance: { kind: 'envelope_status', phase: 'review' },
      phases: [
        {
          name: 'build',
          kind: 'agent',
          description: 'Implement deterministic search ordering.',
          agent: 'search_specialist',
          gates: ['boundary_respected'],
        },
        {
          name: 'test',
          kind: 'code',
          description: 'Run the focused search tests.',
          command: { ref: 'test' },
          feedbackTo: 'build',
        },
        {
          name: 'checkpoint',
          kind: 'engineer',
          description: 'Confirm the behavior before review.',
          question: 'Continue to review?',
        },
        {
          name: 'review',
          kind: 'agent',
          description: 'Review the implementation and evidence.',
          agent: 'reviewer',
          gates: ['verdict_consistent', { gate: 'disapproval_halts' }],
        },
      ],
    },
    agents: [
      {
        name: 'search_specialist',
        purpose: 'Own the narrowly bounded search implementation.',
        model: 'anthropic/claude-opus-4',
        reasoningEffort: 'high',
        systemPrompt: 'Implement the requested change.',
        userPrompt: '{{request}}',
        writes: ['src/search/**'],
        envelope: 'build',
        color: '#7c6ee6',
      },
      {
        name: 'reviewer',
        purpose: 'Independently judge the implementation and evidence.',
        model: 'inherit',
        reasoningEffort: 'medium',
        systemPrompt: 'Review without editing.',
        userPrompt: '{{request}}',
        writes: [],
        toolProfile: 'read-only',
        envelope: 'review',
        color: '#4aa776',
      },
    ],
    warnings: [
      { level: 'warning', where: 'phases[1]', message: 'Command uses project default.' },
      { level: 'warning', where: 'pipeline', message: 'GitHub CLI is unavailable.' },
      { level: 'warning', where: 'phases[1]', message: 'Command uses project default.' },
      { level: 'warning', where: 'phases[1]', message: 'Healing remains enabled.' },
    ],
    model: 'bridge-anthropic/claude-opus-4',
    reasoningEffort: 'high',
  };
}

describe('plan-view', () => {
  it('shapes the full operator-facing plan card', () => {
    const view = planCardView(generatedPlan());

    expect(view.title).toBe('Stabilize search results');
    expect(view.description).toContain('independently review');
    expect(view.summary).toBe('4 phases · 2 synthesized agents');
    expect(view.refinedRequest).toContain('deterministic');
    expect(view.rationale).toContain('bounded implementation');
    expect(view.orchestratorModel).toBe('claude-opus-4');
    expect(view.acceptance).toBe('Accepted when the report returned by "review" reports success.');

    expect(view.phases.map((phase) => phase.name)).toEqual([
      'build',
      'test',
      'checkpoint',
      'review',
    ]);
    expect(view.phases[0]).toMatchObject({ synthesized: true, decides: false });
    expect(view.phases[1]?.note).toBe('runs "test" · fails back to build');
    expect(view.phases[2]?.note).toBe('waits for you');
    expect(view.phases[3]).toMatchObject({
      synthesized: true,
      decides: true,
      note: 'gates: verdict_consistent, disapproval_halts',
    });

    expect(view.agents[0]).toMatchObject({
      model: 'claude-opus-4',
      boundary: 'writes src/search/**',
      readOnly: false,
    });
    expect(view.agents[1]).toMatchObject({
      model: 'inherits the default model',
      boundary: 'read-only',
      readOnly: true,
    });
  });

  it('groups warnings by location, preserving order and removing duplicates', () => {
    expect(groupPlanWarnings(generatedPlan().warnings)).toEqual([
      {
        where: 'phases[1]',
        messages: ['Command uses project default.', 'Healing remains enabled.'],
      },
      { where: 'pipeline', messages: ['GitHub CLI is unavailable.'] },
    ]);
  });

  it('labels write boundaries without hiding extra paths', () => {
    expect(boundaryLabel(null)).toBe('writes anywhere (minus protected paths)');
    expect(boundaryLabel([])).toBe('read-only');
    expect(boundaryLabel(['src/**', 'tests/**', 'docs/**'])).toBe(
      'writes src/**, tests/**, docs/**',
    );
    expect(boundaryLabel(['src/**', 'tests/**', 'docs/**', 'package.json'])).toBe(
      'writes src/**, tests/**, docs/** +1 more',
    );
  });

  it('summarizes builtin and argv command phases', () => {
    expect(
      phaseNote({
        name: 'commit',
        kind: 'code',
        description: 'Commit the work.',
        command: { builtin: 'git_commit' },
      }),
    ).toBe('git commit');
    expect(
      phaseNote({
        name: 'custom_test',
        kind: 'code',
        description: 'Run a custom check.',
        command: { argv: ['npm', 'test', '--', 'search'] },
      }),
    ).toBe('npm test -- search');
  });
});
