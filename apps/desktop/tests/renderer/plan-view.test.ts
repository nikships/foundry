import { describe, expect, it } from 'vitest';
import type { GeneratedRunPlan } from '@shared/types.js';
import {
  allPlanExportSelection,
  boundaryLabel,
  groupPlanWarnings,
  overriddenPhases,
  planExportItemIssues,
  planExportSelectionCount,
  planExportView,
  planHasActiveFailure,
  phaseNote,
  planCardView,
  togglePlanExportSelection,
  withPhaseModel,
  withPhaseReasoningEffort,
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
          model: 'anthropic/claude-opus-4',
          reasoningEffort: 'high',
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
          name: 'review',
          kind: 'agent',
          description: 'Review the implementation and evidence.',
          agent: 'reviewer',
          model: 'anthropic/claude-haiku-4',
          reasoningEffort: 'low',
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
    expect(view.summary).toBe('3 phases · 2 synthesized agents');
    expect(view.refinedRequest).toContain('deterministic');
    expect(view.rationale).toContain('bounded implementation');
    expect(view.orchestratorModel).toBe('claude-opus-4');
    expect(view.acceptance).toBe('Accepted when the report returned by "review" reports success.');

    expect(view.phases.map((phase) => phase.name)).toEqual(['build', 'test', 'review']);
    expect(view.phases[0]).toMatchObject({
      synthesized: true,
      decides: false,
      model: 'anthropic/claude-opus-4',
      reasoningEffort: 'high',
    });
    expect(view.phases[1]?.note).toBe('runs "test" · fails back to build');
    // Only agent phases carry an appointment; a command has no model to override.
    expect(view.phases[1]?.model).toBeNull();
    expect(view.phases[2]).toMatchObject({
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
      model: 'model set per phase',
      boundary: 'read-only',
      readOnly: true,
    });
  });

  it('re-casts one agent phase onto another model and leaves the rest identical', () => {
    const proposed = generatedPlan();
    const overridden = withPhaseModel(proposed, 'review', 'openai/gpt-5');

    // The override travels as a real edit to the pipeline, because that is the
    // value `startRun` re-validates at the privileged boundary.
    expect(overridden.pipeline.phases[2]?.model).toBe('openai/gpt-5');
    expect(overridden.pipeline.phases[0]?.model).toBe('anthropic/claude-opus-4');
    expect(overridden.refinedRequest).toBe(proposed.refinedRequest);
    expect(overridden.agents).toEqual(proposed.agents);
    // The proposal itself is untouched, so "restore proposed models" can undo.
    expect(proposed.pipeline.phases[2]?.model).toBe('anthropic/claude-haiku-4');
  });

  it('overrides one phase reasoning effort and marks the appointment changed', () => {
    const proposed = generatedPlan();
    const overridden = withPhaseReasoningEffort(proposed, 'review', 'high');

    expect(overridden.pipeline.phases[2]?.reasoningEffort).toBe('high');
    expect(overridden.pipeline.phases[0]?.reasoningEffort).toBe('high');
    expect([...overriddenPhases(proposed, overridden)]).toEqual(['review']);
    expect(proposed.pipeline.phases[2]?.reasoningEffort).toBe('low');
  });

  it('leaves a code phase alone when its name is handed to withPhaseModel', () => {
    const proposed = generatedPlan();
    const attempted = withPhaseModel(proposed, 'test', 'openai/gpt-5');

    expect(attempted.pipeline.phases[1]).toEqual(proposed.pipeline.phases[1]);
    expect(overriddenPhases(proposed, attempted).size).toBe(0);
  });

  it('reports which phases the operator re-cast', () => {
    const proposed = generatedPlan();
    const once = withPhaseModel(proposed, 'review', 'openai/gpt-5');
    expect([...overriddenPhases(proposed, once)]).toEqual(['review']);

    // Choosing the proposed model again is no longer an override.
    const back = withPhaseModel(once, 'review', 'anthropic/claude-haiku-4');
    expect(overriddenPhases(proposed, back).size).toBe(0);
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

  it('shapes ordinary export identities without preserving the generated plan id', () => {
    const view = planExportView(generatedPlan());

    expect(view.pipeline).toMatchObject({
      name: 'Stabilize search results',
      id: 'stabilize-search-results',
    });
    expect(view.pipeline.id).not.toContain('plan-123');
    expect(view.agents.map((agent) => agent.name)).toEqual(['search_specialist', 'reviewer']);
  });

  it('builds and updates export checkbox selections', () => {
    const all = allPlanExportSelection(generatedPlan());
    expect(all).toEqual({ pipeline: true, agents: ['search_specialist', 'reviewer'] });
    expect(planExportSelectionCount(all)).toBe(3);

    const withoutPipeline = togglePlanExportSelection(all, 'pipeline', false);
    const withoutReviewer = togglePlanExportSelection(withoutPipeline, 'agent:reviewer', false);
    expect(withoutReviewer).toEqual({ pipeline: false, agents: ['search_specialist'] });
    expect(planExportSelectionCount(withoutReviewer)).toBe(1);
    expect(togglePlanExportSelection(withoutReviewer, 'agent:reviewer', true).agents).toEqual([
      'search_specialist',
      'reviewer',
    ]);
  });

  it('maps collision and validation issues to their export row', () => {
    const issues = [
      { level: 'error' as const, where: 'pipeline', message: 'already exists' },
      { level: 'error' as const, where: 'pipeline.phases[0]', message: 'missing agent' },
      { level: 'error' as const, where: 'agent:reviewer.name', message: 'invalid name' },
      { level: 'error' as const, where: 'selection', message: 'choose something' },
    ];

    expect(planExportItemIssues(issues, 'pipeline').map((issue) => issue.message)).toEqual([
      'already exists',
      'missing agent',
    ]);
    expect(planExportItemIssues(issues, 'agent:reviewer')).toEqual([issues[2]]);
  });

  it('ignores superseded and removed failures when deciding whether Continue applies', () => {
    const plan = generatedPlan();
    const phase = (phaseId: string, name: string, status: 'fail' | 'success', seq: number) => ({
      phaseId,
      runId: 'run-1',
      seq,
      name,
      kind: 'agent' as const,
      owner: 'builder',
      description: name,
      status,
      attempt: 0,
      error: null,
      startedAt: null,
      endedAt: null,
    });
    const history = [
      phase('old-build', 'build', 'fail', 0),
      phase('removed', 'obsolete', 'fail', 1),
      phase('new-build', 'build', 'success', 2),
      phase('test', 'test', 'success', 3),
      phase('checkpoint', 'checkpoint', 'success', 4),
      phase('review', 'review', 'success', 5),
    ];

    expect(planHasActiveFailure(plan, history)).toBe(false);
    history[5] = phase('review', 'review', 'fail', 5);
    expect(planHasActiveFailure(plan, history)).toBe(true);
  });
});
