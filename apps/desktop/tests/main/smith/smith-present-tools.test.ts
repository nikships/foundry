/**
 * `smith_present`, called the way the runtime calls it.
 *
 * The load-bearing rules: validation runs BEFORE any card (errors come back
 * as data with nothing emitted, warnings ride onto the artifact), the payload
 * is size-capped and refused when it carries a credential-shaped field, and a
 * presented artifact never touches the proposal queue — it emits straight
 * into the transcript and acknowledges immediately.
 */

import { describe, expect, it } from 'vitest';
import type { RunDetail } from '../../../src/shared/ipc-contract.js';
import type {
  AgentDef,
  EnvelopeDef,
  PipelineDef,
  ProjectDef,
  SmithArtifact,
} from '../../../src/shared/types.js';
import { SMITH_ARTIFACT_VERSION } from '../../../src/shared/types.js';
import type { SmithEntityStores } from '../../../src/main/smith/entity-tools.js';
import {
  MAX_ARTIFACT_JSON,
  findSecretKey,
  smithPresentTool,
  type SmithPresentToolDeps,
} from '../../../src/main/smith/present-tools.js';

const validAgent: AgentDef = {
  name: 'planner',
  purpose: 'Plan the work.',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 'You plan.',
  userPrompt: 'Work on: {{request}}',
  writes: [],
  envelope: 'plan',
  color: '#5ad2dd',
};

const validPipeline: PipelineDef = {
  id: 'ship-it',
  name: 'Ship it',
  description: 'A one-phase pipeline for tool tests.',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    {
      name: 'plan',
      kind: 'agent',
      description: 'Plan the work.',
      agent: 'planner',
      prompt: { inputs: ['request'] },
    },
  ],
};

const validEnvelope: EnvelopeDef = {
  name: 'severity_report',
  description: 'A severity-tagged report',
  fields: [{ name: 'severity', type: 'string', required: true }],
};

const mockProject: ProjectDef = {
  id: 'proj_1',
  name: 'Test Project',
  path: '/tmp/test-project',
  baseRef: 'main',
  isolation: true,
  mergePolicy: 'auto',
  commands: [],
  protectedPaths: [],
  ownRoster: false,
  ownPipelines: false,
  addedAt: '2026-08-23T00:00:00.000Z',
};

const mockRunDetail: RunDetail = {
  run: {
    runId: 'run_abc123',
    projectId: 'proj_1',
    pipelineId: 'ship-it',
    pipelineName: 'Ship it',
    request: 'Refactor the smith tools',
    status: 'accepted',
    engineer: 'Nik',
    worktreePath: '/tmp/.foundry-worktrees/run_abc123',
    branch: 'foundry/run_abc123',
    baseRef: 'main',
    branchPointSha: 'sha123',
    outcomeDetail: 'All 2 phases passed acceptance gates',
    prNumber: 42,
    prUrl: 'https://github.com/nikships/foundry/pull/42',
    issueNumber: null,
    issueUrl: null,
    merged: false,
    archived: false,
    mode: 'pi',
    startedAt: '2026-08-23T10:00:00.000Z',
    endedAt: '2026-08-23T10:02:30.000Z',
    totalTokens: 15400,
  },
  phases: [
    {
      phaseId: 'ph_1',
      runId: 'run_abc123',
      seq: 0,
      name: 'plan',
      kind: 'agent',
      owner: 'planner',
      description: 'Plan the change',
      status: 'success',
      attempt: 1,
      error: null,
      startedAt: '2026-08-23T10:00:00.000Z',
      endedAt: '2026-08-23T10:01:00.000Z',
    },
    {
      phaseId: 'ph_2',
      runId: 'run_abc123',
      seq: 1,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'Implement the plan',
      status: 'success',
      attempt: 1,
      error: null,
      startedAt: '2026-08-23T10:01:00.000Z',
      endedAt: '2026-08-23T10:02:30.000Z',
    },
  ],
  envelopes: [
    {
      envelopeId: 'env_1',
      runId: 'run_abc123',
      phaseId: 'ph_1',
      agent: 'planner',
      schemaKind: 'plan',
      payload: { summary: 'Plan created successfully' },
      valid: true,
      attempt: 1,
      createdAt: '2026-08-23T10:01:00.000Z',
    },
  ],
  gates: [],
  sessions: [],
  live: false,
};

function makeStores(agents: AgentDef[] = [validAgent]): SmithEntityStores {
  return {
    roster: { get: (name: string) => agents.find((a) => a.name === name) ?? null },
    pipelines: { get: () => null },
    envelopes: { list: () => [], get: () => null },
    projects: { list: () => [mockProject] },
    rosterScope: () => ({}),
    pipelineScope: () => ({}),
    rosterFor: () => agents,
    pipelinesFor: () => [],
    commandNames: () => [],
  } as unknown as SmithEntityStores;
}

function makeDeps(over: Partial<SmithPresentToolDeps> = {}): {
  deps: SmithPresentToolDeps;
  emitted: SmithArtifact[];
} {
  const emitted: SmithArtifact[] = [];
  const deps: SmithPresentToolDeps = {
    stores: makeStores(),
    projectId: () => undefined,
    emit: (artifact) => emitted.push(artifact),
    runLookup: (_projectId: string, runId: string) => {
      if (runId === 'run_abc123') return mockRunDetail;
      return null;
    },
    ...over,
  };
  return { deps, emitted };
}

function call(
  tool: { execute: (...args: never[]) => unknown },
  params: unknown,
): Promise<{ content: { type: string; text: string }[] }> {
  const execute = tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: { type: string; text: string }[] }>;
  return execute('call-1', params);
}

async function answerOf(tool: Parameters<typeof call>[0], params: unknown): Promise<unknown> {
  const result = await call(tool, params);
  return JSON.parse(result.content.map((block) => block.text).join(''));
}

describe('smith_present', () => {
  it('emits a versioned pipeline artifact and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'pipeline_design',
      spec: validPipeline,
      rationale: 'Single phase keeps the loop tight.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'pipeline_design',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Single phase keeps the loop tight.',
      warnings: [],
    });
    if (artifact.kind !== 'pipeline_design') throw new Error('expected pipeline artifact');
    expect(artifact.pipeline).toEqual(validPipeline);
    // Clone-safe and detached from the caller's object.
    expect(() => structuredClone(artifact)).not.toThrow();
    expect(artifact.pipeline).not.toBe(validPipeline);
  });

  it('emits agent and envelope artifacts through the same registry', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    expect(await answerOf(tool, { kind: 'agent_design', spec: validAgent })).toMatchObject({
      ok: true,
    });
    expect(await answerOf(tool, { kind: 'envelope_design', spec: validEnvelope })).toMatchObject({
      ok: true,
    });
    expect(emitted.map((artifact) => artifact.kind)).toEqual(['agent_design', 'envelope_design']);
  });

  it('emits a run_summary artifact derived authoritatively from trace', async () => {
    const { deps, emitted } = makeDeps({ projectId: () => 'proj_1' });
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'run_summary',
      runId: 'run_abc123',
      rationale: 'Run completed cleanly with all phases green.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'run_summary',
      version: SMITH_ARTIFACT_VERSION,
      runId: 'run_abc123',
      pipelineId: 'ship-it',
      pipelineName: 'Ship it',
      request: 'Refactor the smith tools',
      status: 'accepted',
      outcomeDetail: 'All 2 phases passed acceptance gates',
      prNumber: 42,
      prUrl: 'https://github.com/nikships/foundry/pull/42',
      rationale: 'Run completed cleanly with all phases green.',
      isolation: true,
      live: false,
    });
    if (artifact.kind !== 'run_summary') throw new Error('expected run_summary artifact');
    expect(artifact.phases).toHaveLength(2);
    expect(artifact.phases[0]).toMatchObject({
      name: 'plan',
      kind: 'agent',
      status: 'success',
      owner: 'planner',
      envelopeSummary: 'Plan created successfully',
    });
    expect(artifact.durationMs).toBe(150_000);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('derives run_summary from trace, ignoring forged spec properties', async () => {
    const { deps, emitted } = makeDeps({ projectId: () => 'proj_1' });
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'run_summary',
      runId: 'run_abc123',
      spec: {
        status: 'failed',
        pipelineName: 'Forged Pipeline',
        request: 'Forged request from model',
      },
    })) as { ok: boolean };

    expect(res.ok).toBe(true);
    const artifact = emitted[0]!;
    if (artifact.kind !== 'run_summary') throw new Error('expected run_summary artifact');
    expect(artifact.status).toBe('accepted');
    expect(artifact.pipelineName).toBe('Ship it');
    expect(artifact.request).toBe('Refactor the smith tools');
  });

  it('refuses run_summary when runId is missing or not found', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    expect(await answerOf(tool, { kind: 'run_summary' })).toEqual({
      ok: false,
      error: 'run_summary needs a runId',
    });
    expect(await answerOf(tool, { kind: 'run_summary', runId: 'run_missing' })).toEqual({
      ok: false,
      error: 'run not found: run_missing',
    });
    expect(emitted).toHaveLength(0);
  });

  it('discovers run across projects when in global scope', async () => {
    const { deps, emitted } = makeDeps({ projectId: () => undefined });
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'run_summary',
      runId: 'run_abc123',
    })) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.projectId).toBe('proj_1');
  });

  it('refuses validation errors as data, emitting nothing', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'agent_design',
      spec: { ...validAgent, name: 'Bad Name', color: 'red' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res.ok).toBe(false);
    expect(res.validation?.length).toBeTruthy();
    expect(emitted).toHaveLength(0);
  });

  it('lets warnings ride onto the artifact instead of blocking it', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'agent_design',
      spec: { ...validAgent, envelope: 'not_in_the_library' },
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(emitted[0]!.warnings).toEqual([
      expect.objectContaining({ level: 'warning', where: 'envelope' }),
    ]);
  });

  it('refuses an unknown kind and a missing spec', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    expect(await answerOf(tool, { kind: 'unknown_kind', spec: {} })).toEqual({
      ok: false,
      error: 'unknown artifact kind',
    });
    expect(await answerOf(tool, { kind: 'agent_design' })).toEqual({
      ok: false,
      error: 'present needs a spec object',
    });
    expect(emitted).toHaveLength(0);
  });

  it('caps the payload size rather than persisting an oversized card', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'agent_design',
      spec: { ...validAgent, systemPrompt: 'x'.repeat(MAX_ARTIFACT_JSON) },
    })) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too large/);
    expect(emitted).toHaveLength(0);
  });

  it('refuses a spec smuggling a credential-shaped field, at any depth', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'agent_design',
      spec: { ...validAgent, customFields: [{ nested: { api_key: 'sk-123' } }] },
    })) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/credential/);
    expect(res.error).not.toContain('sk-123');
    expect(emitted).toHaveLength(0);
  });

  it('stamps the conversation scope onto the artifact', async () => {
    const { deps, emitted } = makeDeps({ projectId: () => 'proj_9' });
    await answerOf(smithPresentTool(deps), { kind: 'agent_design', spec: validAgent });
    expect(emitted[0]!.projectId).toBe('proj_9');
  });
});

describe('findSecretKey', () => {
  it('finds credential-shaped keys and names the path, never the value', () => {
    expect(findSecretKey({ apiKey: 'x' })).toBe('apiKey');
    expect(findSecretKey({ a: { token: 'x' } })).toBe('a.token');
    expect(findSecretKey({ a: [{ password: 'x' }] })).toBe('a[0].password');
    expect(findSecretKey({ name: 'fine', writes: null })).toBeNull();
  });
});
