/** Mid-run Orchestrator amendments against real git worktrees and trace rows. */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { scriptedOneShots, type ScriptedTurn } from '../../helpers/scripted-oneshot.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor } from '../../../src/main/engine/executor.js';
import { replanningSupport } from '../../../src/main/orchestrator/replan.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import type {
  AgentDef,
  GeneratedRunPlan,
  PhaseDef,
  PipelineDef,
} from '../../../src/shared/types.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchRepo(): string {
  const repo = tempDir('foundry-replan-');
  sh(repo, ['git', 'init', '-q', '-b', 'main']);
  sh(repo, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(repo, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  sh(repo, ['git', 'add', '-A']);
  sh(repo, ['git', 'commit', '-qm', 'initial']);
  return repo;
}

function codePhase(name: string, argv: string[], description: string): PhaseDef {
  return { name, kind: 'code', description, command: { argv } };
}

const builder: AgentDef = {
  name: 'builder',
  purpose: 'prepare the run',
  model: 'scripted',
  reasoningEffort: 'medium',
  systemPrompt: 'Prepare the run.',
  userPrompt: 'Prepare {{request}}.',
  writes: [],
  envelope: 'build',
  color: '#5ad2dd',
};

function preparePhase(): PhaseDef {
  return {
    name: 'prepare',
    kind: 'agent',
    agent: builder.name,
    // A generated plan appoints every agent phase explicitly; the amendment
    // rail reads these ids as the set an amendment may re-cast onto.
    model: 'scripted',
    description: 'Prepare immutable evidence before the failing command.',
    envelope: 'build',
    prompt: { inputs: ['request'] },
  };
}

function buildEnvelope(): string {
  return JSON.stringify({
    status: 'success',
    summary: 'prepared the run',
    artifacts: [],
    notes_for_next_agent: '',
    commit_message: '',
  });
}

function pipeline(): PipelineDef {
  return {
    id: 'generated-replan-test',
    name: 'Adaptive test',
    description: 'Prove a failed pipeline can replace its remaining work.',
    acceptance: { kind: 'all_phases_pass' },
    phases: [
      preparePhase(),
      codePhase(
        'broken',
        ['sh', '-c', 'echo original failure >&2; exit 7'],
        'Fail after preparation.',
      ),
      codePhase('stale', ['sh', '-c', 'exit 9'], 'Represent work the amendment replaces.'),
    ],
  };
}

function plan(pipelineDef: PipelineDef): GeneratedRunPlan {
  return {
    planId: 'plan-replan-test',
    projectId: '',
    prompt: 'make it pass',
    refinedRequest: 'Make the adaptive test pass with evidence.',
    rationale: 'Prepare, execute, then verify.',
    pipeline: pipelineDef,
    agents: [],
    warnings: [],
    model: 'orchestrator/test-model',
    reasoningEffort: 'high',
  };
}

function validAmendment(): string {
  return JSON.stringify({
    reason: 'Replace the broken command and stale tail with a repair plus proof.',
    phases: [
      codePhase(
        'broken',
        ['sh', '-c', 'echo repaired > repaired.txt'],
        'Repair the artifact that the original command could not produce.',
      ),
      codePhase('verify', ['test', '-f', 'repaired.txt'], 'Verify the repaired artifact exists.'),
    ],
    agents: [],
  });
}

function invalidAmendment(): string {
  return JSON.stringify({
    reason: 'This proposal is deliberately malformed.',
    phases: [{ name: 'repair', kind: 'code', description: 'Forget the required command.' }],
    agents: [],
  });
}

/** An amendment whose agent phase declines to name a model. */
function inheritingAmendment(): string {
  return JSON.stringify({
    reason: 'Re-run preparation, but without appointing a model.',
    phases: [
      {
        name: 'retry_prepare',
        kind: 'agent',
        agent: builder.name,
        description: 'Prepare the run again after the command failed.',
        envelope: 'build',
        prompt: { inputs: ['request'] },
      },
    ],
    agents: [],
  });
}

interface StartedRun {
  tracer: Tracer;
  runId: string;
  oneShots: ReturnType<typeof scriptedOneShots>;
  executor: Executor;
  done: ReturnType<Executor['run']>;
}

function start(turns: ScriptedTurn[], orchestrated = true): StartedRun {
  const repo = scratchRepo();
  const support = tempDir('foundry-replan-support-');
  const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
  const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
  const pipelineDef = pipeline();
  const generated = plan(pipelineDef);
  generated.projectId = project.id;
  const oneShots = scriptedOneShots(turns);
  const scripted = new ScriptedAgent([buildEnvelope()]);
  const replanner = replanningSupport(oneShots.factory, generated, () => {
    return tracer.run(runId)?.worktreePath ?? repo;
  });
  const executor = new Executor({
    tracer,
    envelopeRetries: 0,
    gateRetries: 0,
    compactionThreshold: 0.8,
    rewindAfterCorrections: 0,
    healing: null,
    replanner,
    supportDir: support,
    agents: [builder],
    envelopeDefs: [],
    project,
    pipeline: pipelineDef,
    request: generated.refinedRequest,
    plan: orchestrated ? generated : null,
    runId,
    engineer: 'test',
    askHuman: async () => ({ approve: true }),
    transport: (request) => scripted.transport(request),
  });
  return { tracer, runId, oneShots, executor, done: executor.run() };
}

async function until(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${detail}`);
}

describe('mid-run replanning', () => {
  it('applies a valid amendment, preserves history, and continues through fresh rows', async () => {
    const started = start([{ text: validAmendment() }]);
    const outcome = await started.done;

    expect(outcome.status).toBe('accepted');
    expect(started.tracer.run(started.runId)!.amendments).toBe(1);
    expect(started.tracer.replanAttempts(started.runId)).toBe(1);
    const phases = started.tracer.phases(started.runId);
    expect(phases.map((phase) => [phase.name, phase.status])).toEqual([
      ['prepare', 'success'],
      ['broken', 'fail'],
      ['broken', 'success'],
      ['verify', 'success'],
    ]);
    expect(phases[0]!.seq).toBe(0);
    expect(phases[1]!.phaseId).not.toBe(phases[2]!.phaseId);

    const event = started.tracer
      .eventsAfter(started.runId, 0, 1000)
      .find((candidate) => candidate.type === 'replan');
    expect(event?.payload.before).toEqual(['stale']);
    expect(event?.payload.after).toEqual(['broken', 'verify']);
    expect(event?.payload.evidence).toContain('original failure');
    expect(started.oneShots.calls[0]).toMatchObject({
      access: 'read',
      model: 'orchestrator/test-model',
      reasoningEffort: 'high',
      cwd: outcome.worktreePath,
    });
    expect(
      started.tracer.runPlan(started.runId)?.pipeline.phases.map((phase) => phase.name),
    ).toEqual(['prepare', 'broken', 'verify']);
  });

  it('spends the budget on invalid amendments without partially applying one', async () => {
    const started = start([{ text: invalidAmendment() }, { text: invalidAmendment() }]);
    const outcome = await started.done;

    expect(outcome.status).toBe('rejected');
    expect(started.oneShots.calls).toHaveLength(2);
    expect(started.tracer.run(started.runId)!.amendments).toBe(0);
    expect(started.tracer.replanAttempts(started.runId)).toBe(2);
    expect(started.tracer.phases(started.runId).map((phase) => phase.name)).toEqual([
      'prepare',
      'broken',
      'stale',
    ]);
    expect(
      started.tracer
        .eventsAfter(started.runId, 0, 1000)
        .filter((event) => event.name === 'replan proposal rejected'),
    ).toHaveLength(2);
  });

  it('rejects an amendment whose agent phase inherits a model instead of naming one', async () => {
    const started = start([{ text: inheritingAmendment() }, { text: validAmendment() }]);
    const outcome = await started.done;

    // The first proposal spends a budget slot and is refused outright rather
    // than quietly running that phase on the install default; the second is
    // applied, so the run still recovers.
    expect(outcome.status).toBe('accepted');
    expect(started.tracer.run(started.runId)!.amendments).toBe(1);
    const rejection = started.tracer
      .eventsAfter(started.runId, 0, 1000)
      .find((event) => event.name === 'replan proposal rejected');
    expect(JSON.stringify(rejection?.payload)).toContain('must name its own model');
    expect(started.tracer.phases(started.runId).map((phase) => phase.name)).not.toContain(
      'retry_prepare',
    );
  });

  it('falls through to the original failure after the proposal budget is exhausted', async () => {
    const started = start([{ text: 'no amendment' }, { text: 'still no amendment' }]);
    const outcome = await started.done;

    expect(outcome.status).toBe('rejected');
    expect(outcome.detail).toContain('broken exited 7');
    expect(started.oneShots.calls).toHaveLength(2);
    expect(started.tracer.run(started.runId)!.amendments).toBe(0);
  });

  it('kills a run immediately while its replan turn is in flight', async () => {
    const started = start([{ hangUntilAbort: true }]);
    await until(() => started.oneShots.calls.length === 1, 'the replan one-shot to start');
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    expect(started.oneShots.calls).toHaveLength(1);
    expect(started.tracer.run(started.runId)!.amendments).toBe(0);
  });

  it('never calls the replanner for a manual run', async () => {
    const started = start([{ text: validAmendment() }], false);
    const outcome = await started.done;

    expect(outcome.status).toBe('rejected');
    expect(started.oneShots.calls).toHaveLength(0);
    expect(started.tracer.run(started.runId)!.orchestrated).toBe(false);
  });
});
