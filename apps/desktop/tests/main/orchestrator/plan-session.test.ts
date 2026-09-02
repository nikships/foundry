/**
 * The Orchestrator's planning session against a scripted one-shot, mirroring
 * `detect-session.test.ts`: the prompt, the strict-JSON parse, the store +
 * preflight rails, the bounded correction loop, and cancel. Transcript fold
 * and registry sweep live in `panel-session.test.ts`.
 *
 * The session is scripted rather than spawned: what is under test is what
 * `PlanSession` does with a turn, and a real one would need a credential, a
 * network, and a model.
 */

import { describe, expect, it } from 'vitest';
import { FIXED_ENGINE_DEFAULTS } from '../../../src/shared/types.js';
import type { AgentDef, ModelInfo, ProjectCommand } from '../../../src/shared/types.js';
import type { OrchestratorState } from '../../../src/shared/ipc-contract.js';
import { PlanSession } from '../../../src/main/orchestrator/plan-session.js';
import { generatedCompositionIssues } from '../../../src/main/orchestrator/plan.js';
import { BUILTIN_AGENTS } from '../../../src/shared/builtin-agents.js';
import { BUILTIN_PIPELINES } from '../../../src/shared/builtin-pipelines.js';
import { scriptedOneShots, type ScriptedTurn } from '../../helpers/scripted-oneshot.js';

const builder = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: 'builder',
  purpose: 'build things',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
  ...over,
});

const commands: ProjectCommand[] = [{ name: 'test', argv: ['npm', 'test'] }];

const model = (id: string, displayName: string, intelligence?: number): ModelInfo => ({
  id,
  displayName,
  provider: 'claude',
  supportedReasoningEfforts: ['off', 'low', 'medium', 'high'],
  defaultReasoningEffort: 'medium',
  isCustom: false,
  deprecated: false,
  contextWindow: 200_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  ...(intelligence === undefined ? {} : { intelligence }),
});

/**
 * What the fixture install can reach; the Orchestrator must appoint from it.
 * One rated and one unrated, because roughly half the real catalog is unrated
 * and the prompt has to read sensibly for both.
 */
const enabled: ModelInfo[] = [
  model('anthropic/claude-opus-4', 'Claude Opus 4', 61.5),
  model('anthropic/claude-haiku-4', 'Claude Haiku 4'),
];

/** A reply that passes the schema and both rails against the fixture roster. */
function validReply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    refinedRequest: 'Add a CHANGES.md that records this repository’s release notes.',
    rationale: 'One build phase followed by proof, since the change is small and testable.',
    pipeline: {
      name: 'Write the changes file',
      description: 'Build the requested change, then prove it with the test command.',
      acceptance: { kind: 'all_phases_pass' },
      phases: [
        {
          name: 'build',
          kind: 'agent',
          agent: 'builder',
          model: 'anthropic/claude-opus-4',
          reasoningEffort: 'high',
          description: 'Make the requested change inside the worktree.',
          envelope: 'build',
          prompt: { inputs: ['request'] },
        },
        {
          name: 'test',
          kind: 'code',
          description: 'Run the project test command as proof of the change.',
          command: { ref: 'test' },
          feedbackTo: 'build',
        },
      ],
    },
    agents: [],
    ...over,
  });
}

function submitted(text: string): ScriptedTurn {
  return { structuredOutput: JSON.parse(text) as Record<string, unknown> };
}

async function run(opts: {
  turns: ScriptedTurn[];
  roster?: AgentDef[];
  models?: ModelInfo[];
  defaultModel?: string;
  orchestratorModel?: string;
  ghAvailable?: () => Promise<boolean>;
}): Promise<{
  session: PlanSession;
  state: OrchestratorState;
  oneShots: ReturnType<typeof scriptedOneShots>;
  prompts: string[];
}> {
  const oneShots = scriptedOneShots(opts.turns);
  const prompts: string[] = [];
  const oneShot: typeof oneShots.factory = (options) => {
    const session = oneShots.factory(options);
    return {
      abort: () => session.abort(),
      send: (prompt) => {
        prompts.push(prompt);
        return session.send(prompt);
      },
    };
  };
  const states: OrchestratorState[] = [];
  const session = new PlanSession({
    projectId: 'p1',
    projectPath: '/tmp/somewhere',
    prompt: 'add a changes file',
    model: opts.orchestratorModel ?? 'inherit',
    defaultModel: opts.defaultModel ?? 'inherit',
    reasoningEffort: 'high',
    contextSummary: 'A small demo repository.',
    commands,
    roster: opts.roster ?? [builder()],
    envelopeDefs: [],
    enabledModels: async () => opts.models ?? enabled,
    ghAvailable: opts.ghAvailable,
    oneShot,
    onChange: (state) => states.push(state),
  });
  await session.run();
  expect(states.length).toBeGreaterThan(0);
  return { session, state: session.snapshot(), oneShots, prompts };
}

describe('PlanSession', () => {
  it('produces a validated plan with Foundry-owned ids from a good reply', async () => {
    const { session, state } = await run({ turns: [submitted(validReply())] });

    expect(state.status).toBe('done');
    const plan = state.plan!;
    expect(plan.planId).toBe(session.planId);
    expect(plan.projectId).toBe('p1');
    expect(plan.prompt).toBe('add a changes file');
    expect(plan.refinedRequest).toContain('CHANGES.md');
    // The model never chooses ids: the pipeline is stamped generated-<planId>
    // and can never masquerade as a builtin.
    expect(plan.pipeline.id).toBe(`generated-${session.planId}`);
    expect(plan.pipeline.builtin).toBe(false);
    expect(plan.model).toBe('inherit');
    expect(plan.reasoningEffort).toBe('high');
    expect(plan.pipeline.phases[0]?.reasoningEffort).toBe('high');
  });

  it('opens read-only at the project checkout on the chosen model', async () => {
    const { oneShots } = await run({ turns: [submitted(validReply())] });

    // Planning has no worktree and no boundary diff, so a write here would be
    // permanent: the session has no tool that could make one.
    expect(oneShots.calls).toHaveLength(1);
    expect(oneShots.calls[0]!.access).toBe('read');
    expect(oneShots.calls[0]!.cwd).toBe('/tmp/somewhere');
    expect(oneShots.calls[0]!.reasoningEffort).toBe('high');
    expect(oneShots.calls[0]!.outputFormat?.type).toBe('json_schema');
    expect(oneShots.calls[0]!.outputFormat?.schema).toMatchObject({ type: 'object' });
    expect(oneShots.calls[0]!.outputFormat?.schema).not.toHaveProperty('$schema');
    expect(oneShots.calls[0]!.outputFormat?.schema).toHaveProperty(
      'properties.pipeline.properties.phases',
    );
  });

  it('gives the Orchestrator the commands, roster, and few-shot pipelines', async () => {
    const oneShots = scriptedOneShots([submitted(validReply())]);
    const prompts: string[] = [];
    const factory: typeof oneShots.factory = (opts) => {
      const session = oneShots.factory(opts);
      return {
        abort: () => session.abort(),
        send: (prompt) => {
          prompts.push(prompt);
          return session.send(prompt);
        },
      };
    };
    const session = new PlanSession({
      projectId: 'p1',
      projectPath: '/tmp/somewhere',
      prompt: 'add a changes file',
      model: 'inherit',
      defaultModel: 'inherit',
      reasoningEffort: 'medium',
      contextSummary: 'A small demo repository.',
      commands,
      roster: [builder()],
      envelopeDefs: [{ name: 'audit', description: 'audit findings', fields: [] }],
      enabledModels: async () => enabled,
      oneShot: factory,
      onChange: () => {},
    });
    await session.run();

    const ask = prompts[0]!;
    expect(ask).toContain('add a changes file');
    expect(ask).toContain('A small demo repository.');
    expect(ask).toContain('- test: npm test');
    expect(ask).toContain('- builder: build things');
    expect(ask).toContain('- audit: audit findings');
    expect(ask).toContain('verdict_consistent');
    // With both pins inherited, the cast pool remains the full enabled
    // catalog, shown as exact ids rather than names the model could invent.
    expect(ask).toContain('## Phase model cast pool');
    expect(ask).toContain('- anthropic/claude-opus-4 — Claude Opus 4');
    expect(ask).toContain('- anthropic/claude-haiku-4 — Claude Haiku 4');
    expect(ask).toContain('efforts off/low/medium/high');
    // Casting is a capability question: the score is shown, and the numbers
    // that would invite a budget or context argument are not.
    expect(ask).toContain('intelligence 61.5');
    expect(ask).toContain('intelligence unrated');
    expect(ask).not.toContain('$3/M input');
    expect(ask).not.toContain('200k context');
    expect(ask).toContain('"model":"anthropic/claude-opus-4"');
    expect(ask).toContain('"model":"anthropic/claude-haiku-4"');
    // Builtin pipelines ride along as few-shot examples of valid shapes.
    expect(ask).toContain('## Builtin pipelines');
    expect(oneShots.calls[0]!.systemPrompt).toContain('untrusted task data');
    expect(oneShots.calls[0]!.systemPrompt).toContain('Call submit_result exactly once');
  });

  it('uses the Agent Defaults pin as the cast pool when the Orchestrator inherits', async () => {
    const extra = model('openai/gpt-5', 'GPT 5');
    const { state, prompts } = await run({
      turns: [submitted(validReply())],
      models: [...enabled, extra],
      defaultModel: 'anthropic/claude-opus-4',
    });

    expect(state.status).toBe('done');
    expect(prompts[0]).toContain('- anthropic/claude-opus-4 — Claude Opus 4');
    expect(prompts[0]).not.toContain('anthropic/claude-haiku-4');
    expect(prompts[0]).not.toContain('openai/gpt-5');
  });

  it('unions distinct default and Orchestrator pins and rejects an off-pool cast', async () => {
    const offPolicy = validReply().replace('anthropic/claude-opus-4', 'openai/gpt-5');
    const { state, oneShots, prompts } = await run({
      turns: [submitted(offPolicy), submitted(validReply())],
      models: [...enabled, model('openai/gpt-5', 'GPT 5')],
      defaultModel: 'anthropic/claude-opus-4',
      orchestratorModel: 'anthropic/claude-haiku-4',
    });

    expect(state.status).toBe('done');
    expect(oneShots.calls[0]!.model).toBe('anthropic/claude-haiku-4');
    expect(prompts[0]).toContain('anthropic/claude-opus-4');
    expect(prompts[0]).toContain('anthropic/claude-haiku-4');
    expect(prompts[0]).not.toContain('openai/gpt-5');
    expect(state.entries.some((entry) => entry.text.includes('not allowed'))).toBe(true);
  });

  it('fails closed when a configured cast pin is unavailable or hidden', async () => {
    const { state, oneShots } = await run({
      turns: [],
      defaultModel: 'openai/gpt-9',
    });

    expect(state.status).toBe('failed');
    expect(state.detail).toContain('openai/gpt-9');
    expect(state.detail).toContain('unavailable or hidden');
    expect(oneShots.calls).toHaveLength(0);
  });

  it('refuses a plan whose agent phase inherits a model instead of naming one', async () => {
    const inheriting = validReply().replace('"model":"anthropic/claude-opus-4",', '');
    const { state } = await run({ turns: [submitted(inheriting), submitted(validReply())] });

    expect(state.status).toBe('done');
    expect(state.entries.some((e) => e.text.includes('must name its own model'))).toBe(true);
  });

  it('refuses a plan whose agent phase omits its reasoning effort', async () => {
    const inheriting = validReply().replace('"reasoningEffort":"high",', '');
    const { state } = await run({ turns: [submitted(inheriting), submitted(validReply())] });

    expect(state.status).toBe('done');
    expect(state.entries.some((e) => e.text.includes('must name its own reasoning effort'))).toBe(
      true,
    );
  });

  it('refuses a reasoning effort the appointed model does not support', async () => {
    const unsupported = validReply().replace('"reasoningEffort":"high"', '"reasoningEffort":"max"');
    const { state } = await run({ turns: [submitted(unsupported), submitted(validReply())] });

    expect(state.status).toBe('done');
    expect(state.entries.some((e) => e.text.includes('does not support reasoning effort'))).toBe(
      true,
    );
  });

  it('refuses a phase model this install does not enable', async () => {
    const unreachable = validReply().replace('anthropic/claude-opus-4', 'openai/gpt-9');
    const { state } = await run({ turns: [submitted(unreachable), submitted(validReply())] });

    expect(state.status).toBe('done');
    expect(state.entries.some((e) => e.text.includes('not allowed'))).toBe(true);
  });

  it('stands down the per-phase rail when the catalog cannot be read at all', async () => {
    const inheriting = validReply().replace('"model":"anthropic/claude-opus-4",', '');
    const { state } = await run({ turns: [submitted(inheriting)], models: [] });

    // An unreachable catalog is the install's problem, not the plan's: every
    // plan would otherwise be refused with an error no operator could act on.
    expect(state.status).toBe('done');
    expect(state.plan).not.toBeNull();
  });

  it('checks GitHub in the background and rules out a PR phase when unavailable', async () => {
    const { prompts } = await run({
      turns: [submitted(validReply())],
      ghAvailable: async () => false,
    });

    expect(prompts[0]).toContain('GitHub is not available for this project');
    expect(prompts[0]).toContain('do not compose a PR phase');
  });

  it('reads GitHub availability and the model catalog concurrently', async () => {
    let ghStarted = false;
    let modelsStarted = false;
    let release!: () => void;
    const bothMayFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oneShots = scriptedOneShots([submitted(validReply())]);
    const session = new PlanSession({
      projectId: 'p1',
      projectPath: '/tmp/somewhere',
      prompt: 'add a changes file',
      model: 'inherit',
      defaultModel: 'inherit',
      reasoningEffort: 'medium',
      contextSummary: '',
      commands,
      roster: [builder()],
      envelopeDefs: [],
      ghAvailable: async () => {
        ghStarted = true;
        await bothMayFinish;
        return false;
      },
      enabledModels: async () => {
        modelsStarted = true;
        await bothMayFinish;
        return enabled;
      },
      oneShot: oneShots.factory,
      onChange: () => {},
    });

    const running = session.run();
    await until(() => ghStarted && modelsStarted);
    release();
    await running;

    expect(session.snapshot().status).toBe('done');
  });

  it('requires submit_result even when assistant prose contains valid JSON', async () => {
    const rejected = validReply();
    const { state, oneShots, prompts } = await run({
      turns: [{ text: rejected }, submitted(validReply())],
    });

    expect(state.status).toBe('done');
    expect(state.plan).not.toBeNull();
    // One session per attempt: the correction opens a fresh one-shot.
    expect(oneShots.calls).toHaveLength(2);
    // That fresh session still receives everything needed to understand and
    // repair the previous attempt rather than seeing orphaned validation text.
    expect(prompts[1]).toContain('add a changes file');
    expect(prompts[1]).toContain(rejected);
    expect(prompts[1]).toContain('submit_result was not called');
    expect(prompts[1]).toContain('did not call submit_result');
    expect(state.entries.some((e) => e.text.includes('did not call submit_result'))).toBe(true);
    expect(oneShots.calls[1]!.outputFormat).toBe(oneShots.calls[0]!.outputFormat);
  });

  it('sends rail failures back as a correction, so only a valid plan renders', async () => {
    const unknownAgent = validReply();
    const broken = unknownAgent.replace('"agent":"builder"', '"agent":"nobody"');
    const { state } = await run({ turns: [submitted(broken), submitted(validReply())] });

    expect(state.status).toBe('done');
    expect(state.entries.some((e) => e.text.includes('no agent named "nobody"'))).toBe(true);
  });

  it('rejects engine-owned fields in the submitted object', async () => {
    const withId = JSON.parse(validReply()) as Record<string, unknown>;
    (withId.pipeline as Record<string, unknown>).id = 'model-owned-id';
    const { state } = await run({
      turns: [{ structuredOutput: withId }, submitted(validReply())],
    });

    expect(state.status).toBe('done');
    expect(state.entries.some((entry) => entry.text.includes('Unrecognized key: "id"'))).toBe(true);
    expect(state.plan!.pipeline.id).not.toBe('model-owned-id');
  });

  it('requires configured proof immediately after an implementation phase', async () => {
    const missingProof = validReply({
      pipeline: {
        name: 'Unproven build',
        description: 'Build the change without proving it.',
        acceptance: { kind: 'all_phases_pass' },
        phases: [
          {
            name: 'build',
            kind: 'agent',
            agent: 'builder',
            model: 'anthropic/claude-opus-4',
            description: 'Make the requested change inside the worktree.',
            envelope: 'build',
            prompt: { inputs: ['request'] },
          },
        ],
      },
    });
    const { state } = await run({
      turns: [submitted(missingProof), submitted(validReply())],
    });

    expect(state.status).toBe('done');
    expect(
      state.entries.some((entry) =>
        entry.text.includes('immediately followed by a configured proof'),
      ),
    ).toBe(true);
  });

  it('requires proof failures to return to the implementation owner', async () => {
    const detachedProof = validReply().replace(',"feedbackTo":"build"', '');
    const { state } = await run({
      turns: [submitted(detachedProof), submitted(validReply())],
    });

    expect(state.status).toBe('done');
    expect(state.entries.some((entry) => entry.text.includes('must set feedbackTo'))).toBe(true);
  });

  it('requires both consistency gates on every review phase', async () => {
    const unguardedReview = validReply({
      pipeline: {
        name: 'Unguarded review',
        description: 'Review the work and then prove any edits.',
        acceptance: { kind: 'all_phases_pass' },
        phases: [
          {
            name: 'review',
            kind: 'agent',
            agent: 'builder',
            model: 'anthropic/claude-opus-4',
            description: 'Review and repair the requested change.',
            envelope: 'review',
            prompt: { inputs: ['request'] },
          },
          {
            name: 'test',
            kind: 'code',
            description: 'Prove any repairs made by the review.',
            command: { ref: 'test' },
            feedbackTo: 'review',
          },
        ],
      },
    });
    const { state } = await run({
      turns: [submitted(unguardedReview), submitted(validReply())],
    });

    expect(state.status).toBe('done');
    expect(state.entries.some((entry) => entry.text.includes('verdict_consistent'))).toBe(true);
    expect(state.entries.some((entry) => entry.text.includes('disapproval_halts'))).toBe(true);
  });

  it('requires synthesized judge-only reviewers to have no write tools', async () => {
    const writableReviewer = validReply({
      pipeline: {
        name: 'Review',
        description: 'Use a synthesized reviewer to judge the request.',
        acceptance: { kind: 'all_phases_pass' },
        phases: [
          {
            name: 'review',
            kind: 'agent',
            agent: 'plan_reviewer',
            model: 'anthropic/claude-opus-4',
            description: 'Judge the result against the request.',
            envelope: 'review',
            prompt: { inputs: ['request'] },
            gates: ['verdict_consistent', 'disapproval_halts'],
          },
        ],
      },
      agents: [
        {
          name: 'plan_reviewer',
          purpose: 'judge the result without editing it',
          systemPrompt: 'Review the result.',
          userPrompt: 'Review: {{request}}',
          writes: [],
          envelope: 'review',
        },
      ],
    });
    const { state } = await run({
      turns: [submitted(writableReviewer), submitted(validReply())],
    });

    expect(state.status).toBe('done');
    expect(state.entries.some((entry) => entry.text.includes('read-only tool profile'))).toBe(true);
  });

  it('refuses a synthesized agent that shadows a roster name', async () => {
    const shadowing = validReply({
      agents: [
        {
          name: 'builder',
          purpose: 'a second builder',
          systemPrompt: 'You build again.',
          userPrompt: 'Build: {{request}}',
          writes: ['docs/**'],
          envelope: 'build',
        },
      ],
    });
    const { state } = await run({
      turns: [submitted(shadowing), submitted(validReply())],
    });

    expect(state.status).toBe('done');
    expect(state.entries.some((e) => e.text.includes('shadow'))).toBe(true);
  });

  it('refuses two synthesized agents with the same name', async () => {
    const duplicate = {
      name: 'doc_writer',
      purpose: 'write one document',
      systemPrompt: 'You write docs.',
      userPrompt: 'Write: {{request}}',
      writes: ['docs/**'],
      envelope: 'build',
    };
    const duplicated = validReply({ agents: [duplicate, duplicate] });
    const { state } = await run({
      turns: [submitted(duplicated), submitted(validReply())],
    });

    expect(state.status).toBe('done');
    expect(state.entries.some((entry) => entry.text.includes('doc_writer'))).toBe(true);
    expect(state.entries.some((entry) => entry.text.includes('shadow'))).toBe(true);
  });

  it('accepts a synthesized agent and fills the fields the model does not own', async () => {
    const synth = validReply({
      pipeline: {
        name: 'Docs',
        description: 'Write the doc with a synthesized writer, then prove it.',
        acceptance: { kind: 'all_phases_pass' },
        phases: [
          {
            name: 'write_doc',
            kind: 'agent',
            agent: 'doc_writer',
            model: 'anthropic/claude-haiku-4',
            reasoningEffort: 'low',
            description: 'Write the requested document into docs/.',
            envelope: 'build',
            prompt: { inputs: ['request'] },
          },
          {
            name: 'test',
            kind: 'code',
            description: 'Run the project test command as proof of the change.',
            command: { ref: 'test' },
            feedbackTo: 'write_doc',
          },
        ],
      },
      agents: [
        {
          name: 'doc_writer',
          purpose: 'write one document',
          systemPrompt: 'You write docs.',
          userPrompt: 'Write: {{request}}',
          writes: ['docs/**'],
          envelope: 'build',
          toolProfile: 'full',
        },
      ],
    });
    const { state } = await run({ turns: [submitted(synth)] });

    expect(state.status).toBe('done');
    const agent = state.plan!.agents[0]!;
    expect(agent.name).toBe('doc_writer');
    expect(agent.model).toBe('inherit');
    expect(agent.reasoningEffort).toBe('medium');
    expect(agent.writes).toEqual(['docs/**']);
    expect(agent.toolProfile).toBe('full');
    expect(agent.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('fails the session once the correction budget is spent, keeping the raw reply', async () => {
    const attempts = 1 + FIXED_ENGINE_DEFAULTS.envelopeRetries;
    const { state, oneShots } = await run({
      turns: Array.from({ length: attempts }, () => ({ text: 'still not JSON' })),
    });

    expect(state.status).toBe('failed');
    expect(state.plan).toBeNull();
    expect(state.detail).toContain(`${attempts} attempts`);
    expect(state.rawReply).toBe('still not JSON');
    expect(oneShots.calls).toHaveLength(attempts);
  });

  it('surfaces a turn that could not run rather than reporting an empty plan', async () => {
    const { state } = await run({
      turns: [{ throws: 'the model ended the turn with an error: blocked' }],
    });

    expect(state.status).toBe('failed');
    expect(state.detail).toContain('blocked');
    expect(state.entries.some((e) => e.kind === 'error')).toBe(true);
  });

  it('cancels the turn in flight and settles cancelled', async () => {
    const oneShots = scriptedOneShots([{ hangUntilAbort: true }]);
    const session = new PlanSession({
      projectId: 'p1',
      projectPath: '/tmp/somewhere',
      prompt: 'add a changes file',
      model: 'inherit',
      defaultModel: 'inherit',
      reasoningEffort: 'medium',
      contextSummary: '',
      commands,
      roster: [builder()],
      envelopeDefs: [],
      oneShot: oneShots.factory,
      onChange: () => {},
    });

    const running = session.run();
    await until(() => oneShots.calls.length === 1);
    session.cancel();
    await running;

    const state = session.snapshot();
    expect(state.status).toBe('cancelled');
    expect(state.plan).toBeNull();
    expect(state.entries.some((e) => e.text === 'Cancelled.')).toBe(true);
  });
});

async function until(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the session');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('generatedCompositionIssues', () => {
  it('accepts builtin sdlc-pr as the few-shot shape with a read-only reviewer', () => {
    const sdlc = BUILTIN_PIPELINES.find((pipeline) => pipeline.id === 'sdlc-pr')!;
    expect(generatedCompositionIssues(sdlc, [], BUILTIN_AGENTS, ['test'])).toEqual([]);
  });

  it('rejects a ship-like plan that PRs after only a write-capable finisher', () => {
    const ship = BUILTIN_PIPELINES.find((pipeline) => pipeline.id === 'ship-pr')!;
    const issues = generatedCompositionIssues(ship, [], BUILTIN_AGENTS, ['test']);
    expect(issues.some((issue) => issue.message.includes('read-only review before open_pr'))).toBe(
      true,
    );
  });
});
