/** Smith pipeline healing against real git worktrees and trace rows. */

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
import { RunRegistry } from '../../../src/main/engine/registry.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
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
  return { name, kind: 'code', description, command: { argv }, heal: false };
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
    model: 'scripted',
    reasoningEffort: 'medium',
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
    agents: [
      {
        name: 'synth_helper',
        purpose: 'unused helper',
        model: 'inherit',
        reasoningEffort: 'medium',
        systemPrompt: 'SYNTH_SYSTEM_PROMPT_MUST_NOT_LEAK',
        userPrompt: 'SYNTH_USER_PROMPT_MUST_NOT_LEAK',
        writes: [],
        envelope: 'build',
        color: '#d2a05a',
      },
    ],
    warnings: [],
    model: 'orchestrator/test-model',
    reasoningEffort: 'high',
  };
}

function validAmendment(): string {
  return JSON.stringify({
    reason: 'Replace the broken command and stale tail with a repair plus proof.',
    phases: [
      codePhase('broken', ['sh', '-c', 'echo repaired > repaired.txt'], 'Repair the artifact.'),
      codePhase('verify', ['test', '-f', 'repaired.txt'], 'Verify the repaired artifact exists.'),
    ],
    agents: [],
  });
}

function submitted(text: string): ScriptedTurn {
  return { structuredOutput: JSON.parse(text) as Record<string, unknown> };
}

function invalidAmendment(): string {
  return JSON.stringify({
    reason: 'This proposal is deliberately malformed.',
    phases: [{ name: 'repair', kind: 'code', description: 'Forget the required command.' }],
    agents: [],
  });
}

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
  pipelineDef: PipelineDef;
}

function start(
  turns: ScriptedTurn[],
  orchestrated = true,
  opts: { pipelineDef?: PipelineDef; agentTurns?: string[] } = {},
): StartedRun {
  const repo = scratchRepo();
  const support = tempDir('foundry-replan-support-');
  const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
  const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
  const pipelineDef = opts.pipelineDef ?? pipeline();
  const generated = plan(pipelineDef);
  generated.projectId = project.id;
  const oneShots = scriptedOneShots(turns);
  const scripted = new ScriptedAgent(opts.agentTurns ?? [buildEnvelope()]);
  const replanner = replanningSupport(
    oneShots.factory,
    { model: 'smith/test-model', reasoningEffort: 'medium' },
    () => tracer.run(runId)?.worktreePath ?? repo,
  );
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
    transport: (request) => scripted.transport(request),
  });
  return { tracer, runId, oneShots, executor, done: executor.run(), pipelineDef };
}

async function until(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${detail}`);
}

describe('Smith pipeline healing', () => {
  it.each([true, false])(
    'repairs from the failure point (orchestrated: %s)',
    async (orchestrated) => {
      const started = start([submitted(validAmendment())], orchestrated);
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
      expect(event?.payload.actor).toBe('smith');
      expect(started.oneShots.calls[0]).toMatchObject({
        access: 'read',
        model: 'smith/test-model',
        cwd: outcome.worktreePath,
        outputFormat: { type: 'json_schema' },
      });
      expect(started.oneShots.calls[0]!.systemPrompt).toContain('You are Smith');
      const firstPrompt = started.oneShots.prompts[0]!;
      expect(firstPrompt).toContain('## Active roster');
      expect(firstPrompt).toContain('- builder: prepare the run');
      expect(firstPrompt).toContain('## Run goal');
      expect(firstPrompt).toContain('Make the adaptive test pass with evidence.');
      expect(firstPrompt).toContain('broken');
      expect(firstPrompt).toContain('stale');
      expect(firstPrompt).toContain('scripted');
      expect(firstPrompt).not.toContain('SYNTH_SYSTEM_PROMPT_MUST_NOT_LEAK');
      expect(firstPrompt).not.toContain('SYNTH_USER_PROMPT_MUST_NOT_LEAK');
      expect(firstPrompt).not.toContain('"refinedRequest"');
      if (orchestrated) {
        expect(
          started.tracer.runPlan(started.runId)?.pipeline.phases.map((phase) => phase.name),
        ).toEqual(['prepare', 'broken', 'verify']);
      } else {
        expect(started.tracer.runPlan(started.runId)).toBeNull();
        expect(started.tracer.run(started.runId)!.orchestrated).toBe(false);
        expect(started.tracer.runPipeline(started.runId)?.phases.map((p) => p.name)).toEqual([
          'prepare',
          'broken',
          'verify',
        ]);
      }
      expect(started.pipelineDef.phases.map((p) => p.name)).toEqual(['prepare', 'broken', 'stale']);
    },
  );

  it('applies two repairs then fails without a third call', async () => {
    const first = JSON.stringify({
      reason: 'First repair.',
      phases: [
        codePhase('fixed_one', ['sh', '-c', 'echo one > one.txt'], 'First fix.'),
        codePhase('broken_two', ['sh', '-c', 'echo second failure >&2; exit 8'], 'Second failure.'),
      ],
      agents: [],
    });
    const second = JSON.stringify({
      reason: 'Second repair.',
      phases: [
        codePhase('fixed_two', ['sh', '-c', 'echo two > two.txt'], 'Second fix.'),
        codePhase('broken_three', ['sh', '-c', 'echo third failure >&2; exit 9'], 'Third failure.'),
      ],
      agents: [],
    });
    const started = start(
      [submitted(first), submitted(second), { throws: 'must not be called a third time' }],
      true,
    );
    const outcome = await started.done;
    expect(outcome.status).toBe('rejected');
    expect(outcome.detail).toContain('broken_three');
    expect(started.oneShots.calls).toHaveLength(2);
    expect(started.tracer.run(started.runId)!.amendments).toBe(2);
    expect(started.tracer.replanAttempts(started.runId)).toBe(2);
    const amended = started.tracer
      .eventsAfter(started.runId, 0, 2000)
      .filter((e) => e.type === 'replan' && e.name === 'pipeline amended');
    expect(amended).toHaveLength(2);
    expect(amended.map((e) => e.payload.attempt)).toEqual([1, 2]);
    const prepareRows = started.tracer.phases(started.runId).filter((p) => p.name === 'prepare');
    expect(prepareRows).toHaveLength(1);
    expect(prepareRows[0]!.status).toBe('success');
  });

  it('can still finish after two repairs with no speculative third call', async () => {
    const first = JSON.stringify({
      reason: 'First repair.',
      phases: [
        codePhase('fixed_one', ['sh', '-c', 'echo one > one.txt'], 'First fix.'),
        codePhase('broken_two', ['sh', '-c', 'echo second failure >&2; exit 8'], 'Second failure.'),
      ],
      agents: [],
    });
    const second = JSON.stringify({
      reason: 'Second repair finishes.',
      phases: [codePhase('fixed_two', ['sh', '-c', 'echo two > two.txt'], 'Second fix.')],
      agents: [],
    });
    const started = start([submitted(first), submitted(second)], true);
    const outcome = await started.done;
    expect(outcome.status).toBe('accepted');
    expect(started.oneShots.calls).toHaveLength(2);
    expect(started.tracer.run(started.runId)!.amendments).toBe(2);
  });

  it('never asks Smith for a succeeding run', async () => {
    const passing: PipelineDef = {
      id: 'pass',
      name: 'pass',
      description: 'All phases pass without healing.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [preparePhase(), codePhase('ok', ['true'], 'Always passes.')],
    };
    const started = start([], true, { pipelineDef: passing });
    const outcome = await started.done;
    expect(outcome.status).toBe('accepted');
    expect(started.oneShots.calls).toHaveLength(0);
    expect(started.tracer.replanAttempts(started.runId)).toBe(0);
  });

  it('preserves acceptance when an earlier flag is satisfied', async () => {
    const flagged: PipelineDef = {
      id: 'flag',
      name: 'flag',
      description: 'An earlier flag satisfies acceptance.',
      acceptance: { kind: 'phase_flag', phase: 'proof', flag: 'passed' },
      phases: [
        codePhase('proof', ['true'], 'Satisfy the acceptance flag.'),
        codePhase('later', ['sh', '-c', 'exit 4'], 'Fail after acceptance is satisfied.'),
      ],
    };
    const started = start([], true, { pipelineDef: flagged });
    const outcome = await started.done;
    expect(outcome.status).toBe('accepted');
    expect(started.oneShots.calls).toHaveLength(0);
    expect(started.tracer.replanAttempts(started.runId)).toBe(0);
  });

  it('heals a hard PR artifact failure even with an earlier green flag', async () => {
    const flagged: PipelineDef = {
      id: 'flag-pr',
      name: 'flag pr',
      description: 'A PR artifact failure is a hard rejection.',
      acceptance: { kind: 'phase_flag', phase: 'proof', flag: 'passed' },
      phases: [
        codePhase('proof', ['true'], 'Satisfy the flag.'),
        {
          name: 'open_pr',
          kind: 'agent',
          agent: 'builder',
          description: 'Open a pull request.',
          envelope: 'pr',
          prompt: { inputs: ['request'] },
        },
      ],
    };
    const prEnvelope = JSON.stringify({
      status: 'success',
      summary: 'drafted',
      artifacts: [],
      notes_for_next_agent: '',
      title: 'Add the thing',
      body: '## Summary\n\nIt works.\n',
    });
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
    const generated = plan(flagged);
    generated.projectId = project.id;
    const oneShots = scriptedOneShots([
      { structuredOutput: { reason: 'no repair', phases: [], agents: [] } },
    ]);
    const scripted = new ScriptedAgent([buildEnvelope(), prEnvelope]);
    const replanner = replanningSupport(
      oneShots.factory,
      { model: 'smith/test-model', reasoningEffort: 'medium' },
      () => tracer.run(runId)?.worktreePath ?? repo,
    );
    const { makeFakeGh } = await import('../../helpers/fake-gh.js');
    const gh = makeFakeGh({ createError: 'gh failed' });
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
      pipeline: flagged,
      request: generated.refinedRequest,
      plan: generated,
      runId,
      engineer: 'test',
      transport: (request) => scripted.transport(request),
      gh: { bin: gh.bin },
    });
    const outcome = await executor.run();
    expect(oneShots.calls).toHaveLength(1);
    expect(outcome.status).toBe('rejected');
  });

  it('heals a final acceptance rejection at the named phase', async () => {
    const reviewAgent: AgentDef = {
      name: 'builder',
      purpose: 'review things',
      model: 'scripted',
      reasoningEffort: 'medium',
      systemPrompt: 'You review.',
      userPrompt: 'Review {{request}}.',
      writes: [],
      envelope: 'review',
      color: '#5ad2dd',
    };
    const reviewFalse = JSON.stringify({
      status: 'success',
      summary: 'reviewed',
      artifacts: [],
      approved: false,
      findings: [{ requirement: 'it works', met: false, evidence: 'no' }],
      blocking: ['it does not work'],
      notes_for_next_agent: '',
    });
    const reviewTrue = JSON.stringify({
      status: 'success',
      summary: 'reviewed',
      artifacts: [],
      approved: true,
      findings: [{ requirement: 'it works', met: true, evidence: 'yes' }],
      blocking: [],
      notes_for_next_agent: '',
    });
    const flagged: PipelineDef = {
      id: 'manual-review',
      name: 'manual review',
      description: 'A manual approval decides acceptance.',
      acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
      phases: [
        {
          name: 'build',
          kind: 'agent',
          agent: 'builder',
          description: 'Build the thing.',
          envelope: 'build',
          prompt: { inputs: ['request'] },
        },
        {
          name: 'review',
          kind: 'agent',
          agent: 'builder',
          description: 'Review the thing.',
          envelope: 'review',
          prompt: { inputs: ['request'] },
        },
      ],
    };
    const repair = JSON.stringify({
      reason: 'Re-review after fixes.',
      phases: [
        {
          name: 'review',
          kind: 'agent',
          agent: 'builder',
          model: 'scripted',
          reasoningEffort: 'medium',
          description: 'Review the thing.',
          envelope: 'review',
          gates: ['verdict_consistent', 'disapproval_halts'],
          prompt: { inputs: ['request'] },
        },
      ],
      agents: [],
    });
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
    const oneShots = scriptedOneShots([submitted(repair)]);
    const scripted = new ScriptedAgent([buildEnvelope(), reviewFalse, reviewTrue]);
    const replanner = replanningSupport(
      oneShots.factory,
      { model: 'smith/test-model', reasoningEffort: 'medium' },
      () => tracer.run(runId)?.worktreePath ?? repo,
    );
    const executor = new Executor({
      tracer,
      envelopeRetries: 0,
      gateRetries: 0,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 0,
      healing: null,
      replanner,
      supportDir: support,
      agents: [reviewAgent],
      envelopeDefs: [],
      project,
      pipeline: flagged,
      request: 'review the thing',
      plan: null,
      runId,
      engineer: 'test',
      transport: (request) => scripted.transport(request),
    });
    const outcome = await executor.run();
    expect(outcome.status).toBe('accepted');
    expect(oneShots.calls).toHaveLength(1);
    const reviewRows = tracer.phases(runId).filter((p) => p.name === 'review');
    expect(reviewRows.length).toBeGreaterThanOrEqual(2);
    expect(reviewRows[0]!.status).toBe('success');
  });

  it('treats empty proposals as unchanged with one spent call', async () => {
    for (const turn of [
      { text: 'no amendment' },
      { structuredOutput: { reason: 'none', phases: [], agents: [] } },
    ]) {
      const started = start([turn as ScriptedTurn], true);
      const outcome = await started.done;
      expect(outcome.status).toBe('rejected');
      expect(outcome.detail).toContain('broken exited 7');
      expect(started.oneShots.calls).toHaveLength(1);
      expect(started.tracer.run(started.runId)!.amendments).toBe(0);
      expect(started.tracer.replanAttempts(started.runId)).toBe(1);
      expect(started.tracer.phases(started.runId).map((p) => p.name)).toEqual([
        'prepare',
        'broken',
        'stale',
      ]);
    }
  });

  it('ignores new agents on an empty tail', async () => {
    const turn: ScriptedTurn = {
      structuredOutput: {
        reason: 'no repair but agents',
        phases: [],
        agents: [
          {
            name: 'stowaway',
            purpose: 'should never land',
            systemPrompt: 'purpose read-only git_diff status summary stowaway',
            userPrompt: 'Repair {{request}}.',
            writes: [],
            envelope: 'build',
          },
        ],
      },
    };
    const started = start([turn], true);
    const outcome = await started.done;
    expect(outcome.status).toBe('rejected');
    expect(started.oneShots.calls).toHaveLength(1);
    expect(started.tracer.run(started.runId)!.amendments).toBe(0);
    expect(started.tracer.amendmentAgents(started.runId)).toEqual([]);
  });

  it('spends the budget on invalid amendments without partially applying one', async () => {
    const started = start([submitted(invalidAmendment()), submitted(invalidAmendment())]);
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
    const started = start([submitted(inheritingAmendment()), submitted(validAmendment())]);
    const outcome = await started.done;
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

  it('recovers on the second call after a schema miss', async () => {
    const started = start([
      { structuredOutput: { reason: 'this proposal is missing phases' } },
      submitted(validAmendment()),
    ]);
    const outcome = await started.done;
    expect(outcome.status).toBe('accepted');
    expect(started.oneShots.calls).toHaveLength(2);
    expect(started.tracer.run(started.runId)!.amendments).toBe(1);
    expect(started.oneShots.prompts[1]).toContain('Previous proposal rejected by Foundry');
  });

  it('stops at two one-shots for repeated model errors', async () => {
    const started = start([{ throws: 'boom' }, { throws: 'boom again' }]);
    const outcome = await started.done;
    expect(outcome.status).toBe('rejected');
    expect(started.oneShots.calls).toHaveLength(2);
    expect(started.tracer.run(started.runId)!.amendments).toBe(0);
    expect(started.tracer.replanAttempts(started.runId)).toBe(2);
  });

  it('preserves feedback history instead of throwing no longer queued', async () => {
    const failing: PipelineDef = {
      id: 'feedback-hist',
      name: 'feedback history',
      description: 'A re-entered phase fails with terminal tail rows.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [
        preparePhase(),
        codePhase('verify', ['sh', '-c', 'test -f missing.txt'], 'Prove the file exists.'),
      ],
    };
    failing.phases[1]!.feedbackTo = 'prepare';
    failing.phases[1]!.feedbackRetries = 1;
    const failEnvelope = JSON.stringify({
      status: 'fail',
      summary: 'failed preparation',
      artifacts: [],
      notes_for_next_agent: '',
      commit_message: '',
    });
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
    const generated = plan(failing);
    generated.projectId = project.id;
    const oneShots = scriptedOneShots([submitted(validAmendment())]);
    const scripted = new ScriptedAgent([buildEnvelope(), failEnvelope]);
    const replanner = replanningSupport(
      oneShots.factory,
      { model: 'smith/test-model', reasoningEffort: 'medium' },
      () => tracer.run(runId)?.worktreePath ?? repo,
    );
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
      pipeline: failing,
      request: generated.refinedRequest,
      plan: generated,
      runId,
      engineer: 'test',
      transport: (request) => scripted.transport(request),
    });
    const outcome = await executor.run();
    expect(outcome.status).toBe('accepted');
    expect(oneShots.calls).toHaveLength(1);
    const verifyRows = tracer.phases(runId).filter((p) => p.name === 'verify');
    expect(verifyRows.length).toBeGreaterThanOrEqual(1);
  });

  it('does not call Smith for setup failures without a phase', async () => {
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
    const project = {
      ...defaultProject(repo),
      mergePolicy: 'never' as const,
      setupScript: 'exit 3',
    };
    const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
    const pipelineDef = pipeline();
    const generated = plan(pipelineDef);
    generated.projectId = project.id;
    const oneShots = scriptedOneShots([]);
    const executor = new Executor({
      tracer,
      envelopeRetries: 0,
      gateRetries: 0,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 0,
      healing: null,
      replanner: replanningSupport(
        oneShots.factory,
        { model: 'smith/test-model', reasoningEffort: 'medium' },
        () => tracer.run(runId)?.worktreePath ?? repo,
      ),
      supportDir: support,
      agents: [builder],
      envelopeDefs: [],
      project,
      pipeline: pipelineDef,
      request: generated.refinedRequest,
      plan: generated,
      runId,
      engineer: 'test',
      transport: (request) => new ScriptedAgent([buildEnvelope()]).transport(request),
    });
    const outcome = await executor.run();
    expect(outcome.status).toBe('failed');
    expect(oneShots.calls).toHaveLength(0);
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

  it('does not apply a late repair after cancellation', async () => {
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
    const pipelineDef = pipeline();
    const generated = plan(pipelineDef);
    generated.projectId = project.id;
    let executorRef: Executor | null = null;
    const factory = () => ({
      abort() {},
      async send() {
        executorRef?.cancel();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          text: '',
          usage: null,
          reason: 'stop',
          interrupted: false,
          structuredOutput: JSON.parse(validAmendment()) as Record<string, unknown>,
        };
      },
    });
    const scripted = new ScriptedAgent([buildEnvelope()]);
    const replanner = replanningSupport(
      factory as unknown as Parameters<typeof replanningSupport>[0],
      { model: 'smith/test-model', reasoningEffort: 'medium' },
      () => tracer.run(runId)?.worktreePath ?? repo,
    );
    executorRef = new Executor({
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
      plan: generated,
      runId,
      engineer: 'test',
      transport: (request) => scripted.transport(request),
    });
    const outcome = await executorRef.run();
    expect(outcome.status).toBe('killed');
    expect(tracer.run(runId)!.amendments).toBe(0);
  });

  it('enforces the cap across Continue with a fresh executor', async () => {
    const first = JSON.stringify({
      reason: 'First repair.',
      phases: [
        codePhase('fixed_one', ['sh', '-c', 'echo one > one.txt'], 'First fix.'),
        codePhase('broken_two', ['sh', '-c', 'exit 8'], 'Second failure.'),
      ],
      agents: [],
    });
    const second = JSON.stringify({
      reason: 'Second repair.',
      phases: [
        codePhase('fixed_two', ['sh', '-c', 'echo two > two.txt'], 'Second fix.'),
        codePhase('broken_three', ['sh', '-c', 'exit 9'], 'Third failure.'),
      ],
      agents: [],
    });
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const dbPath = projectDbPath(support, repo);
    const runsDir = projectRunsDir(support, repo);
    const tracer = new Tracer(openDb(dbPath), runsDir);
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
    const pipelineDef = pipeline();
    const generated = plan(pipelineDef);
    generated.projectId = project.id;
    const oneShots = scriptedOneShots([submitted(first), submitted(second)]);
    const replanner = replanningSupport(
      oneShots.factory,
      { model: 'smith/test-model', reasoningEffort: 'medium' },
      () => tracer.run(runId)?.worktreePath ?? repo,
    );
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
      plan: generated,
      runId,
      engineer: 'test',
      transport: (request) => new ScriptedAgent([buildEnvelope()]).transport(request),
    });
    const outcome = await executor.run();
    expect(outcome.status).toBe('rejected');
    expect(oneShots.calls).toHaveLength(2);
    const freshTracer = new Tracer(openDb(dbPath), runsDir);
    expect(freshTracer.replanAttempts(runId)).toBe(2);
    const freshShots = scriptedOneShots([{ throws: 'Continue must not call Smith again' }]);
    const savedPipeline = freshTracer.runPipeline(runId)!;
    const savedPlan = freshTracer.runPlan(runId);
    const continued = new Executor({
      tracer: freshTracer,
      envelopeRetries: 0,
      gateRetries: 0,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 0,
      healing: null,
      replanner: replanningSupport(
        freshShots.factory,
        { model: 'smith/test-model', reasoningEffort: 'medium' },
        () => freshTracer.run(runId)?.worktreePath ?? repo,
      ),
      supportDir: support,
      agents: [builder],
      envelopeDefs: [],
      project,
      pipeline: savedPipeline,
      request: generated.refinedRequest,
      plan: savedPlan,
      runId,
      engineer: 'test',
      transport: (request) => new ScriptedAgent([buildEnvelope()]).transport(request),
    });
    const resumed = await continued.resume();
    expect(resumed.status).toBe('rejected');
    expect(freshShots.calls).toHaveLength(0);
  });

  it('counts a killed first call durably so Continue gets only slot two', async () => {
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const dbPath = projectDbPath(support, repo);
    const runsDir = projectRunsDir(support, repo);
    const tracer = new Tracer(openDb(dbPath), runsDir);
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
    const pipelineDef = pipeline();
    const generated = plan(pipelineDef);
    generated.projectId = project.id;
    const hanging = scriptedOneShots([{ hangUntilAbort: true }]);
    const replanner = replanningSupport(
      hanging.factory,
      { model: 'smith/test-model', reasoningEffort: 'medium' },
      () => tracer.run(runId)?.worktreePath ?? repo,
    );
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
      plan: generated,
      runId,
      engineer: 'test',
      transport: (request) => new ScriptedAgent([buildEnvelope()]).transport(request),
    });
    const done = executor.run();
    await until(() => hanging.calls.length === 1, 'the hanging proposal to start');
    executor.cancel();
    const killed = await done;
    expect(killed.status).toBe('killed');
    expect(new Tracer(openDb(dbPath), runsDir).replanAttempts(runId)).toBe(1);
  });

  it('runs a manual synthesized agent without fabricating a plan', async () => {
    const manual: PipelineDef = {
      id: 'manual-synth',
      name: 'manual synth',
      description: 'A manual pipeline that gains an agent.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [codePhase('broken', ['sh', '-c', 'exit 7'], 'Fail so Smith adds an agent.')],
    };
    const repair = JSON.stringify({
      reason: 'Add a reviewer that approves.',
      phases: [
        {
          name: 'inspect',
          kind: 'agent',
          agent: 'fixer',
          model: 'scripted',
          reasoningEffort: 'medium',
          description: 'Inspect the failure.',
          envelope: 'generic',
          prompt: { inputs: ['request'] },
        },
        codePhase('verify', ['true'], 'Verify the fix.'),
      ],
      agents: [
        {
          name: 'fixer',
          purpose: 'fix the failure',
          systemPrompt: 'purpose read-only git_diff status summary fix the failure',
          userPrompt: 'Fix {{request}}.',
          writes: [],
          envelope: 'generic',
        },
      ],
    });
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const runId = `run_${Math.random().toString(36).slice(2, 9)}`;
    const oneShots = scriptedOneShots([submitted(repair)]);
    const scripted = new ScriptedAgent([buildEnvelope()]);
    const replanner = replanningSupport(
      oneShots.factory,
      { model: 'smith/test-model', reasoningEffort: 'medium' },
      () => tracer.run(runId)?.worktreePath ?? repo,
    );
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
      pipeline: manual,
      request: 'manual repair',
      plan: null,
      runId,
      engineer: 'test',
      transport: (request) => scripted.transport(request),
    });
    const outcome = await executor.run();
    expect(outcome.status).toBe('accepted');
    expect(tracer.run(runId)!.orchestrated).toBe(false);
    expect(tracer.runPlan(runId)).toBeNull();
    expect(tracer.amendmentAgents(runId).map((a) => a.name)).toEqual(['fixer']);
  });

  it('restores a persisted repair agent through the registry', async () => {
    const manual: PipelineDef = {
      id: 'manual-restore',
      name: 'manual restore',
      description: 'Prove repair agents survive restart.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [codePhase('broken', ['sh', '-c', 'exit 7'], 'Fail once.')],
    };
    const repo = scratchRepo();
    const support = tempDir('foundry-replan-support-');
    const project = { ...defaultProject(repo), mergePolicy: 'never' as const };
    const settings = {
      ...defaultSettings(),
      smithModel: 'smith/test-model',
      smithReasoningEffort: 'medium' as const,
    };
    const firstRepair = JSON.stringify({
      reason: 'Add a helper.',
      phases: [codePhase('fixed', ['true'], 'Apply the helper repair.')],
      agents: [
        {
          name: 'helper',
          purpose: 'run-owned helper',
          systemPrompt: 'purpose read-only git_diff status summary helper',
          userPrompt: 'Help {{request}}.',
          writes: [],
          envelope: 'build',
        },
      ],
    });
    const shots = scriptedOneShots([submitted(firstRepair)]);
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
      pipeline: manual,
      agents: [builder],
      envelopeDefs: [],
      request: 'manual restore',
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && registry.isLive(runId)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(registry.tracerFor(project).run(runId)!.status).toBe('accepted');
    expect(
      registry
        .tracerFor(project)
        .amendmentAgents(runId)
        .map((a) => a.name),
    ).toEqual(['helper']);
    expect(registry.tracerFor(project).run(runId)!.orchestrated).toBe(false);
  });
});
