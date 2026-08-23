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
import type {
  AgentDef,
  ChangeReceiptDef,
  CheckpointDef,
  ChecklistDef,
  EnvelopeDef,
  PipelineDef,
  ProviderStatusDef,
  ReadinessJourneyDef,
  SmithArtifact,
} from '../../../src/shared/types.js';
import { SMITH_ARTIFACT_VERSION } from '../../../src/shared/types.js';
import type { SmithEntityStores } from '../../../src/main/smith/entity-tools.js';
import {
  MAX_ARTIFACT_JSON,
  findProviderSecretField,
  findSecretKey,
  smithPresentTool,
  validateChangeReceipt,
  validateChecklist,
  validateCheckpoint,
  validateProviderStatus,
  validateReadinessJourney,
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

const validChecklist: ChecklistDef = {
  title: 'Doctor Report',
  summary: '1 failed · 1 warning · 1 passed',
  items: [
    {
      id: 'git',
      label: 'Git binary available',
      status: 'pass',
      detail: 'git 2.44.0 found in PATH',
    },
    {
      id: 'model',
      label: 'Selected model reachable',
      status: 'warn',
      detail: 'Provider responded with high latency',
      evidence: 'GET /v1/models took 2100ms (threshold: 1500ms)',
      fix: 'Check network connectivity or switch to local model',
    },
    {
      id: 'worktree',
      label: 'Clean working tree',
      status: 'fail',
      detail: 'Uncommitted changes detected in repository',
      evidence: 'M src/shared/types.ts\n?? new-file.ts',
      fix: 'Commit or stash changes before initiating a pipeline run',
    },
  ],
};

const validReceipt: ChangeReceiptDef = {
  title: 'Direct checkout changes',
  target: 'direct_checkout',
  status: 'success',
  summary: 'Modified 2 files and passed tests',
  filesChanged: ['src/shared/types.ts', 'src/main/smith/present-tools.ts'],
  diffstat: '2 files changed, 20 insertions(+), 5 deletions(-)',
  command: {
    command: 'npm test',
    exitCode: 0,
    passed: true,
    durationMs: 1420,
  },
  outputExcerpt: 'Tests: 1540 passed, 1540 total',
};

const validCheckpoint: CheckpointDef = {
  interruptId: 'int_7',
  title: 'Drop the legacy column?',
  question: 'The migration drops `users.legacy_id`. Proceed?',
  runId: 'run_9f2c1a',
  phaseId: 'review',
  pipelineId: 'ship-it',
  raisedAt: '2026-08-23T10:00:00Z',
  draftAnswer: 'Yes — nothing reads that column.',
  actions: [
    { id: 'approve', label: 'Approve', kind: 'approve' },
    { id: 'reject', label: 'Reject', kind: 'reject' },
    { id: 'edit', label: 'Edit answer', kind: 'edit' },
  ],
};

const validJourney: ReadinessJourneyDef = {
  projectId: 'proj_1',
  projectName: 'foundry',
  phase: 'needs_continue',
  detail: 'Two criteria still fail after remediation.',
  marker: {
    valid: false,
    detail: 'No .agents/agent-ready.json on origin/main.',
    source: 'base-ref',
    ref: 'origin/main',
  },
  criteria: [
    { id: 'lint_format', status: 'pass' },
    { id: 'typecheck', status: 'fail', notes: 'tsc reports 3 errors' },
    { id: 'coverage', status: 'n/a', notes: 'no coverage tooling' },
  ],
  stack: { languages: ['typescript'], monorepo: true, packages: ['apps/desktop'] },
  checklistSummary: '1 failing · 1 passing · 1 n/a',
  work: [
    { id: 'w1', kind: 'text', text: 'Reading tsconfig.json' },
    { id: 'w2', kind: 'tool', text: 'npm run typecheck', toolKind: 'command', failed: true },
  ],
  pr: { number: 42, url: 'https://github.com/nikships/foundry/pull/42', merged: false },
  actions: ['Continue', 'Start over'],
};

const validProviderStatus: ProviderStatusDef = {
  title: 'Providers',
  summary: '1 of 2 providers connected',
  providers: [
    {
      id: 'anthropic',
      label: 'Anthropic',
      connection: 'connected',
      authenticated: true,
      keyPresent: false,
      accounts: [{ label: 'nik@example.com', expired: false, disabled: false }],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      connection: 'error',
      authenticated: false,
      keyPresent: true,
      error: 'refresh failed',
    },
  ],
  bridge: { running: true, port: 52810, baseUrl: 'http://127.0.0.1:52810' },
  companion: {
    running: true,
    origin: 'http://192.168.1.20:52811',
    protocolVersion: 2,
    devices: [
      { deviceId: 'dev_1', name: 'Pixel 9', pairedAt: '2026-08-01T00:00:00Z', lastSeenAt: null },
    ],
  },
};

function makeStores(
  agents: AgentDef[] = [validAgent],
  pipelines: PipelineDef[] = [validPipeline],
  envelopes: EnvelopeDef[] = [validEnvelope],
): SmithEntityStores {
  return {
    roster: { get: (name: string) => agents.find((a) => a.name === name) ?? null },
    pipelines: { get: (id: string) => pipelines.find((p) => p.id === id) ?? null },
    envelopes: {
      list: () => envelopes,
      get: (name: string) => envelopes.find((e) => e.name === name) ?? null,
    },
    projects: { list: () => [] },
    rosterScope: () => ({}),
    pipelineScope: () => ({}),
    rosterFor: () => agents,
    pipelinesFor: () => pipelines,
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

  it('emits agent, envelope, checklist, entity_comparison, and change_receipt artifacts through the same registry', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    expect(await answerOf(tool, { kind: 'agent_design', spec: validAgent })).toMatchObject({
      ok: true,
    });
    expect(await answerOf(tool, { kind: 'envelope_design', spec: validEnvelope })).toMatchObject({
      ok: true,
    });
    expect(await answerOf(tool, { kind: 'checklist', spec: validChecklist })).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, {
        kind: 'entity_comparison',
        entityKind: 'agent',
        spec: { ...validAgent, purpose: 'Plan faster.' },
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, {
        kind: 'change_receipt',
        spec: validReceipt,
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, { kind: 'engineer_checkpoint', spec: validCheckpoint }),
    ).toMatchObject({ ok: true });
    expect(await answerOf(tool, { kind: 'readiness_journey', spec: validJourney })).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, { kind: 'provider_status', spec: validProviderStatus }),
    ).toMatchObject({ ok: true });
    expect(emitted.map((artifact) => artifact.kind)).toEqual([
      'agent_design',
      'envelope_design',
      'checklist',
      'entity_comparison',
      'change_receipt',
      'engineer_checkpoint',
      'readiness_journey',
      'provider_status',
    ]);
  });

  it('emits an engineer_checkpoint artifact carrying no executor and no approval', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'engineer_checkpoint',
      spec: validCheckpoint,
      rationale: 'The column is unreferenced.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'engineer_checkpoint',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'The column is unreferenced.',
      warnings: [],
    });
    if (artifact.kind !== 'engineer_checkpoint') throw new Error('expected checkpoint artifact');
    expect(artifact.checkpoint).toEqual(validCheckpoint);
    // Presentation only: nothing on the artifact can answer the interrupt.
    expect(Object.keys(artifact)).not.toContain('execute');
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('emits a readiness_journey artifact with marker, criteria, work, and PR', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'readiness_journey',
      spec: validJourney,
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    if (artifact.kind !== 'readiness_journey') throw new Error('expected journey artifact');
    expect(artifact.journey).toEqual(validJourney);
    expect(artifact.journey.marker.valid).toBe(false);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('emits a provider_status artifact with key-present metadata and paired devices', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'provider_status',
      spec: validProviderStatus,
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    if (artifact.kind !== 'provider_status') throw new Error('expected provider artifact');
    expect(artifact.status).toEqual(validProviderStatus);
    // `keyPresent` is the only credential-adjacent field allowed through.
    const serialized = JSON.stringify(artifact);
    expect(serialized).toContain('keyPresent');
    expect(serialized).not.toMatch(/"(apiKey|api_key|token|secret)"/);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('refuses a provider_status spec carrying a key, masked prefix, or pairing payload', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);

    // `findSecretKey` catches the bare credential names first.
    const withKey = (await answerOf(tool, {
      kind: 'provider_status',
      spec: {
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            connection: 'connected',
            authenticated: true,
            api_key: 'sk-live-123',
          },
        ],
      },
    })) as { ok: boolean; error?: string };
    expect(withKey.ok).toBe(false);
    expect(withKey.error).toMatch(/credential/);
    expect(JSON.stringify(withKey)).not.toContain('sk-live-123');

    // A masked prefix is refused by name, not by looking like a key.
    const withMask = (await answerOf(tool, {
      kind: 'provider_status',
      spec: {
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            connection: 'connected',
            authenticated: true,
            maskedKeyPrefix: 'sk-live-…',
          },
        ],
      },
    })) as { ok: boolean; error?: string; validation?: { where: string }[] };
    expect(withMask.ok).toBe(false);
    expect(JSON.stringify(withMask)).not.toContain('sk-live-…');

    // The renderer-only QR/pairing payload may never enter an artifact.
    const withPairing = (await answerOf(tool, {
      kind: 'provider_status',
      spec: {
        companion: {
          running: true,
          pairingPayload: { origin: 'http://192.168.1.20:52811', expiresAt: 'soon' },
        },
      },
    })) as { ok: boolean; error?: string; validation?: { where: string }[] };
    expect(withPairing.ok).toBe(false);

    expect(emitted).toHaveLength(0);
  });

  it('refuses invalid checkpoint, journey, and provider specs', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);

    const noQuestion = (await answerOf(tool, {
      kind: 'engineer_checkpoint',
      spec: { ...validCheckpoint, question: '' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(noQuestion.ok).toBe(false);
    expect(noQuestion.validation).toContainEqual(
      expect.objectContaining({ where: 'question', level: 'error' }),
    );

    const badPhase = (await answerOf(tool, {
      kind: 'readiness_journey',
      spec: { ...validJourney, phase: 'almost_ready' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(badPhase.ok).toBe(false);
    expect(badPhase.validation).toContainEqual(
      expect.objectContaining({ where: 'phase', level: 'error' }),
    );

    const badConnection = (await answerOf(tool, {
      kind: 'provider_status',
      spec: {
        providers: [{ id: 'x', label: 'X', connection: 'flaky', authenticated: true }],
      },
    })) as { ok: boolean; validation?: unknown[] };
    expect(badConnection.ok).toBe(false);
    expect(badConnection.validation).toContainEqual(
      expect.objectContaining({ where: 'providers[0].connection', level: 'error' }),
    );

    expect(emitted).toHaveLength(0);
  });

  it('emits a versioned change_receipt artifact and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'change_receipt',
      spec: validReceipt,
      rationale: 'Ran tests after edit.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'change_receipt',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Ran tests after edit.',
      warnings: [],
    });
    if (artifact.kind !== 'change_receipt') throw new Error('expected change receipt artifact');
    expect(artifact.receipt).toEqual(validReceipt);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('refuses invalid change_receipt specs', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);

    // Invalid target
    const res1 = (await answerOf(tool, {
      kind: 'change_receipt',
      spec: { ...validReceipt, target: 'invalid_target' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res1.ok).toBe(false);
    expect(res1.validation).toContainEqual(
      expect.objectContaining({ where: 'target', level: 'error' }),
    );

    // Invalid status
    const res2 = (await answerOf(tool, {
      kind: 'change_receipt',
      spec: { ...validReceipt, status: 'pending' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res2.ok).toBe(false);
    expect(res2.validation).toContainEqual(
      expect.objectContaining({ where: 'status', level: 'error' }),
    );

    // Invalid command
    const res3 = (await answerOf(tool, {
      kind: 'change_receipt',
      spec: { ...validReceipt, command: { command: '', exitCode: 'zero', passed: 'yes' } },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res3.ok).toBe(false);
    expect(res3.validation?.length).toBeGreaterThan(0);

    expect(emitted).toHaveLength(0);
  });

  it('emits a versioned entity_comparison artifact with before fetched from the store and after validated', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const editedAgent = { ...validAgent, purpose: 'Plan faster.', writes: ['docs/**'] };

    const res = (await answerOf(tool, {
      kind: 'entity_comparison',
      entityKind: 'agent',
      name: 'planner',
      spec: editedAgent,
      rationale: 'Allow docs updates.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'entity_comparison',
      entityKind: 'agent',
      name: 'planner',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Allow docs updates.',
      warnings: [],
    });
    if (artifact.kind !== 'entity_comparison') throw new Error('expected comparison artifact');
    expect(artifact.before).toEqual(validAgent);
    expect(artifact.after).toEqual(editedAgent);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('refuses entity_comparison if the entity does not exist in the store', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'entity_comparison',
      entityKind: 'agent',
      spec: { ...validAgent, name: 'nonexistent_agent' },
    })) as { ok: boolean; error: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/does not exist in the store/);
    expect(emitted).toHaveLength(0);
  });

  it('refuses entity_comparison if after spec fails validation', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'entity_comparison',
      entityKind: 'agent',
      spec: { ...validAgent, color: 'not_a_valid_hex' },
    })) as { ok: boolean; validation?: unknown[] };

    expect(res.ok).toBe(false);
    expect(res.validation?.length).toBeTruthy();
    expect(emitted).toHaveLength(0);
  });

  it('emits a versioned checklist artifact with items and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const res = (await answerOf(smithPresentTool(deps), {
      kind: 'checklist',
      spec: validChecklist,
      rationale: 'Pre-flight check before run.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'checklist',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Pre-flight check before run.',
      warnings: [],
    });
    if (artifact.kind !== 'checklist') throw new Error('expected checklist artifact');
    expect(artifact.checklist).toEqual(validChecklist);
    expect(() => structuredClone(artifact)).not.toThrow();
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

  it('refuses invalid checklist specs', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);

    // Missing title
    const res1 = (await answerOf(tool, {
      kind: 'checklist',
      spec: { ...validChecklist, title: '' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res1.ok).toBe(false);
    expect(res1.validation).toContainEqual(
      expect.objectContaining({ where: 'title', level: 'error' }),
    );

    // Empty items
    const res2 = (await answerOf(tool, {
      kind: 'checklist',
      spec: { title: 'Check', items: [] },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res2.ok).toBe(false);
    expect(res2.validation).toContainEqual(
      expect.objectContaining({ where: 'items', level: 'error' }),
    );

    // Invalid item status
    const res3 = (await answerOf(tool, {
      kind: 'checklist',
      spec: {
        title: 'Check',
        items: [{ label: 'Item 1', status: 'unknown_status' }],
      },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res3.ok).toBe(false);
    expect(res3.validation).toContainEqual(
      expect.objectContaining({ where: 'items[0].status', level: 'error' }),
    );

    // Missing item label
    const res4 = (await answerOf(tool, {
      kind: 'checklist',
      spec: {
        title: 'Check',
        items: [{ label: '', status: 'pass' }],
      },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res4.ok).toBe(false);
    expect(res4.validation).toContainEqual(
      expect.objectContaining({ where: 'items[0].label', level: 'error' }),
    );

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
    expect(await answerOf(tool, { kind: 'run_summary', spec: {} })).toEqual({
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

describe('validateCheckpoint', () => {
  it('accepts a valid checkpoint without errors', () => {
    expect(validateCheckpoint(validCheckpoint)).toEqual([]);
  });

  it('requires the identity a checkpoint card cannot be drawn without', () => {
    const issues = validateCheckpoint({});
    for (const where of ['interruptId', 'title', 'question']) {
      expect(issues).toContainEqual(expect.objectContaining({ level: 'error', where }));
    }
  });

  it('flags a non-object spec and a bad action kind', () => {
    expect(validateCheckpoint(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(
      validateCheckpoint({
        ...validCheckpoint,
        actions: [{ id: 'x', label: 'Maybe', kind: 'defer' }],
      }),
    ).toContainEqual(expect.objectContaining({ level: 'error', where: 'actions[0].kind' }));
  });

  it('accepts only approve or reject as a recorded decision', () => {
    expect(validateCheckpoint({ ...validCheckpoint, decision: 'approve' })).toEqual([]);
    expect(validateCheckpoint({ ...validCheckpoint, decision: 'defer' })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'decision' }),
    );
  });

  it('warns rather than fails on an over-long question or draft answer', () => {
    const issues = validateCheckpoint({
      ...validCheckpoint,
      question: 'q'.repeat(5_000),
      draftAnswer: 'a'.repeat(9_000),
    });
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'question' }));
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'warning', where: 'draftAnswer' }),
    );
  });
});

describe('validateReadinessJourney', () => {
  it('accepts a valid journey without errors', () => {
    expect(validateReadinessJourney(validJourney)).toEqual([]);
  });

  it('requires the authoritative marker and a criteria array', () => {
    const issues = validateReadinessJourney({ phase: 'complete' });
    expect(issues).toContainEqual(expect.objectContaining({ level: 'error', where: 'marker' }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'error', where: 'criteria' }));
  });

  it('requires marker validity to be stated explicitly, not inferred', () => {
    expect(
      validateReadinessJourney({
        ...validJourney,
        marker: { detail: 'unknown' },
      }),
    ).toContainEqual(expect.objectContaining({ level: 'error', where: 'marker.valid' }));
  });

  it('rejects an unknown criterion status, work kind, or marker source', () => {
    expect(
      validateReadinessJourney({
        ...validJourney,
        criteria: [{ id: 'typecheck', status: 'maybe' }],
      }),
    ).toContainEqual(expect.objectContaining({ level: 'error', where: 'criteria[0].status' }));
    expect(
      validateReadinessJourney({
        ...validJourney,
        work: [{ id: 'w1', kind: 'diagram', text: 'x' }],
      }),
    ).toContainEqual(expect.objectContaining({ level: 'error', where: 'work[0].kind' }));
    expect(
      validateReadinessJourney({
        ...validJourney,
        marker: { ...validJourney.marker, source: 'cache' },
      }),
    ).toContainEqual(expect.objectContaining({ level: 'error', where: 'marker.source' }));
  });

  it('caps the criteria and work arrays rather than persisting an unbounded card', () => {
    const criteria = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, status: 'pass' }));
    expect(validateReadinessJourney({ ...validJourney, criteria })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'criteria' }),
    );
    const work = Array.from({ length: 400 }, (_, i) => ({ id: `w${i}`, kind: 'text', text: 'x' }));
    expect(validateReadinessJourney({ ...validJourney, work })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'work' }),
    );
  });

  it('requires a PR to name its number, url, and merge state together', () => {
    const issues = validateReadinessJourney({ ...validJourney, pr: { number: 42 } });
    expect(issues).toContainEqual(expect.objectContaining({ level: 'error', where: 'pr.url' }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'error', where: 'pr.merged' }));
  });
});

describe('validateProviderStatus', () => {
  it('accepts a valid provider status without errors', () => {
    expect(validateProviderStatus(validProviderStatus)).toEqual([]);
  });

  it('requires each provider to state connection and auth', () => {
    const issues = validateProviderStatus({ providers: [{ id: 'x', label: 'X' }] });
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'providers[0].connection' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'providers[0].authenticated' }),
    );
  });

  it('refuses every credential-shaped field except keyPresent', () => {
    expect(validateProviderStatus({ providers: [], apiKey: 'sk-1' })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'apiKey' }),
    );
    expect(
      validateProviderStatus({
        providers: [
          {
            id: 'x',
            label: 'X',
            connection: 'connected',
            authenticated: true,
            maskedKeyPrefix: 'sk-…',
          },
        ],
      }),
    ).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'providers[0].maskedKeyPrefix' }),
    );
    // The renderer-only pairing payload, by any name that reads like one.
    expect(
      validateProviderStatus({ companion: { running: true, pairingSecret: 'abc' } }),
    ).toContainEqual(expect.objectContaining({ level: 'error', where: 'companion.pairingSecret' }));
    expect(validateProviderStatus({ companion: { running: true, qrPayload: {} } })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'companion.qrPayload' }),
    );
    // And `keyPresent` still passes: the card needs it to offer replace/clear.
    expect(
      validateProviderStatus({
        providers: [
          { id: 'x', label: 'X', connection: 'connected', authenticated: true, keyPresent: true },
        ],
      }),
    ).toEqual([]);
  });

  it('names the forbidden field without echoing its value', () => {
    const issues = validateProviderStatus({ providers: [], token: 'ghp_secretvalue' });
    expect(JSON.stringify(issues)).not.toContain('ghp_secretvalue');
    expect(issues).toContainEqual(expect.objectContaining({ where: 'token' }));
  });

  it('validates the Companion device list as metadata only', () => {
    const issues = validateProviderStatus({
      companion: { running: true, devices: [{ name: 'Pixel' }] },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'companion.devices[0].deviceId' }),
    );
  });
});

describe('findProviderSecretField', () => {
  it('finds forbidden fields at any depth and allows keyPresent', () => {
    expect(findProviderSecretField({ providers: [{ apiKey: 'x' }] })).toBe('providers[0].apiKey');
    expect(findProviderSecretField({ companion: { pairing: {} } })).toBe('companion.pairing');
    expect(findProviderSecretField({ a: { qr: 'data' } })).toBe('a.qr');
    expect(findProviderSecretField({ providers: [{ keyPresent: true }] })).toBeNull();
    expect(findProviderSecretField({ bridge: { running: true, port: 1 } })).toBeNull();
  });
});

describe('validateChecklist', () => {
  it('accepts a valid checklist without errors', () => {
    expect(validateChecklist(validChecklist)).toEqual([]);
  });

  it('flags non-object specs', () => {
    expect(validateChecklist(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validateChecklist('invalid')).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
  });

  it('flags warnings for oversized fields without failing validation', () => {
    const oversized = {
      title: 'T'.repeat(250),
      summary: 'S'.repeat(600),
      items: [
        {
          label: 'L'.repeat(250),
          status: 'pass',
          detail: 'D'.repeat(600),
          evidence: 'E'.repeat(4500),
          fix: 'F'.repeat(600),
        },
      ],
    };
    const issues = validateChecklist(oversized);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'title' }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'summary' }));
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'warning', where: 'items[0].label' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'warning', where: 'items[0].detail' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'warning', where: 'items[0].evidence' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'warning', where: 'items[0].fix' }),
    );
  });
});

describe('validateChangeReceipt', () => {
  it('accepts a valid change receipt without errors', () => {
    expect(validateChangeReceipt(validReceipt)).toEqual([]);
  });

  it('flags non-object specs', () => {
    expect(validateChangeReceipt(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validateChangeReceipt('invalid')).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
  });

  it('flags warnings for oversized fields without failing validation', () => {
    const oversized: ChangeReceiptDef = {
      title: 'T'.repeat(250),
      summary: 'S'.repeat(600),
      target: 'direct_checkout',
      status: 'success',
      diffstat: 'D'.repeat(4500),
      outputExcerpt: 'O'.repeat(4500),
    };
    const issues = validateChangeReceipt(oversized);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'title' }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'summary' }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'diffstat' }));
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'warning', where: 'outputExcerpt' }),
    );
  });
});
