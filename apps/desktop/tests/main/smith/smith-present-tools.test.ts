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
  ChangeReceiptDef,
  ChecklistDef,
  DataTableDef,
  DiagnosticsDef,
  EnvelopeDef,
  EvidenceDisclosureDef,
  PipelineDef,
  PrCardDef,
  ProjectCardDef,
  ProjectDef,
  ProviderStatusDef,
  ReadinessJourneyDef,
  SettingsDiffDef,
  SmithArtifact,
} from '../../../src/shared/types.js';
import { SMITH_ARTIFACT_VERSION } from '../../../src/shared/types.js';
import type { SmithEntityStores } from '../../../src/main/smith/entity-tools.js';
import {
  MAX_ARTIFACT_JSON,
  derivePrCard,
  deriveProjectCard,
  findProviderSecretField,
  findSecretKey,
  smithPresentTool,
  validateChangeReceipt,
  validateChecklist,
  validateDataTable,
  validateDiagnostics,
  validateEvidenceDisclosure,
  validatePrCard,
  validateProjectCard,
  validateProviderStatus,
  validateReadinessJourney,
  validateSettingsDiff,
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
    source: null,
    sourceSyncError: null,
    merged: false,
    archived: false,
    mode: 'pi',
    orchestrated: false,
    amendments: 0,
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

const validSettingsDiff: SettingsDiffDef = {
  title: 'Updated Settings',
  summary: '2 settings modified',
  scope: 'global',
  sections: [
    {
      section: 'models',
      label: 'Models & Providers',
      changes: [
        {
          key: 'smithModel',
          label: 'Smith Model',
          previous: 'inherit',
          next: 'anthropic/claude-3-7-sonnet',
        },
      ],
    },
  ],
};

const validDiagnostics: DiagnosticsDef = {
  title: 'System Diagnostics',
  summary: '1 doctor check passed, 1 orphan found',
  category: 'general',
  doctor: [{ id: 'git', label: 'Git available', ok: true, detail: 'git 2.44' }],
  orphans: [{ path: '/tmp/worktree', branch: 'foundry/123', runId: '123', projectId: 'p1' }],
  maintenance: { runsDeleted: 3, bytesReclaimed: 1048576, worktreesRemoved: 2 },
  update: { stage: 'available', version: '0.2.0', message: 'New version ready' },
  lifecycleWarning: 'Relaunch required to apply updates.',
};

const validDataTable: DataTableDef = {
  title: 'Project Runs',
  catalogKind: 'runs',
  summary: 'Recent 2 runs',
  columns: [
    { key: 'id', label: 'Run ID', type: 'code' },
    { key: 'status', label: 'Status', type: 'status' },
    { key: 'duration', label: 'Duration', type: 'text' },
  ],
  rows: [
    {
      id: 'run-1',
      cells: {
        id: 'run-1',
        status: { variant: 'pass', label: 'Passed' },
        duration: '1m 20s',
      },
    },
    {
      id: 'run-2',
      cells: {
        id: 'run-2',
        status: { variant: 'fail', label: 'Failed' },
        duration: '45s',
      },
    },
  ],
};

const validEvidence: EvidenceDisclosureDef = {
  title: 'Phase Execution Context',
  summary: 'Context and excerpts for phase review',
  runId: 'run-1',
  phaseName: 'review',
  occupancy: {
    usedTokens: 15400,
    maxTokens: 128000,
    percent: 12.0,
    model: 'anthropic/claude-3-7-sonnet',
  },
  phasePrompt: {
    systemPrompt: 'Review the diff.',
    userPrompt: 'Review changes in {{request}}',
  },
  items: [
    {
      label: 'Linter output',
      kind: 'command_output',
      content: 'All files passed lint checks.',
      exitCode: 0,
      durationMs: 450,
    },
    {
      label: 'Git Diff Excerpt',
      kind: 'diff',
      content: '--- a/src/index.ts\n+++ b/src/index.ts',
    },
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
    projects: { list: () => [mockProject] },
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

  it('emits agent, envelope, checklist, entity_comparison, change_receipt, project_card, and pr_card artifacts through the same registry', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    expect(await answerOf(tool, { kind: 'agent_design', spec: validAgent })).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, {
        kind: 'envelope_design',
        spec: validEnvelope,
        usage: { agents: ['planner'], pipelines: ['ship-it'] },
        sampleOutput: { status: 'passed', summary: 'ok' },
      }),
    ).toMatchObject({
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
    expect(
      await answerOf(tool, {
        kind: 'settings_diff',
        spec: validSettingsDiff,
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, {
        kind: 'diagnostics',
        spec: validDiagnostics,
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, {
        kind: 'data_table',
        spec: validDataTable,
      }),
    ).toMatchObject({
      ok: true,
    });
    expect(
      await answerOf(tool, {
        kind: 'evidence_disclosure',
        spec: validEvidence,
      }),
    ).toMatchObject({
      ok: true,
    });
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
      'project_card',
      'pr_card',
      'settings_diff',
      'diagnostics',
      'data_table',
      'evidence_disclosure',
      'readiness_journey',
      'provider_status',
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

  it('emits a versioned settings_diff artifact and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'settings_diff',
      spec: validSettingsDiff,
      rationale: 'Updated model choices.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'settings_diff',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Updated model choices.',
      warnings: [],
    });
    if (artifact.kind !== 'settings_diff') throw new Error('expected settings diff artifact');
    expect(artifact.diff).toEqual(validSettingsDiff);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('emits a versioned diagnostics artifact and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'diagnostics',
      spec: validDiagnostics,
      rationale: 'Diagnostics pre-check.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'diagnostics',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Diagnostics pre-check.',
      warnings: [],
    });
    if (artifact.kind !== 'diagnostics') throw new Error('expected diagnostics artifact');
    expect(artifact.diagnostics).toEqual(validDiagnostics);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('emits a versioned data_table artifact and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'data_table',
      spec: validDataTable,
      rationale: 'Recent runs catalog.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'data_table',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Recent runs catalog.',
      warnings: [],
    });
    if (artifact.kind !== 'data_table') throw new Error('expected data table artifact');
    expect(artifact.table).toEqual(validDataTable);
    expect(() => structuredClone(artifact)).not.toThrow();
  });

  it('emits a versioned evidence_disclosure artifact and acknowledges with its id', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    const res = (await answerOf(tool, {
      kind: 'evidence_disclosure',
      spec: validEvidence,
      rationale: 'Review phase context.',
    })) as { ok: boolean; artifactId: string };

    expect(res.ok).toBe(true);
    expect(emitted).toHaveLength(1);
    const artifact = emitted[0]!;
    expect(res.artifactId).toBe(artifact.id);
    expect(artifact).toMatchObject({
      kind: 'evidence_disclosure',
      version: SMITH_ARTIFACT_VERSION,
      rationale: 'Review phase context.',
      warnings: [],
    });
    if (artifact.kind !== 'evidence_disclosure') throw new Error('expected evidence artifact');
    expect(artifact.evidence).toEqual(validEvidence);
    expect(() => structuredClone(artifact)).not.toThrow();
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

  it('refuses invalid journey and provider specs', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);

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

  it('refuses to present an action receipt — receipts are main-minted evidence', async () => {
    const { deps, emitted } = makeDeps();
    const tool = smithPresentTool(deps);
    expect(await answerOf(tool, { kind: 'action_receipt', spec: { operation: 'merge' } })).toEqual({
      ok: false,
      error: 'unknown artifact kind',
    });
    expect(emitted).toHaveLength(0);
    // The receipt kind is also absent from the tool's own enum, so the model
    // is never told it is an option.
    const params = tool.parameters as { properties: { kind: { enum: string[] } } };
    expect(params.properties.kind.enum).not.toContain('action_receipt');
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

describe('validateSettingsDiff', () => {
  it('accepts a valid settings diff without errors', () => {
    expect(validateSettingsDiff(validSettingsDiff)).toEqual([]);
  });

  it('flags non-object specs and missing sections', () => {
    expect(validateSettingsDiff(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validateSettingsDiff({ title: 'Diff', sections: [] })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'sections' }),
    );
  });

  it('flags missing section identifier or change key/label', () => {
    const issues = validateSettingsDiff({
      sections: [{ section: '', changes: [{ key: '', label: '' }] }],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'sections[0].section' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'sections[0].changes[0].key' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'sections[0].changes[0].label' }),
    );
  });
});

describe('validateDiagnostics', () => {
  it('accepts a valid diagnostics definition without errors', () => {
    expect(validateDiagnostics(validDiagnostics)).toEqual([]);
  });

  it('flags non-object specs and empty diagnostics without content', () => {
    expect(validateDiagnostics(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validateDiagnostics({})).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validateDiagnostics({ lifecycleWarning: null })).toContainEqual(
      expect.objectContaining({
        level: 'error',
        where: 'lifecycleWarning',
        message: 'lifecycleWarning must be a string',
      }),
    );
  });

  it('flags invalid doctor check or orphan worktree shape', () => {
    const issues = validateDiagnostics({
      doctor: [{ id: '', label: '', ok: 'not-bool' }],
      orphans: [{ path: '', branch: '', projectId: 123 }],
    });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'doctor[0].id' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'doctor[0].ok' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'orphans[0].path' }),
    );
  });
});

describe('validateDataTable', () => {
  it('accepts a valid data table without errors', () => {
    expect(validateDataTable(validDataTable)).toEqual([]);
  });

  it('flags missing title or empty columns', () => {
    expect(validateDataTable(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validateDataTable({ title: '', columns: [] })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'title' }),
    );
    expect(validateDataTable({ title: 'Table', columns: [] })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'columns' }),
    );
  });

  it('flags invalid column keys and labels', () => {
    const issues = validateDataTable({
      title: 'Table',
      columns: [{ key: '', label: '' }],
      rows: [],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'columns[0].key' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'columns[0].label' }),
    );
  });
});

describe('validateEvidenceDisclosure', () => {
  it('accepts a valid evidence disclosure without errors', () => {
    expect(validateEvidenceDisclosure(validEvidence)).toEqual([]);
  });

  it('flags missing title or empty disclosure content', () => {
    expect(validateEvidenceDisclosure(null)).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'spec' }),
    );
    expect(validateEvidenceDisclosure({ title: '', items: [] })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'title' }),
    );
    expect(validateEvidenceDisclosure({ title: 'Context', items: [] })).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'items' }),
    );
  });

  it('flags invalid evidence item kinds or missing labels', () => {
    const issues = validateEvidenceDisclosure({
      title: 'Context',
      items: [{ label: '', kind: 'unknown_kind', content: 123 }],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'items[0].label' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'items[0].kind' }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ level: 'error', where: 'items[0].content' }),
    );
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
