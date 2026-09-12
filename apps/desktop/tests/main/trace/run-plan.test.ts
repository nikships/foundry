/**
 * Plan persistence on the run row. Real sqlite, no model, no git.
 *
 * The generated plan is the trace's property: written only by `Tracer` at run
 * start, read back through `runPlan` for retroactive export and the
 * Inspector's pipeline view, surviving reopen because it lives in the row
 * rather than the pipeline store. A manual run persists nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { GeneratedRunPlan, PipelineDef } from '../../../src/shared/types.js';

function generatedPipeline(): PipelineDef {
  return {
    id: 'generated-plan-xyz',
    name: 'Build then review',
    description: 'A generated two-phase pipeline.',
    acceptance: { kind: 'all_phases_pass' },
    phases: [
      {
        name: 'build',
        kind: 'agent',
        agent: 'builder',
        description: 'Make the change.',
        envelope: 'build',
        prompt: { inputs: ['request'] },
      },
    ],
    builtin: false,
  };
}

function plan(): GeneratedRunPlan {
  return {
    planId: 'plan-xyz',
    projectId: 'proj',
    prompt: 'make it better',
    refinedRequest: 'Improve the README with a usage section.',
    rationale: 'Small change, one build phase.',
    pipeline: generatedPipeline(),
    agents: [
      {
        name: 'plan_reviewer',
        purpose: 'review this run',
        model: 'inherit',
        reasoningEffort: 'medium',
        systemPrompt: 'You review.',
        userPrompt: 'Review: {{request}}',
        writes: [],
        envelope: 'review',
        color: '#d2a05a',
      },
    ],
    warnings: [{ level: 'warning', where: 'test', message: 'no test command yet' }],
    model: 'anthropic/claude-opus-4',
    reasoningEffort: 'high',
  };
}

let support: string;
let tracer: Tracer;

beforeEach(() => {
  support = tempDir('foundry-run-plan-');
  tracer = new Tracer(openDb(projectDbPath(support, 'proj')), projectRunsDir(support, 'proj'));
});

function startRun(runId: string, withPlan: GeneratedRunPlan | null): void {
  tracer.startRun({
    runId,
    projectId: 'proj',
    pipeline: withPlan ? withPlan.pipeline : generatedPipeline(),
    request: withPlan ? withPlan.refinedRequest : 'manual request',
    engineer: 'tester',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
    plan: withPlan,
  });
}

describe('run plan persistence', () => {
  it('round-trips the full plan through the run row', () => {
    startRun('run_1', plan());
    const persisted = tracer.runPlan('run_1');
    expect(persisted).toEqual(plan());
  });

  it('marks the run orchestrated and starts its amendment count at zero', () => {
    startRun('run_1', plan());
    const run = tracer.run('run_1')!;
    expect(run.orchestrated).toBe(true);
    expect(run.amendments).toBe(0);
  });

  it('writes plan.json under the run dir as the raw record', () => {
    startRun('run_1', plan());
    const file = join(tracer.runDir('run_1'), 'plan.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(plan());
  });

  it('answers null for a manual run, which persists no plan', () => {
    startRun('run_manual', null);
    expect(tracer.runPlan('run_manual')).toBeNull();
    const run = tracer.run('run_manual')!;
    expect(run.orchestrated).toBe(false);
    expect(run.amendments).toBe(0);
    expect(existsSync(join(tracer.runDir('run_manual'), 'plan.json'))).toBe(false);
  });

  it('survives a reopen: the plan comes back from the row, not from memory', () => {
    startRun('run_1', plan());
    const reopened = new Tracer(
      openDb(projectDbPath(support, 'proj')),
      projectRunsDir(support, 'proj'),
    );
    expect(reopened.runPlan('run_1')).toEqual(plan());
    expect(reopened.run('run_1')!.orchestrated).toBe(true);
  });

  it('answers null rather than throwing when the stored JSON no longer parses', () => {
    startRun('run_1', plan());
    // Corrupt the column directly: the raw file under the run dir remains the
    // record, so a broken mirror must degrade to null, not to a crash.
    const db = openDb(projectDbPath(support, 'proj'));
    db.prepare("UPDATE runs SET plan_json = '{broken' WHERE run_id = ?").run('run_1');
    const reopened = new Tracer(db, projectRunsDir(support, 'proj'));
    expect(reopened.runPlan('run_1')).toBeNull();
  });
});

describe('manual amendments and repair agents', () => {
  function manualPipeline(): PipelineDef {
    return {
      id: 'manual-p',
      name: 'manual',
      description: 'A manual pipeline.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [
        {
          name: 'prepare',
          kind: 'code',
          description: 'Prepare the run.',
          command: { argv: ['true'] },
        },
      ],
    };
  }

  function repairAgent() {
    return {
      name: 'repairer',
      purpose: 'repair the run',
      model: 'inherit',
      reasoningEffort: 'medium' as const,
      systemPrompt: 'You repair. purpose read-only git_diff status summary.',
      userPrompt: 'Repair {{request}}.',
      writes: [],
      envelope: 'build',
      color: '#5ad2dd',
    };
  }

  function setupManualRun(runId: string): { failedId: string; queuedId: string } {
    tracer.startRun({
      runId,
      projectId: 'proj',
      pipeline: manualPipeline(),
      request: 'manual request',
      engineer: 'tester',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
      plan: null,
    });
    const failedId = tracer.queuePhase({
      runId,
      seq: 0,
      name: 'prepare',
      kind: 'code',
      owner: 'code',
      description: 'Prepare the run.',
    });
    const queuedId = tracer.queuePhase({
      runId,
      seq: 1,
      name: 'stale',
      kind: 'code',
      owner: 'code',
      description: 'Stale tail.',
    });
    tracer.beginQueuedPhase(failedId);
    tracer.closePhase(failedId, 'fail', 'seeded failure');
    return { failedId, queuedId };
  }

  it('amends a manual run without fabricating a plan', () => {
    const { failedId, queuedId } = setupManualRun('run_manual_amend');
    const next: PipelineDef = {
      id: 'manual-p',
      name: 'manual',
      description: 'A manual pipeline.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [
        {
          name: 'prepare',
          kind: 'code',
          description: 'Prepare the run.',
          command: { argv: ['true'] },
        },
        {
          name: 'repair',
          kind: 'code',
          description: 'Repair the run.',
          command: { argv: ['true'] },
        },
      ],
    };
    const ids = tracer.amendRun({
      runId: 'run_manual_amend',
      failedPhaseId: failedId,
      removeQueuedPhaseIds: [queuedId],
      pipeline: next,
      plan: null,
      reason: 'Repair the tail.',
      attempt: 1,
      evidence: 'seeded failure',
      before: ['stale'],
      after: ['repair'],
      newPhases: next.phases.slice(1),
      engineer: 'tester',
      agents: [repairAgent()],
    });
    expect(ids.get('repair')).toBeTruthy();
    expect(tracer.runPlan('run_manual_amend')).toBeNull();
    expect(tracer.run('run_manual_amend')!.orchestrated).toBe(false);
    expect(tracer.run('run_manual_amend')!.amendments).toBe(1);
    expect(existsSync(join(tracer.runDir('run_manual_amend'), 'plan.json'))).toBe(false);
    expect(tracer.runPipeline('run_manual_amend')).toEqual(next);
    expect(tracer.amendmentAgents('run_manual_amend').map((a) => a.name)).toEqual(['repairer']);
    const reopened = new Tracer(
      openDb(projectDbPath(support, 'proj')),
      projectRunsDir(support, 'proj'),
    );
    expect(reopened.runPlan('run_manual_amend')).toBeNull();
    expect(reopened.runPipeline('run_manual_amend')).toEqual(next);
    expect(reopened.amendmentAgents('run_manual_amend').map((a) => a.name)).toEqual(['repairer']);
  });

  it('counts a started call after reopen and counts one attempt once', () => {
    startRun('run_started', plan());
    tracer.event({
      runId: 'run_started',
      phaseId: null,
      type: 'log',
      name: 'replan proposal started',
      payload: { actor: 'smith', attempt: 1, budget: 2, phase: 'build' },
    });
    expect(tracer.replanAttempts('run_started')).toBe(1);
    const reopened = new Tracer(
      openDb(projectDbPath(support, 'proj')),
      projectRunsDir(support, 'proj'),
    );
    expect(reopened.replanAttempts('run_started')).toBe(1);
    tracer.event({
      runId: 'run_started',
      phaseId: null,
      type: 'log',
      name: 'replan proposal rejected',
      payload: { attempt: 1, issues: ['bad'] },
    });
    tracer.event({
      runId: 'run_started',
      phaseId: null,
      type: 'replan',
      name: 'pipeline amended',
      payload: { actor: 'smith', attempt: 1, reason: 'r', evidence: '', before: [], after: [] },
    });
    expect(tracer.replanAttempts('run_started')).toBe(1);
  });

  it('ignores malformed attempts and keeps legacy rows', () => {
    startRun('run_malformed', plan());
    tracer.event({
      runId: 'run_malformed',
      phaseId: null,
      type: 'log',
      name: 'replan proposal started',
      payload: { attempt: 'one' },
    });
    tracer.event({
      runId: 'run_malformed',
      phaseId: null,
      type: 'log',
      name: 'replan proposal started',
      payload: {},
    });
    expect(tracer.replanAttempts('run_malformed')).toBe(0);
    tracer.event({
      runId: 'run_malformed',
      phaseId: null,
      type: 'replan',
      name: 'pipeline amended',
      payload: { attempt: 2, reason: 'r', evidence: '', before: [], after: [] },
    });
    expect(tracer.replanAttempts('run_malformed')).toBe(2);
  });

  it('only accepted amendments contribute agents', () => {
    startRun('run_agents', plan());
    tracer.event({
      runId: 'run_agents',
      phaseId: null,
      type: 'log',
      name: 'replan proposal started',
      payload: { attempt: 1, phase: 'build' },
    });
    tracer.event({
      runId: 'run_agents',
      phaseId: null,
      type: 'log',
      name: 'replan proposal rejected',
      payload: { attempt: 1, issues: ['bad'], agents: [{ name: 'bad' }] },
    });
    expect(tracer.amendmentAgents('run_agents')).toEqual([]);
    tracer.event({
      runId: 'run_agents',
      phaseId: null,
      type: 'replan',
      name: 'pipeline amended',
      payload: { attempt: 1, reason: 'r', evidence: '', before: [], after: [], agents: [] },
    });
    expect(tracer.amendmentAgents('run_agents')).toEqual([]);
  });

  it('refuses a non-queued deletion atomically', () => {
    const { failedId } = setupManualRun('run_atomic');
    const before = tracer.runPipeline('run_atomic');
    const beforeCount = tracer.run('run_atomic')!.amendments;
    const beforePhases = tracer.phases('run_atomic').map((p) => p.phaseId);
    expect(() =>
      tracer.amendRun({
        runId: 'run_atomic',
        failedPhaseId: failedId,
        removeQueuedPhaseIds: [failedId],
        pipeline: manualPipeline(),
        plan: null,
        reason: 'bad delete',
        attempt: 1,
        evidence: '',
        before: [],
        after: [],
        newPhases: [],
        engineer: 'tester',
      }),
    ).toThrow(/no longer queued/);
    expect(tracer.runPipeline('run_atomic')).toEqual(before);
    expect(tracer.run('run_atomic')!.amendments).toBe(beforeCount);
    expect(tracer.phases('run_atomic').map((p) => p.phaseId)).toEqual(beforePhases);
    expect(tracer.amendmentAgents('run_atomic')).toEqual([]);
  });

  it('reads the database snapshot even when the mirror is stale', () => {
    const { failedId, queuedId } = setupManualRun('run_mirror');
    const next: PipelineDef = {
      id: 'manual-p',
      name: 'manual',
      description: 'A manual pipeline.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [
        {
          name: 'prepare',
          kind: 'code',
          description: 'Prepare the run.',
          command: { argv: ['true'] },
        },
      ],
    };
    tracer.amendRun({
      runId: 'run_mirror',
      failedPhaseId: failedId,
      removeQueuedPhaseIds: [queuedId],
      pipeline: next,
      plan: null,
      reason: 'r',
      attempt: 1,
      evidence: '',
      before: ['stale'],
      after: [],
      newPhases: [],
      engineer: 'tester',
    });
    tracer.writeRunFile('run_mirror', 'pipeline.json', JSON.stringify({ stale: true }));
    expect(tracer.runPipeline('run_mirror')).toEqual(next);
    expect(tracer.runPipeline('missing')).toBeNull();
    const db = openDb(projectDbPath(support, 'proj'));
    db.prepare('UPDATE runs SET pipeline_snapshot_json = ? WHERE run_id = ?').run(
      '{broken',
      'run_mirror',
    );
    const reopened = new Tracer(db, projectRunsDir(support, 'proj'));
    expect(reopened.runPipeline('run_mirror')).toBeNull();
  });
});
