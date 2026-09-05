import type { RunDetail } from '../../src/shared/ipc-contract.js';
import type { EventRow, GeneratedRunPlan, PhaseDef, RunRow } from '../../src/shared/types.js';

export interface WorkshopFixture {
  detail: RunDetail;
  events: EventRow[];
  plan: GeneratedRunPlan;
}

/** Read-boundary fixture only: no engine, models, commands, network, or production state. */
export function workshopFixture(projectId: string, runId: string, active = 1): WorkshopFixture {
  const names = ['architect', 'builder', 'test suite', 'reviewer', 'polish', 'package'];
  const models = [
    'anthropic/claude-sonnet-4',
    'openai/gpt-5',
    null,
    'google/gemini-2.5-pro',
    'xai/grok-4',
    null,
  ];
  const start = new Date(Date.now() - 160_000).toISOString();
  const run: RunRow = {
    runId,
    projectId,
    pipelineId: 'fixture-workshop',
    pipelineName: 'Full SDLC',
    request: 'Build a beautiful little corner of the internet.',
    status: 'running',
    engineer: 'fixture',
    worktreePath: null,
    branch: null,
    baseRef: 'main',
    branchPointSha: null,
    outcomeDetail: null,
    prNumber: null,
    prUrl: null,
    issueNumber: null,
    issueUrl: null,
    source: null,
    sourceSyncError: null,
    merged: false,
    archived: false,
    mode: 'pi',
    orchestrated: true,
    amendments: 0,
    startedAt: start,
    endedAt: null,
    totalTokens: 18240,
  };
  const phases = names.map((name, index) => ({
    phaseId: `workshop-phase-${index}`,
    runId,
    seq: index,
    name,
    kind: models[index] ? ('agent' as const) : ('code' as const),
    owner: name,
    description: `The ${name} phase`,
    status:
      index < active
        ? ('success' as const)
        : index === active
          ? ('running' as const)
          : ('queued' as const),
    attempt: 1,
    error: null,
    startedAt: index <= active ? new Date(Date.parse(start) + index * 20_000).toISOString() : null,
    endedAt:
      index < active ? new Date(Date.parse(start) + (index + 1) * 20_000).toISOString() : null,
  }));
  const events: EventRow[] = [
    {
      rowid: 1,
      changeId: 1,
      eventId: 'workshop-brief',
      runId,
      phaseId: phases[0]!.phaseId,
      parentId: null,
      type: 'assistant_text',
      name: 'assistant',
      payload: { text: 'ARCHITECT_ONLY: The design is ready for the builder.' },
      tokens: 0,
      startedAt: start,
      endedAt: start,
    },
    {
      rowid: 2,
      changeId: 2,
      eventId: `workshop-model-${active}`,
      runId,
      phaseId: phases[active]!.phaseId,
      parentId: null,
      type: 'agent_start',
      name: names[active]!,
      payload: { model: models[active] },
      tokens: 0,
      startedAt: start,
      endedAt: start,
    },
    {
      rowid: 3,
      changeId: 3,
      eventId: `workshop-thinking-${active}`,
      runId,
      phaseId: phases[active]!.phaseId,
      parentId: null,
      type: 'thinking',
      name: 'thinking',
      payload: {
        text: 'I’m putting the final pieces together. A little care in the details makes all the difference.',
      },
      tokens: 0,
      startedAt: start,
      endedAt: start,
    },
    {
      rowid: 4,
      changeId: 4,
      eventId: `workshop-read-${active}`,
      runId,
      phaseId: phases[active]!.phaseId,
      parentId: null,
      type: 'tool_call',
      name: models[active] ? 'read: src/components/Home.tsx' : 'npm test',
      payload: models[active]
        ? {
            kind: 'read',
            args: { path: 'src/components/Home.tsx' },
            result: 'export function Home() { return <main>Hello, world.</main>; }',
          }
        : { kind: 'command', argv: ['npm', 'test'], result: 'Running 24 tests…' },
      tokens: 0,
      startedAt: start,
      endedAt: null,
    },
  ];
  const pipeline = {
    id: run.pipelineId,
    name: run.pipelineName,
    description: 'Workshop interaction fixture.',
    acceptance: { kind: 'all_phases_pass' as const },
    phases: names.map((name, index): PhaseDef =>
      models[index]
        ? {
            name,
            kind: 'agent',
            agent: name,
            model: models[index]!,
            description: name,
            envelope: 'generic',
          }
        : { name, kind: 'code', command: { argv: ['true'] }, description: name },
    ),
  };
  return {
    detail: {
      run,
      phases,
      gates: [],
      envelopes: [],
      live: true,
      sessions: models.flatMap((model, index) =>
        model
          ? [
              {
                runId,
                agent: names[index]!,
                model,
                reasoningEffort: 'high',
                agentSessionId: null,
                mode: 'pi' as const,
                color: '#8fbdaa',
                contextTokens: 41391,
                contextWindow: 200000,
                createdAt: start,
                lastUsedAt: start,
              },
            ]
          : [],
      ),
    },
    events,
    plan: {
      planId: 'workshop-plan',
      projectId,
      prompt: run.request,
      refinedRequest: run.request,
      rationale: 'Isolated visual fixture',
      pipeline,
      agents: [],
      warnings: [],
      model: 'fixture/model',
      reasoningEffort: 'high',
    },
  };
}
