import { describe, expect, it, vi } from 'vitest';
import { composeHarness } from '../../helpers/smith-compose.js';
import { scriptedOneShots } from '../../helpers/scripted-oneshot.js';
import { createComposeSessions } from '../../../src/main/smith/compose/session.js';
import { ProposalStore } from '../../../src/main/smith/compose/proposals.js';
import { SmithService } from '../../../src/main/smith/index.js';
import { smithComposeTool } from '../../../src/main/smith/compose-tools.js';
import { BUILTIN_AGENTS } from '../../../src/shared/builtin-agents.js';
import type { SmithChatSession } from '../../../src/main/smith/chat-session.js';
import { screenContextBlock } from '../../../src/main/smith/system-prompt.js';

vi.mock('../../../src/main/engine/operations.js', () => ({ warmStartPrep: vi.fn(async () => {}) }));
vi.mock('../../../src/main/pi/enabled-models.js', () => ({
  enabledModels: async () => [],
  enabledModelIds: async () => [],
}));
vi.mock('../../../src/main/system/gh.js', () => ({ ghStatus: async () => ({ available: false }) }));
vi.mock('../../../src/main/system/forge.js', () => ({
  scmStatus: async () => ({ available: false, detail: 'mocked', cli: 'gh' }),
}));

const planReply = {
  refinedRequest: 'Make help text explain the next action. Keep existing shortcuts.',
  rationale: 'Build the change, then run the project checks.',
  pipeline: {
    name: 'Help text',
    description: 'A focused help-text change.',
    acceptance: { kind: 'all_phases_pass' as const },
    phases: [
      {
        name: 'build',
        kind: 'agent' as const,
        agent: 'builder',
        model: 'anthropic/claude-opus-4',
        reasoningEffort: 'high' as const,
        description: 'Improve help.',
        envelope: 'build',
        prompt: { inputs: ['request'] },
        gates: [{ gate: 'command_passes', config: { argv: ['true'] } }],
      },
      {
        name: 'test',
        kind: 'code' as const,
        command: { argv: ['true'] },
        description: 'Check the change.',
      },
    ],
  },
  agents: [] as const,
};

describe('smith compose in-process conversation integration', () => {
  it('runs read-only composition and revision, files one card per revision in open scopes, then gates acceptance', async () => {
    const h = composeHarness();
    const oneShots = scriptedOneShots([
      { structuredOutput: planReply },
      {
        structuredOutput: {
          reply: 'Split the checks.',
          plan: { ...planReply, refinedRequest: 'Split the checks into a separate phase.' },
        },
      },
    ]);
    const plans = createComposeSessions(oneShots.factory, (state) => store.onProgress(state));
    const store = new ProposalStore({
      plans,
      tracerFor: () => h.tracer,
      projectIds: () => ['project'],
      broadcast: () => {},
      startRun: h.startRun,
    });
    const ctx = { ...h.ctx, plans, proposals: store, rosterFor: () => BUILTIN_AGENTS } as never;
    const project = { absorbArtifact: vi.fn() } as unknown as SmithChatSession;
    const global = { absorbArtifact: vi.fn() } as unknown as SmithChatSession;
    const createChat = vi.fn((id) => (id ? project : global));
    const smith = new SmithService({
      composeProposals: store,
      createChat,
      broadcast: () => {},
      channels: { proposalsChanged: 'test' },
      save: () => ({ ok: true, entity: {} }),
    });
    smith.chat('project');
    smith.chat();
    const tool = smithComposeTool({
      ctx,
      queue: smith.proposals,
      projectId: () => undefined,
    });
    const execute = async (params: unknown) => {
      const result = await (
        tool.execute as unknown as (
          id: string,
          params: unknown,
        ) => Promise<{ content: [{ text: string }] }>
      )('id', params);
      return JSON.parse(result.content[0].text);
    };
    const started = await execute({
      operation: 'compose',
      projectId: 'project',
      prompt: 'Improve help',
    });
    expect(started.ok).toBe(true);
    expect(smith.proposals.list()).toEqual([]);
    const planId = started.result.planId;
    await vi.waitFor(() => expect(store.get(planId)?.status).toBe('ready'));
    expect(project.absorbArtifact).toHaveBeenCalledTimes(1);
    expect(global.absorbArtifact).toHaveBeenCalledTimes(1);
    expect(global.absorbArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'run_plan', planId, revision: 1, status: 'ready' }),
    );
    expect(screenContextBlock({ route: 'smith', plan: { planId, revision: 1 } })).toContain(
      'smith_compose revise',
    );
    expect((await execute({ operation: 'revise', planId, note: 'Split the checks' })).ok).toBe(
      true,
    );
    await vi.waitFor(() => expect(store.get(planId)?.revision).toBe(2));
    expect(store.get(planId)?.plan?.refinedRequest).toBe('Split the checks into a separate phase.');
    expect(store.get(planId)?.messages[0]).toMatchObject({
      role: 'operator',
      text: 'Split the checks',
    });
    expect(project.absorbArtifact).toHaveBeenCalledTimes(2);
    expect(global.absorbArtifact).toHaveBeenCalledTimes(2);
    expect(oneShots.calls).toHaveLength(2);
    for (const call of oneShots.calls)
      expect(call).toMatchObject({ access: 'read', cwd: '/fixture' });
    const acceptance = execute({ operation: 'accept', planId });
    expect(smith.proposals.list()).toHaveLength(1);
    expect(h.startRun).not.toHaveBeenCalled();
    await smith.proposals.answer(smith.proposals.list()[0]!.id, { approved: true });
    expect((await acceptance).ok).toBe(true);
    expect(h.startRun).toHaveBeenCalledTimes(1);
    expect(store.get(planId)?.acceptedRunId).toBe('run-accepted');
    expect(createChat).toHaveBeenCalledTimes(2);
    expect(project.absorbArtifact).toHaveBeenCalledTimes(3);
    expect(global.absorbArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'run_plan', status: 'accepted' }),
    );
  });
});
