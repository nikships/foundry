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
  ChecklistDef,
  EnvelopeDef,
  PipelineDef,
  PrCardDef,
  ProjectCardDef,
  SmithArtifact,
} from '../../../src/shared/types.js';
import { SMITH_ARTIFACT_VERSION } from '../../../src/shared/types.js';
import type { SmithEntityStores } from '../../../src/main/smith/entity-tools.js';
import {
  MAX_ARTIFACT_JSON,
  derivePrCard,
  deriveProjectCard,
  findSecretKey,
  smithPresentTool,
  validateChangeReceipt,
  validateChecklist,
  validatePrCard,
  validateProjectCard,
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

const validProjectCard: ProjectCardDef = {
  id: 'proj_1',
  name: 'Foundry',
  path: '/Users/nik/foundry',
  baseRef: 'main',
  title: 'Foundry project card',
  summary: 'main · 3 commands · Healthy',
  isGit: true,
  github: {
    available: true,
    repo: 'nikships/foundry',
  },
  commands: [{ name: 'test', argv: ['npm', 'test'] }],
  setupScript: 'npm ci',
  readinessValidated: true,
  divergence: {
    ahead: 0,
    behind: 0,
    state: 'current',
  },
  scopes: {
    roster: false,
    pipelines: false,
  },
  health: {
    ok: true,
    summary: 'All checks passing',
    failedCount: 0,
    totalCount: 5,
  },
};

const validPrCard: PrCardDef = {
  number: 188,
  title: '[smith] add change/command receipt artifact (FOU-160)',
  url: 'https://github.com/nikships/foundry/pull/188',
  headRefName: 'fou-160-change-receipt',
  baseRefName: 'main',
  body: 'Implements the change_receipt artifact.',
  author: 'nikships',
  isDraft: false,
  checks: 'passing',
  mergeable: 'mergeable',
  reviewDecision: 'APPROVED',
  additions: 450,
  deletions: 12,
  action: {
    operation: 'create',
    status: 'success',
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

  it('emits agent, envelope, checklist, entity_comparison, change_receipt, project_card, and pr_card artifacts through the same registry', async () => {
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
      await answerOf(tool, {
        kind: 'project_card',
        spec: validProjectCard,
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, {
        kind: 'pr_card',
        spec: validPrCard,
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(emitted.map((artifact) => artifact.kind)).toEqual([
      'agent_design',
      'envelope_design',
      'checklist',
      'entity_comparison',
      'change_receipt',
      'project_card',
      'pr_card',
    ]);
  });

  it('emits a versioned project_card artifact and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'project_card',
      spec: validProjectCard,
      rationale: 'Project health and base divergence overview.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'project_card',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Project health and base divergence overview.',
      warnings: [],
    });
    if (artifact.kind !== 'project_card') throw new Error('expected project_card artifact');
    expect(artifact.project).toEqual(validProjectCard);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('refuses invalid project_card specs', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);

    // Missing path
    const res1 = (await answerOf(tool, {
      kind: 'project_card',
      spec: { ...validProjectCard, path: '' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res1.ok).toBe(false);
    expect(res1.validation).toContainEqual(
      expect.objectContaining({ where: 'path', level: 'error' }),
    );

    // Missing baseRef
    const res2 = (await answerOf(tool, {
      kind: 'project_card',
      spec: { ...validProjectCard, baseRef: '' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res2.ok).toBe(false);
    expect(res2.validation).toContainEqual(
      expect.objectContaining({ where: 'baseRef', level: 'error' }),
    );

    // Invalid divergence state
    const res3 = (await answerOf(tool, {
      kind: 'project_card',
      spec: { ...validProjectCard, divergence: { ahead: 0, behind: 0, state: 'invalid' } },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res3.ok).toBe(false);
    expect(res3.validation).toContainEqual(
      expect.objectContaining({ where: 'divergence.state', level: 'error' }),
    );

    expect(emitted).toHaveLength(0);
  });

  it('emits a versioned pr_card artifact and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'pr_card',
      spec: validPrCard,
      rationale: 'PR preview with checks and merge status.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'pr_card',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'PR preview with checks and merge status.',
      warnings: [],
    });
    if (artifact.kind !== 'pr_card') throw new Error('expected pr_card artifact');
    expect(artifact.pr).toEqual(validPrCard);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('refuses invalid pr_card specs', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);

    // Invalid number
    const res1 = (await answerOf(tool, {
      kind: 'pr_card',
      spec: { ...validPrCard, number: 0 },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res1.ok).toBe(false);
    expect(res1.validation).toContainEqual(
      expect.objectContaining({ where: 'number', level: 'error' }),
    );

    // Missing url
    const res2 = (await answerOf(tool, {
      kind: 'pr_card',
      spec: { ...validPrCard, url: '' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res2.ok).toBe(false);
    expect(res2.validation).toContainEqual(
      expect.objectContaining({ where: 'url', level: 'error' }),
    );

    // Invalid checks
    const res3 = (await answerOf(tool, {
      kind: 'pr_card',
      spec: { ...validPrCard, checks: 'unknown_check' },
    })) as { ok: boolean; validation?: unknown[] };
    expect(res3.ok).toBe(false);
    expect(res3.validation).toContainEqual(
      expect.objectContaining({ where: 'checks', level: 'error' }),
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

describe('validateProjectCard', () => {
  it('accepts a valid project card without errors', () => {
    expect(validateProjectCard(validProjectCard)).toEqual([]);
  });

  it('flags non-object specs', () => {
    expect(validateProjectCard(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validateProjectCard('invalid')).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
  });

  it('flags warnings for oversized fields without failing validation', () => {
    const oversized: ProjectCardDef = {
      path: '/Users/nik/foundry',
      baseRef: 'main',
      title: 'T'.repeat(250),
      summary: 'S'.repeat(600),
      setupScript: 'X'.repeat(8500),
      contextSummary: 'C'.repeat(4500),
    };
    const issues = validateProjectCard(oversized);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'title' }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'summary' }));
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'warning', where: 'setupScript' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'warning', where: 'contextSummary' }),
    );
  });
});

describe('validatePrCard', () => {
  it('accepts a valid PR card without errors', () => {
    expect(validatePrCard(validPrCard)).toEqual([]);
  });

  it('flags non-object specs', () => {
    expect(validatePrCard(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validatePrCard('invalid')).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
  });

  it('flags warnings for oversized fields without failing validation', () => {
    const oversized: PrCardDef = {
      number: 1,
      title: 'T'.repeat(250),
      url: 'https://github.com/nikships/foundry/pull/1',
      headRefName: 'branch-1',
      body: 'B'.repeat(8500),
    };
    const issues = validatePrCard(oversized);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'title' }));
    expect(issues).toContainEqual(expect.objectContaining({ level: 'warning', where: 'body' }));
  });
});

describe('deriveProjectCard', () => {
  it('constructs a project card definition from typed project and doctor inputs', () => {
    const project = {
      id: 'p1',
      name: 'Repo',
      path: '/path/repo',
      baseRef: 'main',
      isolation: true,
      mergePolicy: 'ask' as const,
      commands: [{ name: 'test', argv: ['npm', 'test'] }],
      protectedPaths: [],
      ownRoster: false,
      ownPipelines: false,
      addedAt: '2026-08-23',
    };
    const card = deriveProjectCard({
      project,
      github: { available: true, repo: 'owner/repo', detail: 'connected' },
      divergence: {
        projectId: 'p1',
        baseRef: 'main',
        remote: 'origin',
        localSha: 'abc',
        remoteSha: 'abc',
        ahead: 0,
        behind: 0,
        state: 'current',
        fetched: true,
        detail: 'up to date',
      },
      scopes: { roster: false, pipelines: false },
      doctorChecks: [
        { id: 'path', label: 'Project folder', ok: true, detail: '/path/repo' },
        { id: 'repo', label: 'Git repository', ok: true, detail: 'git' },
      ],
    });

    expect(card.path).toBe('/path/repo');
    expect(card.baseRef).toBe('main');
    expect(card.github?.repo).toBe('owner/repo');
    expect(card.divergence?.state).toBe('current');
    expect(card.health?.ok).toBe(true);
    expect(card.health?.totalCount).toBe(2);
  });
});

describe('derivePrCard', () => {
  it('constructs a PR card definition from PullRequest object', () => {
    const pr = {
      number: 42,
      title: 'Fix boundary',
      url: 'https://github.com/nikships/foundry/pull/42',
      author: 'nik',
      headRefName: 'fix-boundary',
      baseRefName: 'main',
      createdAt: '2026-08-23',
      additions: 10,
      deletions: 2,
      isDraft: false,
      checks: 'passing' as const,
      mergeable: 'mergeable' as const,
      reviewDecision: 'APPROVED',
    };
    const card = derivePrCard({
      pr,
      body: 'Summary of fixes',
      action: { operation: 'create', status: 'success' },
    });

    expect(card.number).toBe(42);
    expect(card.title).toBe('Fix boundary');
    expect(card.headRefName).toBe('fix-boundary');
    expect(card.checks).toBe('passing');
    expect(card.body).toBe('Summary of fixes');
    expect(card.action?.status).toBe('success');
  });
});
