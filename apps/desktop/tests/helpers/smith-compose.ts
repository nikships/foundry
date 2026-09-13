import { vi } from 'vitest';
import { tempDir } from './tmp.js';
import { runPlanFixture } from './run-plan.js';
import { scriptedOneShots } from './scripted-oneshot.js';
import { openDb, projectDbPath, projectRunsDir } from '../../src/main/trace/db.js';
import { Tracer } from '../../src/main/trace/tracer.js';
import { ProposalStore } from '../../src/main/smith/compose/proposals.js';
import { ProposalQueue } from '../../src/main/smith/proposals.js';
import { smithComposeTool } from '../../src/main/smith/compose-tools.js';
import { defaultSettings } from '../../src/main/store/settings.js';
import type { AppContext } from '../../src/main/context.js';
import type { ComposeStart } from '../../src/main/smith/compose/session.js';
import type { GeneratedRunPlan } from '../../src/shared/types.js';
import type { OrchestratorState } from '../../src/shared/ipc-contract.js';

/** Real durable store/approval queue; controllable live turn for tool boundary tests. */
export function composeHarness(scope: string | undefined = 'project', bypass = false) {
  const supportDir = tempDir('smith-compose-');
  const db = openDb(projectDbPath(supportDir, '/fixture'));
  const tracer = new Tracer(db, projectRunsDir(supportDir, '/fixture'));
  const starts: ComposeStart[] = [];
  const plans = {
    start: vi.fn((input: ComposeStart) => {
      starts.push(input);
      return `plan-${starts.length}`;
    }),
    get: () => null,
    cancel: vi.fn(() => true),
    cancelAll: () => {},
    message: vi.fn((_id: string, _note: string): string | null => null),
  };
  const startRun = vi.fn(async (_plan: GeneratedRunPlan) => ({
    ok: true as const,
    runId: 'run-accepted',
  }));
  const proposals = new ProposalStore({
    plans,
    tracerFor: () => tracer,
    projectIds: () => ['project', 'other'],
    broadcast: () => {},
    now: () => 1000,
    startRun,
  });
  const queue = new ProposalQueue(
    () => {},
    async () => ({ ok: true, entity: {} }),
    undefined,
    () => bypass,
  );
  const settings = {
    ...defaultSettings(),
    smithModel: 'fixture/smith',
    smithReasoningEffort: 'low' as const,
  };
  const projects = [
    { id: 'project', path: '/fixture', commands: [] },
    { id: 'other', path: '/other', commands: [] },
  ];
  const ctx = {
    supportDir,
    proposals,
    plans,
    settings: { get: () => settings },
    projects: {
      get: (id: string) => projects.find((p) => p.id === id),
      list: () => projects,
      save: vi.fn(() => ({ ok: true })),
    },
    rosterFor: () => [],
    envelopes: { list: () => [] },
    oneShot: scriptedOneShots([]).factory,
    broadcast: vi.fn(),
  } as unknown as AppContext;
  const toolFor = (projectId: string | undefined) =>
    smithComposeTool({ ctx, queue, projectId: () => projectId });
  const tool = toolFor(scope);
  const execute = async (params: unknown) => {
    const result = await (
      tool.execute as unknown as (
        id: string,
        params: unknown,
      ) => Promise<{ content: [{ text: string }] }>
    )('id', params);
    return JSON.parse(result.content[0].text);
  };
  const ready = (planId = 'plan-1', projectId = 'project') => {
    const fixture = runPlanFixture(projectId);
    const plan = { ...fixture.plan!, planId };
    const state: OrchestratorState = {
      planId,
      projectId,
      status: 'done',
      plan,
      prompt: fixture.prompt,
      model: fixture.model,
      reasoningEffort: 'low',
      entries: [],
      rawReply: fixture.rawReply,
      detail: '',
      startedAt: 1000,
      messages: [],
      revision: 1,
    };
    proposals.onProgress(state);
    return state;
  };
  return {
    ctx,
    plans,
    proposals,
    queue,
    tool,
    toolFor,
    execute,
    starts,
    startRun,
    settings,
    ready,
    db,
    tracer,
  };
}
