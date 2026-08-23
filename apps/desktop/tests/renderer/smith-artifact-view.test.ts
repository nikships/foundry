/**
 * The artifact registry's pure half: which kinds/versions this build renders,
 * the display labels the design bodies draw, and the semantic before/after an
 * edit proposal shows. All DOM-free on purpose — the rules live here so the
 * components stay thin.
 */

import { describe, expect, it } from 'vitest';
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
  SettingsDiffDef,
  SmithArtifact,
} from '@shared/types.js';
import { SMITH_ARTIFACT_VERSION } from '@shared/types.js';
import {
  ARTIFACT_KIND_LABEL,
  acceptanceLabel,
  artifactName,
  changeReceiptStatusLabel,
  changeReceiptSummary,
  changeReceiptTargetLabel,
  checklistStatusGlyph,
  checklistStatusLabel,
  checklistSummary,
  commandLabel,
  compareEntities,
  dataTableSummary,
  diagnosticsSummary,
  evidenceSummary,
  formatBytes,
  formatCellValue,
  formatSettingValue,
  gateLabel,
  groupChecklistItems,
  isRenderableArtifact,
  occupancyStatus,
  phaseWorkLabel,
  prChecksGlyph,
  prChecksLabel,
  prMergeableLabel,
  prSummary,
  projectCardDivergenceLabel,
  projectCardHealthLabel,
  projectCardScopesLabel,
  projectCardSummary,
  settingsDiffSummary,
  writesLabel,
} from '@renderer/view-models/smith-artifact-view.js';

const agent: AgentDef = {
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

const pipeline: PipelineDef = {
  id: 'ship-it',
  name: 'Ship it',
  description: 'Ships.',
  acceptance: { kind: 'all_phases_pass' },
  phases: [
    { name: 'plan', kind: 'agent', description: 'Plan.', agent: 'planner' },
    { name: 'test', kind: 'code', description: 'Test.', command: { ref: 'test' } },
  ],
};

const envelope: EnvelopeDef = {
  name: 'severity_report',
  fields: [{ name: 'severity', type: 'string', required: true }],
};

const checklist: ChecklistDef = {
  title: 'Project Health',
  summary: '1 failed · 1 warning · 2 passed',
  items: [
    { label: 'Git repo', status: 'pass' },
    { label: 'Linting', status: 'pass' },
    { label: 'Tests passing', status: 'warn', detail: '1 test skipped' },
    { label: 'Build clean', status: 'fail', detail: 'Type error in main.ts' },
    { label: 'Environment', status: 'info', detail: 'Node 22.0.0' },
  ],
};

const receipt: ChangeReceiptDef = {
  title: 'Checkout changes applied',
  target: 'direct_checkout',
  status: 'success',
  summary: 'Modified 2 files',
  filesChanged: ['src/a.ts', 'src/b.ts'],
  command: {
    command: 'npm test',
    passed: true,
    exitCode: 0,
    durationMs: 500,
  },
};

const project: ProjectCardDef = {
  name: 'Foundry',
  path: '/Users/nik/foundry',
  baseRef: 'main',
  commands: [{ name: 'test', argv: ['npm', 'test'] }],
  divergence: { ahead: 0, behind: 0, state: 'current' },
  scopes: { roster: false, pipelines: false },
  health: { ok: true, summary: 'All checks passing' },
};

const pr: PrCardDef = {
  number: 188,
  title: 'Add change receipt',
  url: 'https://github.com/nikships/foundry/pull/188',
  headRefName: 'fou-160',
  baseRefName: 'main',
  checks: 'passing',
  mergeable: 'mergeable',
};

const diff: SettingsDiffDef = {
  title: 'Model settings updated',
  summary: '2 changes in Models',
  scope: 'global',
  sections: [
    {
      section: 'models',
      label: 'Models & Providers',
      changes: [
        {
          key: 'smithModel',
          label: 'Smith Default Model',
          previous: 'inherit',
          next: 'anthropic/claude-3-7-sonnet',
        },
      ],
    },
  ],
};

const diagnostics: DiagnosticsDef = {
  title: 'System Diagnostics',
  summary: 'All doctor checks passed',
  category: 'doctor',
  doctor: [{ id: 'git', label: 'Git binary', ok: true, detail: 'git 2.44.0 found' }],
};

const table: DataTableDef = {
  title: 'Active Runs',
  catalogKind: 'runs',
  columns: [
    { key: 'id', label: 'Run ID' },
    { key: 'status', label: 'Status', type: 'status' },
  ],
  rows: [
    {
      id: 'run_1',
      cells: { id: 'run_1', status: { variant: 'pass', label: 'Succeeded' } },
    },
  ],
};

const evidence: EvidenceDisclosureDef = {
  title: 'Phase Execution Context',
  phaseName: 'build',
  occupancy: { usedTokens: 12000, maxTokens: 128000, percent: 9.4 },
  items: [
    {
      label: 'Build Output',
      kind: 'command_output',
      content: 'Build succeeded in 1.2s',
      exitCode: 0,
      durationMs: 1200,
    },
  ],
};

function artifactOf(kind: SmithArtifact['kind'], version = SMITH_ARTIFACT_VERSION): SmithArtifact {
  const base = { id: 'a1', version, createdAt: 0, warnings: [] };
  if (kind === 'pipeline_design') return { ...base, kind, pipeline };
  if (kind === 'agent_design') return { ...base, kind, agent };
  if (kind === 'envelope_design') return { ...base, kind, envelope };
  if (kind === 'checklist') return { ...base, kind, checklist };
  if (kind === 'change_receipt') return { ...base, kind, receipt };
  if (kind === 'project_card') return { ...base, kind, project };
  if (kind === 'pr_card') return { ...base, kind, pr };
  if (kind === 'settings_diff') return { ...base, kind, diff };
  if (kind === 'diagnostics') return { ...base, kind, diagnostics };
  if (kind === 'data_table') return { ...base, kind, table };
  if (kind === 'evidence_disclosure') return { ...base, kind, evidence };
  return {
    ...base,
    kind: 'entity_comparison',
    entityKind: 'agent',
    name: 'planner',
    before: agent,
    after: { ...agent, purpose: 'Plan faster.' },
  };
}

describe('the artifact registry', () => {
  it('renders every registered kind at the current version', () => {
    for (const kind of Object.keys(ARTIFACT_KIND_LABEL) as SmithArtifact['kind'][]) {
      expect(isRenderableArtifact(artifactOf(kind))).toBe(true);
    }
  });

  it('fails soft on a future version or an unknown kind', () => {
    expect(isRenderableArtifact(artifactOf('pipeline_design', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('checklist', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('entity_comparison', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('change_receipt', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('project_card', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('pr_card', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('settings_diff', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('diagnostics', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('data_table', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('evidence_disclosure', 99))).toBe(false);
    expect(isRenderableArtifact({ kind: 'run_summary' } as unknown as SmithArtifact)).toBe(false);
  });

  it('names each artifact by its identifying field', () => {
    expect(artifactName(artifactOf('pipeline_design'))).toBe('ship-it');
    expect(artifactName(artifactOf('agent_design'))).toBe('planner');
    expect(artifactName(artifactOf('envelope_design'))).toBe('severity_report');
    expect(artifactName(artifactOf('checklist'))).toBe('Project Health');
    expect(artifactName(artifactOf('entity_comparison'))).toBe('planner');
    expect(artifactName(artifactOf('change_receipt'))).toBe('Checkout changes applied');
    expect(artifactName(artifactOf('project_card'))).toBe('Foundry');
    expect(artifactName(artifactOf('pr_card'))).toBe('#188 Add change receipt');
    expect(artifactName(artifactOf('settings_diff'))).toBe('Model settings updated');
    expect(artifactName(artifactOf('diagnostics'))).toBe('System Diagnostics');
    expect(artifactName(artifactOf('data_table'))).toBe('Active Runs');
    expect(artifactName(artifactOf('evidence_disclosure'))).toBe('Phase Execution Context');
  });
});

describe('change receipt helpers', () => {
  it('formats target and status labels in domain language', () => {
    expect(changeReceiptTargetLabel('direct_checkout')).toBe('Direct checkout');
    expect(changeReceiptTargetLabel('isolated_worktree')).toBe('Isolated worktree');

    expect(changeReceiptStatusLabel('success')).toBe('Success');
    expect(changeReceiptStatusLabel('failure')).toBe('Failed');
  });

  it('uses summary or derives from details when summary is omitted', () => {
    expect(changeReceiptSummary(receipt)).toBe('Modified 2 files');
    expect(changeReceiptSummary({ ...receipt, summary: undefined })).toBe(
      '2 files changed · `npm test` (exit 0 in 500ms)',
    );
  });

  it('derives summary from files and command when title/summary are missing', () => {
    expect(
      changeReceiptSummary({
        target: 'direct_checkout',
        status: 'success',
        filesChanged: ['src/a.ts', 'src/b.ts'],
        command: { command: 'npm test', passed: true, exitCode: 0 },
      }),
    ).toBe('2 files changed · `npm test` (exit 0)');

    expect(
      changeReceiptSummary({
        target: 'isolated_worktree',
        status: 'failure',
      }),
    ).toBe('Operation failed');
  });
});

describe('settings diff helpers', () => {
  it('formats custom summary or derives from sections', () => {
    expect(settingsDiffSummary(diff)).toBe('2 changes in Models');
    expect(settingsDiffSummary({ ...diff, summary: undefined })).toBe('1 change across 1 section');
  });

  it('formats setting values into readable strings', () => {
    expect(formatSettingValue(undefined)).toBe('—');
    expect(formatSettingValue(null)).toBe('—');
    expect(formatSettingValue(true)).toBe('Enabled');
    expect(formatSettingValue(false)).toBe('Disabled');
    expect(formatSettingValue('hello')).toBe('hello');
    expect(formatSettingValue({ key: 'val' })).toBe('{"key":"val"}');
  });
});

describe('diagnostics helpers', () => {
  it('formats bytes cleanly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('formats diagnostics summary with doctor and orphan counts', () => {
    expect(diagnosticsSummary(diagnostics)).toBe('All doctor checks passed');
    expect(
      diagnosticsSummary({
        doctor: [
          { id: '1', label: 'Check 1', ok: true, detail: '' },
          { id: '2', label: 'Check 2', ok: false, detail: '' },
        ],
        orphans: [{ path: '/tmp/wt', branch: 'foundry/1', runId: '1', projectId: 'p1' }],
      }),
    ).toBe('1 doctor check failed · 1 orphan worktree');
  });
});

describe('data table helpers', () => {
  it('derives table summary from items', () => {
    expect(dataTableSummary(table)).toBe('runs · 1 item');
    expect(dataTableSummary({ ...table, summary: 'Custom Summary' })).toBe('Custom Summary');
  });

  it('formats cell values and status objects', () => {
    expect(formatCellValue(undefined)).toEqual({ text: '—' });
    expect(formatCellValue(true)).toEqual({ text: 'Yes' });
    expect(formatCellValue(false)).toEqual({ text: 'No' });
    expect(formatCellValue('text')).toEqual({ text: 'text' });
    expect(formatCellValue({ variant: 'pass', label: 'Active' })).toEqual({
      text: 'Active',
      status: { variant: 'pass', label: 'Active' },
    });
  });
});

describe('evidence disclosure helpers', () => {
  it('formats evidence summary from occupancy and items', () => {
    expect(evidenceSummary(evidence)).toBe('9% context · Phase: build · 1 item');
  });

  it('evaluates occupancy status based on compaction threshold', () => {
    expect(occupancyStatus(50)).toBe('ok');
    expect(occupancyStatus(82)).toBe('warn');
    expect(occupancyStatus(95)).toBe('critical');
  });
});

describe('checklist helpers', () => {
  it('groups items by pass/warn/fail/info status', () => {
    const groups = groupChecklistItems(checklist.items);
    expect(groups.fail).toHaveLength(1);
    expect(groups.fail[0]!.label).toBe('Build clean');
    expect(groups.warn).toHaveLength(1);
    expect(groups.warn[0]!.label).toBe('Tests passing');
    expect(groups.pass).toHaveLength(2);
    expect(groups.info).toHaveLength(1);
    expect(groups.info[0]!.label).toBe('Environment');
  });

  it('formats custom summary if provided', () => {
    expect(checklistSummary(checklist)).toBe('1 failed · 1 warning · 2 passed');
  });

  it('derives summary line from item counts when omitted', () => {
    const withoutSummary: ChecklistDef = {
      title: 'Doctor',
      items: [
        { label: 'Check 1', status: 'pass' },
        { label: 'Check 2', status: 'pass' },
        { label: 'Check 3', status: 'warn' },
        { label: 'Check 4', status: 'fail' },
      ],
    };
    expect(checklistSummary(withoutSummary)).toBe('1 failed · 1 warning · 2 passed');
  });

  it('formats status labels and glyphs', () => {
    expect(checklistStatusLabel('pass')).toBe('Passed');
    expect(checklistStatusLabel('warn')).toBe('Warning');
    expect(checklistStatusLabel('fail')).toBe('Failed');
    expect(checklistStatusLabel('info')).toBe('Info');

    expect(checklistStatusGlyph('pass')).toBe('✓');
    expect(checklistStatusGlyph('warn')).toBe('⚠');
    expect(checklistStatusGlyph('fail')).toBe('✕');
    expect(checklistStatusGlyph('info')).toBe('ℹ');
  });
});

describe('display labels', () => {
  it('says acceptance in domain language', () => {
    expect(acceptanceLabel({ kind: 'all_phases_pass' })).toMatch(/every phase/);
    expect(acceptanceLabel({ kind: 'last_phase_pass' })).toMatch(/last phase/);
    expect(acceptanceLabel({ kind: 'phase_flag', phase: 'review', flag: 'approved' })).toContain(
      'review',
    );
    expect(acceptanceLabel({ kind: 'envelope_status', phase: 'build' })).toContain('build');
  });

  it('labels every command shape', () => {
    expect(commandLabel({ ref: 'test' })).toBe('test');
    expect(commandLabel({ builtin: 'git_commit' })).toBe('git_commit');
    expect(commandLabel({ argv: ['npm', 'test'] })).toBe('npm test');
    expect(commandLabel(undefined)).toBe('');
  });

  it('labels gates, boundaries, and phase work', () => {
    expect(gateLabel('lint_passes')).toBe('lint_passes');
    expect(gateLabel({ gate: 'command_passes', config: {} })).toBe('command_passes');
    expect(writesLabel(null)).toMatch(/unrestricted/);
    expect(writesLabel([])).toBe('read-only');
    expect(writesLabel(['src/**'])).toBe('src/**');
    expect(phaseWorkLabel(pipeline.phases[0]!)).toBe('planner');
    expect(phaseWorkLabel(pipeline.phases[1]!)).toBe('test');
    expect(
      phaseWorkLabel({ name: 'ask', kind: 'engineer', description: '', question: 'Ship it?' }),
    ).toBe('Ship it?');
  });
});

describe('project card helpers', () => {
  it('formats health, divergence, and scopes labels in domain language', () => {
    expect(projectCardHealthLabel({ ok: true })).toBe('Healthy');
    expect(projectCardHealthLabel({ ok: false, failedCount: 2 })).toBe('2 issues');
    expect(projectCardHealthLabel(undefined)).toBe('Unknown health');

    expect(projectCardDivergenceLabel({ ahead: 0, behind: 0, state: 'current' })).toBe(
      'Up to date',
    );
    expect(projectCardDivergenceLabel({ ahead: 3, behind: 0, state: 'ahead' })).toBe('3 ahead');
    expect(projectCardDivergenceLabel({ ahead: 0, behind: 2, state: 'behind' })).toBe('2 behind');
    expect(projectCardDivergenceLabel({ ahead: 1, behind: 2, state: 'diverged' })).toBe(
      '1 ahead, 2 behind',
    );
    expect(projectCardDivergenceLabel({ ahead: 0, behind: 0, state: 'no_remote' })).toBe(
      'No remote',
    );
    expect(projectCardDivergenceLabel(undefined)).toBe('Up to date');

    expect(projectCardScopesLabel({ roster: true, pipelines: true })).toBe(
      'Custom roster & pipelines',
    );
    expect(projectCardScopesLabel({ roster: true, pipelines: false })).toBe('Custom roster');
    expect(projectCardScopesLabel({ roster: false, pipelines: true })).toBe('Custom pipelines');
    expect(projectCardScopesLabel({ roster: false, pipelines: false })).toBe('Global defaults');
    expect(projectCardScopesLabel(undefined)).toBe('Global defaults');
  });

  it('formats project card summary', () => {
    expect(projectCardSummary(project)).toBe('main · 1 command · Healthy · Up to date');
    expect(projectCardSummary({ ...project, summary: 'Custom project summary' })).toBe(
      'Custom project summary',
    );
  });
});

describe('PR card helpers', () => {
  it('formats checks, glyphs, and mergeable labels in domain language', () => {
    expect(prChecksLabel('passing')).toBe('Checks passed');
    expect(prChecksLabel('failing')).toBe('Checks failed');
    expect(prChecksLabel('pending')).toBe('Checks pending');
    expect(prChecksLabel('none')).toBe('No checks');
    expect(prChecksLabel(undefined)).toBe('No checks');

    expect(prChecksGlyph('passing')).toBe('✓');
    expect(prChecksGlyph('failing')).toBe('✕');
    expect(prChecksGlyph('pending')).toBe('◌');
    expect(prChecksGlyph('none')).toBe('—');

    expect(prMergeableLabel('mergeable')).toBe('Mergeable');
    expect(prMergeableLabel('conflicting')).toBe('Conflicts');
    expect(prMergeableLabel('unknown')).toBe('Merge status unknown');
    expect(prMergeableLabel(undefined)).toBe('Merge status unknown');
  });

  it('formats PR summary', () => {
    expect(prSummary(pr)).toBe('fou-160 → main · Checks passed · Mergeable');
  });
});

describe('compareEntities', () => {
  it('returns nothing when there is no previous definition', () => {
    expect(compareEntities('agent', null, agent)).toEqual([]);
    expect(compareEntities('agent', undefined, agent)).toEqual([]);
  });

  it('diffs agent fields in domain language, ignoring unchanged ones', () => {
    const next = { ...agent, purpose: 'Plan more.', writes: ['docs/**'] };
    const changes = compareEntities('agent', agent, next);
    expect(changes).toEqual([
      { where: 'purpose', kind: 'changed', before: 'Plan the work.', after: 'Plan more.' },
      { where: 'write boundary', kind: 'changed', before: '[]', after: '["docs/**"]' },
    ]);
  });

  it('reports pipeline phase additions, removals, reorders, and field changes', () => {
    const next: PipelineDef = {
      ...pipeline,
      phases: [
        { name: 'test', kind: 'code', description: 'Test.', command: { ref: 'test' } },
        { name: 'plan', kind: 'agent', description: 'Plan harder.', agent: 'planner' },
        { name: 'review', kind: 'agent', description: 'Review.', agent: 'reviewer' },
      ],
    };
    const changes = compareEntities('pipeline', pipeline, next);
    expect(changes).toContainEqual({ where: 'phase review', kind: 'added', after: 'agent' });
    expect(changes).toContainEqual(
      expect.objectContaining({ where: 'phase order', kind: 'reordered' }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({ where: 'phase plan description', kind: 'changed' }),
    );

    const removed = compareEntities('pipeline', pipeline, {
      ...pipeline,
      phases: [pipeline.phases[0]!],
    });
    expect(removed).toEqual([{ where: 'phase test', kind: 'removed', before: 'code' }]);
  });

  it('reports envelope field additions, removals, and changes', () => {
    const next: EnvelopeDef = {
      ...envelope,
      fields: [
        { name: 'severity', type: 'number', required: true },
        { name: 'owner', type: 'string', required: false },
      ],
    };
    const changes = compareEntities('envelope', envelope, next);
    expect(changes).toContainEqual({ where: 'field owner', kind: 'added', after: 'string' });
    expect(changes).toContainEqual(
      expect.objectContaining({ where: 'field severity', kind: 'changed' }),
    );
  });

  it('previews long values bounded rather than dumping them', () => {
    const next = { ...agent, systemPrompt: 'y'.repeat(500) };
    const [change] = compareEntities('agent', agent, next);
    expect(change!.after!.length).toBeLessThan(200);
    expect(change!.after).toMatch(/…$/);
  });
});
