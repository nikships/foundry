/**
 * The Foundry extension: what the agent runtime is actually handed.
 *
 * The runtime has no permission handler to install — the enforcement point is
 * the `tool_call` event, which runs before a tool executes and can block it. So
 * this is where the zero-interrupt policy is actually applied, and a hole here
 * is a call that ran without a verdict.
 *
 * The other job is `submit_envelope`, which changes shape per phase. Swapping it
 * has to hand over a whole new definition (the runtime caches validators against
 * the schema object's identity) and must only happen between turns.
 *
 * A hand-rolled `ExtensionAPI` stand-in rather than a real session: what is
 * under test is what Foundry registers and what it answers, not the runtime's
 * own dispatch.
 */

import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { foundryExtension } from '../../../src/main/pi/policy-extension.js';
import { submitEnvelopeTool } from '../../../src/main/pi/tools.js';
import type {
  FoundryToolContext,
  PermissionAsk,
  PermissionDecision,
} from '../../../src/main/pi/transport.js';
import { jsonSchemaFor } from '../../../src/main/engine/envelopes.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';

/** What the extension registers, and the hook it installs. */
interface FakeApi {
  tools: { name: string; parameters: unknown }[];
  toolCall?: (event: {
    toolName: string;
    input: Record<string, unknown>;
  }) => Promise<{ block: true; reason: string } | undefined | void>;
  beforeAgentStart?: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined;
}

/**
 * Enough of `ExtensionAPI` for the extension to bind against. The cast is the
 * point of the stand-in: implementing the full surface would be testing the
 * runtime rather than Foundry.
 */
function fakeApi(): {
  api: Parameters<ReturnType<typeof foundryExtension>['factory']>[0];
  state: FakeApi;
} {
  const state: FakeApi = { tools: [] };
  const api = {
    registerTool: (tool: { name: string; parameters: unknown }) => {
      // The runtime replaces a tool by name; the fake mirrors that so a swap
      // does not read as two registrations.
      const at = state.tools.findIndex((t) => t.name === tool.name);
      if (at >= 0) state.tools[at] = tool;
      else state.tools.push(tool);
    },
    on: (event: string, handler: unknown) => {
      if (event === 'tool_call') state.toolCall = handler as FakeApi['toolCall'];
      if (event === 'before_agent_start') {
        state.beforeAgentStart = handler as FakeApi['beforeAgentStart'];
      }
    },
  };
  return { api: api as never, state };
}

function toolContext(): FoundryToolContext {
  const support = tempDir('foundry-pi-ext-');
  const repo = tempDir('foundry-pi-ext-repo-');
  const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  return {
    runId: 'run_ext',
    agentName: 'builder',
    phaseId: () => null,
    envelopes: () => new Map(),
    tracer,
    diff: () => ({ cwd: repo, branchPointSha: '' }),
  };
}

function bind(decide: (ask: PermissionAsk) => PermissionDecision | Promise<PermissionDecision>) {
  const handle = foundryExtension({ tools: toolContext(), decide });
  const { api, state } = fakeApi();
  handle.factory(api);
  return { handle, state };
}

const allow = (): PermissionDecision => ({ outcome: 'allow' });

describe('what the extension registers', () => {
  it('registers Foundry’s standing tools when it binds', () => {
    const { state } = bind(allow);
    expect(state.tools.map((t) => t.name)).toEqual([
      'report_progress',
      'read_phase_context',
      'git_diff',
    ]);
  });

  it('installs an envelope tool that was set before it bound', () => {
    const handle = foundryExtension({ tools: toolContext(), decide: allow });
    const envelope = submitEnvelopeTool(
      jsonSchemaFor('build') as unknown as Record<string, unknown>,
    );
    // The transport learns the phase's schema before the session exists, so a
    // pending tool must survive until there is an API to register it against.
    handle.useEnvelopeTool(envelope);
    const { api, state } = fakeApi();
    handle.factory(api);
    expect(state.tools.map((t) => t.name)).toContain('submit_envelope');
  });

  it('replaces the envelope tool by name rather than stacking a second one', () => {
    const handle = foundryExtension({ tools: toolContext(), decide: allow });
    const { api, state } = fakeApi();
    handle.factory(api);

    const build = submitEnvelopeTool(jsonSchemaFor('build') as unknown as Record<string, unknown>);
    handle.useEnvelopeTool(build);
    const review = submitEnvelopeTool(
      jsonSchemaFor('review') as unknown as Record<string, unknown>,
    );
    handle.useEnvelopeTool(review);

    expect(state.tools.filter((t) => t.name === 'submit_envelope')).toHaveLength(1);
    // And it is the new phase's schema that is live, not the previous phase's.
    const live = state.tools.find((t) => t.name === 'submit_envelope')!;
    expect(live.parameters).toBe(review.definition.parameters);
  });

  it('is a no-op when asked to install nothing', () => {
    const { handle, state } = bind(allow);
    handle.useEnvelopeTool(null);
    expect(state.tools.map((t) => t.name)).toEqual([
      'report_progress',
      'read_phase_context',
      'git_diff',
    ]);
  });
});

describe('the policy hook', () => {
  it('lets an allowed call through untouched', async () => {
    const { state } = bind(allow);
    const result = await state.toolCall!({ toolName: 'bash', input: { command: 'npm test' } });
    // Returning nothing is how the runtime is told to proceed.
    expect(result).toBeUndefined();
  });

  it('blocks a denied call and hands the reason back to the model', async () => {
    const { state } = bind(() => ({ outcome: 'deny', reason: 'outside the run worktree' }));
    const result = await state.toolCall!({ toolName: 'write', input: { path: '/etc/hosts' } });
    // The reason is not decoration: it is what the agent reads to try something
    // else, so a block without one would just look like a broken tool.
    expect(result).toEqual({ block: true, reason: 'outside the run worktree' });
  });

  it('rules on Foundry’s own tools too', async () => {
    const asked: string[] = [];
    const { state } = bind((ask) => {
      asked.push(ask.tool);
      return allow();
    });
    await state.toolCall!({ toolName: 'submit_envelope', input: { status: 'success' } });
    // A policy with a hole in it is not a policy: every call is ruled on,
    // including the ones Foundry registered itself.
    expect(asked).toEqual(['submit_envelope']);
  });

  it('lifts the command and path out of the arguments for the policy', async () => {
    const asks: PermissionAsk[] = [];
    const { state } = bind((ask) => {
      asks.push(ask);
      return allow();
    });
    await state.toolCall!({ toolName: 'bash', input: { command: 'ls' } });
    await state.toolCall!({ toolName: 'write', input: { path: 'a.ts', content: 'x' } });

    expect(asks[0]).toMatchObject({ tool: 'bash', command: 'ls' });
    expect(asks[1]).toMatchObject({ tool: 'write', path: 'a.ts' });
    // The whole argument object still travels, so a policy can read anything.
    expect(asks[1]!.input).toEqual({ path: 'a.ts', content: 'x' });
  });

  it('copies the arguments, so a later handler’s mutation cannot rewrite the verdict', async () => {
    const asks: PermissionAsk[] = [];
    const { state } = bind((ask) => {
      asks.push(ask);
      return allow();
    });
    const input = { command: 'npm test' };
    await state.toolCall!({ toolName: 'bash', input });
    // `event.input` is mutable and later handlers see earlier mutations; the ask
    // the trace recorded must stay what was actually ruled on.
    input.command = 'rm -rf /';
    expect(asks[0]!.input).toEqual({ command: 'npm test' });
  });

  it('waits for an asynchronous decision rather than proceeding without one', async () => {
    const { state } = bind(
      async () =>
        await new Promise<PermissionDecision>((resolve) =>
          setTimeout(() => resolve({ outcome: 'deny', reason: 'slow but denied' }), 10),
        ),
    );
    expect(await state.toolCall!({ toolName: 'write', input: { path: 'x' } })).toEqual({
      block: true,
      reason: 'slow but denied',
    });
  });
});

describe('the system-prompt hook', () => {
  it('appends the roster role and repository context to Pi’s built prompt', () => {
    const { handle, state } = bind(allow);
    handle.useSystemPrompt(
      '# Builder\n\nYou write the code.\n\n# Repository context\n\nTypeScript.',
    );
    const next = state.beforeAgentStart?.({ systemPrompt: 'You are a Foundry pipeline agent.' });
    expect(next?.systemPrompt).toContain('You are a Foundry pipeline agent.');
    expect(next?.systemPrompt).toContain('# Builder');
    expect(next?.systemPrompt).toContain('# Repository context');
  });

  it('leaves the harness alone when no role is pending', () => {
    const { state } = bind(allow);
    expect(state.beforeAgentStart?.({ systemPrompt: 'harness' })).toBeUndefined();
  });
});
