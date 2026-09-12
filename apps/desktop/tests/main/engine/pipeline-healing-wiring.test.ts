/**
 * Registry-level proof that automatic repairs use Smith's model and settings
 * for both generated and manual runs.
 */

import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { scriptedOneShots } from '../../helpers/scripted-oneshot.js';
import { openDb } from '../../../src/main/trace/db.js';
import { projectDbPath } from '../../../src/main/trace/db.js';
import { projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { RunRegistry } from '../../../src/main/engine/registry.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import type { GeneratedRunPlan, PhaseDef, PipelineDef } from '../../../src/shared/types.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function scratchRepo(): string {
  const repo = tempDir('foundry-wiring-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'test@foundry.local'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Foundry Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: repo });
  return repo;
}

function failingPipeline(): PipelineDef {
  return {
    id: 'wiring-test',
    name: 'wiring',
    description: 'Prove Smith wiring for a failing code phase.',
    acceptance: { kind: 'all_phases_pass' },
    phases: [
      {
        name: 'broken',
        kind: 'code',
        description: 'Fail so Smith is asked.',
        command: { argv: ['sh', '-c', 'exit 7'] },
        heal: false,
      } as PhaseDef,
    ],
  };
}

function passingPipeline(): PipelineDef {
  return {
    id: 'wiring-pass',
    name: 'wiring pass',
    description: 'A passing pipeline never asks Smith.',
    acceptance: { kind: 'all_phases_pass' },
    phases: [
      {
        name: 'ok',
        kind: 'code',
        description: 'Pass without healing.',
        command: { argv: ['true'] },
        heal: false,
      } as PhaseDef,
    ],
  };
}

function planFor(pipeline: PipelineDef, projectId: string): GeneratedRunPlan {
  return {
    planId: 'plan-wiring',
    projectId,
    prompt: 'make it pass',
    refinedRequest: 'Make the wiring test pass.',
    rationale: 'One failing phase.',
    pipeline,
    agents: [],
    warnings: [],
    model: 'orchestrator/other-model',
    reasoningEffort: 'high',
  };
}

async function untilSettled(registry: RunRegistry, runId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!registry.isLive(runId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for run to settle');
}

describe('pipeline healing wiring', () => {
  it('uses the Smith model for a generated run, not the plan model', async () => {
    const repo = scratchRepo();
    const support = tempDir('foundry-wiring-support-');
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const pipeline = failingPipeline();
    const plan = planFor(pipeline, project.id);
    const shots = scriptedOneShots([
      {
        structuredOutput: {
          reason: 'no repair',
          phases: [],
          agents: [],
        },
      },
    ]);
    const settings = {
      ...defaultSettings(),
      smithModel: 'smith/test-model',
      smithReasoningEffort: 'high' as const,
      defaultModel: 'default/test-model',
      defaultReasoningEffort: 'medium' as const,
    };
    const registry = new RunRegistry({
      appSupportDir: support,
      settings: () => settings,
      engineerName: 'test',
      onRunFinished: () => undefined,
      onRunsChanged: () => undefined,
      oneShot: shots.factory,
    });
    const runId = registry.start({
      project,
      pipeline,
      agents: [],
      envelopeDefs: [],
      request: plan.refinedRequest,
      plan,
    });
    await untilSettled(registry, runId);
    expect(shots.calls).toHaveLength(1);
    expect(shots.calls[0]).toMatchObject({
      access: 'read',
      model: 'smith/test-model',
      reasoningEffort: 'high',
    });
    const tracer = registry.tracerFor(project);
    expect(shots.calls[0]!.cwd).toBe(tracer.run(runId)?.worktreePath);
    expect(tracer.run(runId)!.status).toBe('rejected');
  });

  it('uses the Smith model for a manual run', async () => {
    const repo = scratchRepo();
    const support = tempDir('foundry-wiring-support-');
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const pipeline = failingPipeline();
    const shots = scriptedOneShots([
      { structuredOutput: { reason: 'no repair', phases: [], agents: [] } },
    ]);
    const settings = {
      ...defaultSettings(),
      smithModel: 'smith/manual-model',
      smithReasoningEffort: 'low' as const,
      defaultModel: 'inherit',
      defaultReasoningEffort: 'medium' as const,
    };
    const registry = new RunRegistry({
      appSupportDir: support,
      settings: () => settings,
      engineerName: 'test',
      onRunFinished: () => undefined,
      onRunsChanged: () => undefined,
      oneShot: shots.factory,
    });
    const runId = registry.start({
      project,
      pipeline,
      agents: [],
      envelopeDefs: [],
      request: 'manual request',
    });
    await untilSettled(registry, runId);
    expect(shots.calls).toHaveLength(1);
    expect(shots.calls[0]).toMatchObject({
      access: 'read',
      model: 'smith/manual-model',
      reasoningEffort: 'low',
    });
    expect(shots.calls[0]!.cwd).toBe(registry.tracerFor(project).run(runId)?.worktreePath);
  });

  it('opens no Smith one-shot for a passing run', async () => {
    const repo = scratchRepo();
    const support = tempDir('foundry-wiring-support-');
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const shots = scriptedOneShots([]);
    const registry = new RunRegistry({
      appSupportDir: support,
      settings: () => defaultSettings(),
      engineerName: 'test',
      onRunFinished: () => undefined,
      onRunsChanged: () => undefined,
      oneShot: shots.factory,
    });
    const runId = registry.start({
      project,
      pipeline: passingPipeline(),
      agents: [],
      envelopeDefs: [],
      request: 'pass',
    });
    await untilSettled(registry, runId);
    expect(shots.calls).toHaveLength(0);
    expect(registry.tracerFor(project).run(runId)!.status).toBe('accepted');
  });

  it('retains terminal failure without a runtime when oneShot is omitted', async () => {
    const repo = scratchRepo();
    const support = tempDir('foundry-wiring-support-');
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const registry = new RunRegistry({
      appSupportDir: support,
      settings: () => defaultSettings(),
      engineerName: 'test',
      onRunFinished: () => undefined,
      onRunsChanged: () => undefined,
    });
    const runId = registry.start({
      project,
      pipeline: failingPipeline(),
      agents: [],
      envelopeDefs: [],
      request: 'no runtime',
    });
    await untilSettled(registry, runId);
    expect(registry.tracerFor(project).run(runId)!.status).toBe('rejected');
  });

  it('reads Tracer directly for runPipeline compatibility', () => {
    const repo = scratchRepo();
    const support = tempDir('foundry-wiring-support-');
    const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
    expect(tracer.runPipeline('missing')).toBeNull();
    void projectRunsDir;
  });
});
