/**
 * Starting a run from an inline Orchestrator plan, end to end: `startRun`
 * takes plan.pipeline, unions plan.agents into the roster, uses the refined
 * request, and the production executor runs it in a real git worktree with a
 * scripted transport — the engine cannot tell generated from stored.
 *
 * Also pins the trace half: the full plan is persisted on the run by the
 * tracer (sole SQLite writer) and read back through `runPlan`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor } from '../../../src/main/engine/executor.js';
import { startRun, type StartRunDeps } from '../../../src/main/engine/operations.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import type {
  AgentDef,
  GeneratedRunPlan,
  PipelineDef,
  ProjectDef,
  StartRunInput,
} from '../../../src/shared/types.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';

function sh(cwd: string, argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? '';
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${stderr.trim() || String(e)}`);
  }
}

function scratchRepo(): string {
  const dir = tempDir('foundry-plan-run-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

const rosterBuilder = (): AgentDef => ({
  name: 'builder',
  purpose: 'build things',
  model: 'scripted',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
});

const synthesizedReviewer = (): AgentDef => ({
  name: 'plan_reviewer',
  purpose: 'review the change this one run made',
  model: 'scripted',
  reasoningEffort: 'medium',
  systemPrompt: 'You review.',
  userPrompt: 'Review: {{request}}',
  writes: [],
  envelope: 'review',
  color: '#d2a05a',
});

function generatedPipeline(planId: string): PipelineDef {
  return {
    id: `generated-${planId}`,
    name: 'Build then review',
    description: 'Build the change, then a synthesized reviewer verifies it.',
    acceptance: { kind: 'all_phases_pass' },
    phases: [
      {
        name: 'build',
        kind: 'agent',
        agent: 'builder',
        model: 'scripted/strong',
        reasoningEffort: 'high',
        description: 'Make the requested change inside the worktree.',
        envelope: 'build',
        prompt: { inputs: ['request'] },
      },
      {
        name: 'review',
        kind: 'agent',
        agent: 'plan_reviewer',
        model: 'scripted/fast',
        reasoningEffort: 'low',
        description: 'Verify the change meets the refined request.',
        envelope: 'review',
        prompt: { inputs: ['request'] },
        gates: ['verdict_consistent', 'disapproval_halts'],
      },
    ],
    builtin: false,
  };
}

function plan(projectId: string): GeneratedRunPlan {
  const planId = 'plan-abc123';
  return {
    planId,
    projectId,
    prompt: 'make it better',
    refinedRequest: 'Improve the README with a usage section and keep the existing intro.',
    rationale: 'Small change; build plus an independent review is enough.',
    pipeline: generatedPipeline(planId),
    agents: [synthesizedReviewer()],
    warnings: [],
    model: 'inherit',
    reasoningEffort: 'high',
  };
}

const buildEnvelope = (): string =>
  JSON.stringify({
    status: 'success',
    summary: 'built it',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
  });

const reviewEnvelope = (): string =>
  JSON.stringify({
    status: 'success',
    summary: 'reviewed',
    artifacts: [],
    approved: true,
    findings: [],
    blocking: [],
    notes_for_next_agent: '',
  });

interface Harness {
  repo: string;
  project: ProjectDef;
  tracer: Tracer;
  support: string;
  db: Db;
}

let h: Harness;

beforeEach(() => {
  const repo = scratchRepo();
  const support = tempDir('foundry-plan-support-');
  const db = openDb(projectDbPath(support, repo));
  h = {
    repo,
    support,
    db,
    tracer: new Tracer(db, projectRunsDir(support, repo)),
    project: { ...defaultProject(repo), mergePolicy: 'never' },
  };
});

/** `startRun` deps over the real tracer and a production executor. */
function deps(scripted: ScriptedAgent): {
  deps: StartRunDeps;
  started: { pipeline: PipelineDef; agents: AgentDef[]; request: string }[];
  settled: Promise<string>[];
} {
  const started: { pipeline: PipelineDef; agents: AgentDef[]; request: string }[] = [];
  const settled: Promise<string>[] = [];
  return {
    started,
    settled,
    deps: {
      projectById: (id) => (id === h.project.id ? h.project : null),
      pipelineFor: () => null,
      rosterFor: () => [rosterBuilder()],
      envelopeDefs: () => [],
      settings: () => defaultSettings(),
      saveProject: (next) => next,
      enabledModelIds: async () => ['scripted/strong', 'scripted/fast'],
      oneShot: () => {
        throw new Error('an inline plan never opens a detection one-shot');
      },
      registry: {
        start: (input) => {
          started.push({
            pipeline: input.pipeline,
            agents: input.agents,
            request: input.request,
          });
          const runId = `run_plan_${started.length}`;
          const executor = new Executor({
            tracer: h.tracer,
            envelopeRetries: 2,
            gateRetries: 2,
            compactionThreshold: 0.8,
            rewindAfterCorrections: 2,
            supportDir: h.support,
            transport: (req) => scripted.transport(req),
            agents: input.agents,
            envelopeDefs: input.envelopeDefs,
            project: input.project,
            pipeline: input.pipeline,
            request: input.request,
            plan: input.plan ?? null,
            runId,
            engineer: 'test',
          });
          settled.push(executor.run().then((o) => o.status));
          return runId;
        },
      },
    },
  };
}

function input(over: Partial<StartRunInput> = {}): StartRunInput {
  return {
    projectId: h.project.id,
    pipelineId: 'ignored-when-a-plan-rides-along',
    request: 'make it better',
    plan: plan(h.project.id),
    ...over,
  };
}

describe('starting a run from an inline plan', () => {
  it('runs the generated pipeline with roster ∪ synthesized agents and the refined request', async () => {
    const scripted = new ScriptedAgent([buildEnvelope(), reviewEnvelope()], ['USAGE.md', null]);
    const { deps: d, started, settled } = deps(scripted);

    const outcome = await startRun(d, input());
    expect(outcome.ok).toBe(true);

    const call = started[0]!;
    expect(call.pipeline.id).toBe('generated-plan-abc123');
    expect(call.agents.map((a) => a.name)).toEqual(['builder', 'plan_reviewer']);
    expect(call.request).toContain('Improve the README');

    await expect(settled[0]!).resolves.toBe('accepted');
    const phases = h.tracer.phases(outcome.runId!);
    expect(phases.map((p) => [p.name, p.status])).toEqual([
      ['build', 'success'],
      ['review', 'success'],
    ]);
    expect(h.tracer.agentSessions(outcome.runId!).map((session) => session.model)).toEqual([
      'scripted/strong',
      'scripted/fast',
    ]);
  });

  it('records the run as orchestrated with the raw prompt preserved on the plan', async () => {
    const scripted = new ScriptedAgent([buildEnvelope(), reviewEnvelope()], ['USAGE.md', null]);
    const { deps: d, settled } = deps(scripted);

    const outcome = await startRun(d, input());
    await settled[0]!;

    const run = h.tracer.run(outcome.runId!)!;
    expect(run.orchestrated).toBe(true);
    expect(run.amendments).toBe(0);
    // The refined brief is the run request; the raw prompt lives on the plan.
    expect(run.request).toContain('Improve the README');
    const persisted = h.tracer.runPlan(outcome.runId!)!;
    expect(persisted.prompt).toBe('make it better');
  });

  it('refuses a plan generated for a different project', async () => {
    const scripted = new ScriptedAgent([], []);
    const { deps: d, started } = deps(scripted);

    const outcome = await startRun(d, input({ plan: plan('someone-else') }));
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0]!.message).toContain('different project');
    expect(started).toHaveLength(0);
  });

  it('rechecks a confirmed plan after its renderer IPC round trip', async () => {
    const scripted = new ScriptedAgent([], []);
    const { deps: d, started } = deps(scripted);
    const tampered = plan(h.project.id);
    tampered.agents[0] = { ...tampered.agents[0]!, name: 'builder' };

    const outcome = await startRun(d, input({ plan: tampered }));

    expect(outcome.ok).toBe(false);
    expect(outcome.issues).toContainEqual(
      expect.objectContaining({
        where: 'agents.builder',
        message: expect.stringContaining('shadow nothing'),
      }),
    );
    expect(started).toHaveLength(0);
  });

  it('accepts an explicit operator re-cast onto another enabled model at confirmation', async () => {
    const scripted = new ScriptedAgent([buildEnvelope(), reviewEnvelope()], ['USAGE.md', null]);
    const { deps: d, started, settled } = deps(scripted);
    const overridden = plan(h.project.id);
    overridden.pipeline.phases[1] = {
      ...overridden.pipeline.phases[1]!,
      model: 'scripted/strong',
    };

    const outcome = await startRun(d, input({ plan: overridden }));
    expect(outcome.ok).toBe(true);
    expect(started[0]!.pipeline.phases[1]!.model).toBe('scripted/strong');
    await expect(settled[0]!).resolves.toBe('accepted');
  });

  it('refuses an override naming a model this install does not enable', async () => {
    const scripted = new ScriptedAgent([], []);
    const { deps: d, started } = deps(scripted);
    const tampered = plan(h.project.id);
    tampered.pipeline.phases[0] = { ...tampered.pipeline.phases[0]!, model: 'someone/else' };

    const outcome = await startRun(d, input({ plan: tampered }));

    expect(outcome.ok).toBe(false);
    expect(outcome.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('not allowed') }),
    );
    expect(started).toHaveLength(0);
  });

  it('fails closed when the live enabled-model catalog is unavailable at confirmation', async () => {
    const scripted = new ScriptedAgent([], []);
    const { deps: d, started } = deps(scripted);
    d.enabledModelIds = async () => [];

    const outcome = await startRun(d, input());

    expect(outcome.ok).toBe(false);
    expect(outcome.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('catalog is unavailable') }),
    );
    expect(started).toHaveLength(0);
  });

  it('refuses a plan whose agent phase still inherits its model', async () => {
    const scripted = new ScriptedAgent([], []);
    const { deps: d, started } = deps(scripted);
    const inheriting = plan(h.project.id);
    delete inheriting.pipeline.phases[0]!.model;

    const outcome = await startRun(d, input({ plan: inheriting }));

    expect(outcome.ok).toBe(false);
    expect(outcome.issues).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('must name its own model') }),
    );
    expect(started).toHaveLength(0);
  });

  it('leaves the classic manual path byte-for-byte unaffected', async () => {
    const scripted = new ScriptedAgent([buildEnvelope()], [null]);
    const { deps: d, settled } = deps(scripted);
    const manual: PipelineDef = {
      id: 'manual',
      name: 'manual',
      description: 'one build phase',
      acceptance: { kind: 'all_phases_pass' },
      phases: [
        {
          name: 'build',
          kind: 'agent',
          agent: 'builder',
          description: 'Make the requested change inside the worktree.',
          envelope: 'build',
          prompt: { inputs: ['request'] },
        },
      ],
    };
    d.pipelineFor = () => manual;

    const outcome = await startRun(d, {
      projectId: h.project.id,
      pipelineId: 'manual',
      request: 'do the thing',
    });
    expect(outcome.ok).toBe(true);
    await settled[0]!;

    const run = h.tracer.run(outcome.runId!)!;
    expect(run.orchestrated).toBe(false);
    expect(run.amendments).toBe(0);
    expect(h.tracer.runPlan(outcome.runId!)).toBeNull();
    expect(existsSync(join(h.tracer.runDir(outcome.runId!), 'plan.json'))).toBe(false);
  });
});
