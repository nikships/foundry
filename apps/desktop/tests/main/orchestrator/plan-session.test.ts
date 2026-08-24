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
import type { AgentDef, ProjectCommand } from '../../../src/shared/types.js';
import type { OrchestratorState } from '../../../src/shared/ipc-contract.js';
import { PlanSession } from '../../../src/main/orchestrator/plan-session.js';
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
          description: 'Make the requested change inside the worktree.',
          envelope: 'build',
          prompt: { inputs: ['request'] },
        },
        {
          name: 'test',
          kind: 'code',
          description: 'Run the project test command as proof of the change.',
          command: { ref: 'test' },
        },
      ],
    },
    agents: [],
    ...over,
  });
}

async function run(opts: {
  turns: ScriptedTurn[];
  roster?: AgentDef[];
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
    model: 'inherit',
    reasoningEffort: 'high',
    contextSummary: 'A small demo repository.',
    commands,
    roster: opts.roster ?? [builder()],
    envelopeDefs: [],
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
    const { session, state } = await run({ turns: [{ text: validReply() }] });

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
  });

  it('opens read-only at the project checkout on the chosen model', async () => {
    const { oneShots } = await run({ turns: [{ text: validReply() }] });

    // Planning has no worktree and no boundary diff, so a write here would be
    // permanent: the session has no tool that could make one.
    expect(oneShots.calls).toHaveLength(1);
    expect(oneShots.calls[0]!.access).toBe('read');
    expect(oneShots.calls[0]!.cwd).toBe('/tmp/somewhere');
    expect(oneShots.calls[0]!.reasoningEffort).toBe('high');
  });

  it('gives the Orchestrator the commands, roster, and few-shot pipelines', async () => {
    const oneShots = scriptedOneShots([
      {
        text: validReply(),
      },
    ]);
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
      reasoningEffort: 'medium',
      contextSummary: 'A small demo repository.',
      commands,
      roster: [builder()],
      envelopeDefs: [{ name: 'audit', description: 'audit findings', fields: [] }],
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
    // Builtin pipelines ride along as few-shot examples of valid shapes.
    expect(ask).toContain('## Builtin pipelines');
  });

  it('checks GitHub in the background and rules out a PR phase when unavailable', async () => {
    const { prompts } = await run({
      turns: [{ text: validReply() }],
      ghAvailable: async () => false,
    });

    expect(prompts[0]).toContain('GitHub is not available for this project');
    expect(prompts[0]).toContain('do not compose a PR phase');
  });

  it('sends parse errors back as a correction and accepts the fixed reply', async () => {
    const rejected = 'Here is my thinking, no JSON though.';
    const { state, oneShots, prompts } = await run({
      turns: [{ text: rejected }, { text: validReply() }],
    });

    expect(state.status).toBe('done');
    expect(state.plan).not.toBeNull();
    // One session per attempt: the correction opens a fresh one-shot.
    expect(oneShots.calls).toHaveLength(2);
    // That fresh session still receives everything needed to understand and
    // repair the previous attempt rather than seeing orphaned validation text.
    expect(prompts[1]).toContain('add a changes file');
    expect(prompts[1]).toContain(rejected);
    expect(prompts[1]).toContain('the reply contained no JSON object');
    expect(state.entries.some((e) => e.text.includes('no JSON object'))).toBe(true);
  });

  it('sends rail failures back as a correction, so only a valid plan renders', async () => {
    const unknownAgent = validReply();
    const broken = unknownAgent.replace('"agent":"builder"', '"agent":"nobody"');
    const { state } = await run({ turns: [{ text: broken }, { text: validReply() }] });

    expect(state.status).toBe('done');
    expect(state.entries.some((e) => e.text.includes('no agent named "nobody"'))).toBe(true);
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
    const { state } = await run({ turns: [{ text: shadowing }, { text: validReply() }] });

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
    const { state } = await run({ turns: [{ text: duplicated }, { text: validReply() }] });

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
            description: 'Write the requested document into docs/.',
            envelope: 'build',
            prompt: { inputs: ['request'] },
          },
          {
            name: 'test',
            kind: 'code',
            description: 'Run the project test command as proof of the change.',
            command: { ref: 'test' },
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
          toolProfile: 'read-only',
        },
      ],
    });
    const { state } = await run({ turns: [{ text: synth }] });

    expect(state.status).toBe('done');
    const agent = state.plan!.agents[0]!;
    expect(agent.name).toBe('doc_writer');
    expect(agent.model).toBe('inherit');
    expect(agent.reasoningEffort).toBe('medium');
    expect(agent.writes).toEqual(['docs/**']);
    expect(agent.toolProfile).toBe('read-only');
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
