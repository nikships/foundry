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
