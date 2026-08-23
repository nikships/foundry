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
  CheckpointDef,
  ChecklistDef,
  EnvelopeDef,
  PipelineDef,
  PrCardDef,
  ProjectCardDef,
  ProviderStatusDef,
  ReadinessJourneyDef,
  SmithActionReceipt,
  SmithArtifact,
  SmithReceiptLink,
  SmithRunSummaryArtifact,
} from '@shared/types.js';
import { SMITH_ARTIFACT_VERSION } from '@shared/types.js';
import {
  ARTIFACT_KIND_LABEL,
  acceptanceLabel,
  artifactName,
  bridgeStatusLine,
  changeReceiptStatusLabel,
  changeReceiptSummary,
  changeReceiptTargetLabel,
  checklistStatusGlyph,
  checklistStatusLabel,
  checklistSummary,
  checkpointActions,
  checkpointAnswerEditable,
  checkpointContext,
  checkpointStatusLabel,
  commandLabel,
  compareEntities,
  criterionLabel,
  criterionStatusLabel,
  gateLabel,
  groupChecklistItems,
  groupJourneyCriteria,
  isJourneyPhaseLive,
  isActionableLink,
  isRenderableArtifact,
  isolationLabel,
  journeyActions,
  journeyMarkerVerdict,
  journeyNeedsContinue,
  journeySummary,
  phaseWorkLabel,
  prChecksGlyph,
  prChecksLabel,
  prMergeableLabel,
  prSummary,
  projectCardDivergenceLabel,
  projectCardHealthLabel,
  projectCardScopesLabel,
  projectCardSummary,
  providerConnectionLabel,
  providerKeyLabel,
  providerStatusSummary,
  readinessPhaseLabel,
  receiptDuration,
  receiptOutcomeView,
  receiptRows,
  runStatusLabel,
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

const runSummary: SmithRunSummaryArtifact = {
  id: 'a1',
  kind: 'run_summary',
  version: SMITH_ARTIFACT_VERSION,
  createdAt: 0,
  warnings: [],
  runId: 'run_123',
  pipelineId: 'ship-it',
  pipelineName: 'Ship it',
  request: 'Build feature',
  status: 'accepted',
  startedAt: '2026-08-23T00:00:00.000Z',
  phases: [
    {
      name: 'plan',
      kind: 'agent',
      status: 'success',
      owner: 'planner',
      durationMs: 1200,
    },
  ],
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

const actionReceipt: SmithActionReceipt = {
  operation: 'create',
  title: 'create pull request',
  target: 'run_7',
  consequences: 'create using GitHub.',
  risk: 'git',
  outcome: 'succeeded',
  durationMs: 1500,
  args: { runId: 'run_7' },
};

const changeReceipt: ChangeReceiptDef = {
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

const checkpoint: CheckpointDef = {
  interruptId: 'int_1',
  title: 'Ship the migration?',
  question: 'The migration drops a column. Proceed?',
  runId: 'run_abcdef123456',
  phaseId: 'review',
  pipelineId: 'ship-it',
  draftAnswer: 'Yes, the column is unused.',
};

const journey: ReadinessJourneyDef = {
  projectId: 'proj_1',
  projectName: 'foundry',
  phase: 'needs_continue',
  marker: { valid: false, detail: 'No marker on origin/main.' },
  criteria: [
    { id: 'lint_format', status: 'pass' },
    { id: 'typecheck', status: 'fail', notes: 'tsc reports 3 errors' },
    { id: 'coverage', status: 'n/a', notes: 'no coverage tooling' },
  ],
};

const providerStatus: ProviderStatusDef = {
  providers: [
    { id: 'anthropic', label: 'Anthropic', connection: 'connected', authenticated: true },
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
    devices: [{ deviceId: 'dev_1', name: 'Pixel 9', pairedAt: '2026-08-01T00:00:00Z' }],
  },
};

function artifactOf(kind: SmithArtifact['kind'], version = SMITH_ARTIFACT_VERSION): SmithArtifact {
  const base = { id: 'a1', version, createdAt: 0, warnings: [] };
  if (kind === 'pipeline_design') return { ...base, kind, pipeline };
  if (kind === 'agent_design') return { ...base, kind, agent };
  if (kind === 'envelope_design') return { ...base, kind, envelope };
  if (kind === 'checklist') return { ...base, kind, checklist };
  if (kind === 'run_summary') return { ...runSummary, ...base, kind: 'run_summary' };
  if (kind === 'action_receipt') return { ...base, kind, receipt: actionReceipt };
  if (kind === 'change_receipt') return { ...base, kind, receipt: changeReceipt };
  if (kind === 'project_card') return { ...base, kind, project };
  if (kind === 'pr_card') return { ...base, kind, pr };
  if (kind === 'engineer_checkpoint') return { ...base, kind, checkpoint };
  if (kind === 'readiness_journey') return { ...base, kind, journey };
  if (kind === 'provider_status') return { ...base, kind, status: providerStatus };
  return {
    ...base,
    kind,
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
    expect(isRenderableArtifact(artifactOf('run_summary', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('entity_comparison', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('change_receipt', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('project_card', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('pr_card', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('engineer_checkpoint', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('readiness_journey', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('provider_status', 99))).toBe(false);
    expect(isRenderableArtifact(artifactOf('action_receipt', 99))).toBe(false);
    expect(isRenderableArtifact({ kind: 'unknown_kind' } as unknown as SmithArtifact)).toBe(false);
  });

  it('names each artifact by its identifying field', () => {
    expect(artifactName(artifactOf('pipeline_design'))).toBe('ship-it');
    expect(artifactName(artifactOf('agent_design'))).toBe('planner');
    expect(artifactName(artifactOf('envelope_design'))).toBe('severity_report');
    expect(artifactName(artifactOf('checklist'))).toBe('Project Health');
    expect(artifactName(artifactOf('run_summary'))).toBe('Ship it');
    expect(artifactName(artifactOf('entity_comparison'))).toBe('planner');
    expect(artifactName(artifactOf('change_receipt'))).toBe('Checkout changes applied');
    expect(artifactName(artifactOf('project_card'))).toBe('Foundry');
    expect(artifactName(artifactOf('pr_card'))).toBe('#188 Add change receipt');
    expect(artifactName(artifactOf('action_receipt'))).toBe('create pull request');
    expect(artifactName(artifactOf('engineer_checkpoint'))).toBe('Ship the migration?');
    expect(artifactName(artifactOf('readiness_journey'))).toBe('foundry');
    expect(artifactName(artifactOf('provider_status'))).toBe('Providers and Companion');
  });
});

describe('engineer checkpoint helpers', () => {
  it('joins run, phase, and pipeline context the way InterruptSheet does', () => {
    expect(checkpointContext(checkpoint)).toBe('run run_abcd · phase review · pipeline ship-it');
    expect(checkpointContext({ interruptId: 'i', title: 't', question: 'q' })).toBe('');
  });

  it('defaults to approve/reject/edit when the spec named no actions', () => {
    expect(checkpointActions(checkpoint).map((action) => action.kind)).toEqual([
      'approve',
      'reject',
      'edit',
    ]);
    expect(
      checkpointActions({
        ...checkpoint,
        actions: [{ id: 'ok', label: 'Ship it', kind: 'approve' }],
      }).map((action) => action.label),
    ).toEqual(['Ship it']);
  });

  it('stops offering an editable answer once the checkpoint is answered', () => {
    expect(checkpointAnswerEditable(checkpoint)).toBe(true);
    expect(checkpointAnswerEditable({ ...checkpoint, answered: true })).toBe(false);
    expect(
      checkpointAnswerEditable({
        ...checkpoint,
        actions: [{ id: 'ok', label: 'Approve', kind: 'approve' }],
      }),
    ).toBe(false);
  });

  it('reads as pending or as settled history, never both', () => {
    expect(checkpointStatusLabel(checkpoint)).toBe('Awaiting decision');
    expect(checkpointStatusLabel({ ...checkpoint, answered: true, decision: 'approve' })).toBe(
      'Approved',
    );
    expect(checkpointStatusLabel({ ...checkpoint, answered: true, decision: 'reject' })).toBe(
      'Rejected',
    );
    expect(checkpointStatusLabel({ ...checkpoint, answered: true })).toBe('Answered');
  });
});

describe('readiness journey helpers', () => {
  it('labels every readiness phase and marks the live ones', () => {
    expect(readinessPhaseLabel('remediating')).toMatch(/worktree/);
    expect(readinessPhaseLabel('needs_continue')).toMatch(/Continue/);
    expect(readinessPhaseLabel('complete')).toBe('Agent-ready');

    expect(isJourneyPhaseLive('remediating')).toBe(true);
    expect(isJourneyPhaseLive('verifying')).toBe(true);
    // Waiting on the operator to merge is not work in flight.
    expect(isJourneyPhaseLive('pr_ready')).toBe(false);
    expect(isJourneyPhaseLive('needs_continue')).toBe(false);
    expect(isJourneyPhaseLive('complete')).toBe(false);
  });

  it('groups criteria by pass/fail/n-a and names them readably', () => {
    const groups = groupJourneyCriteria(journey.criteria);
    expect(groups.fail.map((criterion) => criterion.id)).toEqual(['typecheck']);
    expect(groups.pass.map((criterion) => criterion.id)).toEqual(['lint_format']);
    expect(groups.na.map((criterion) => criterion.id)).toEqual(['coverage']);

    expect(criterionLabel('lint_format')).toBe('lint format');
    expect(criterionStatusLabel('pass')).toBe('Passed');
    expect(criterionStatusLabel('fail')).toBe('Failed');
    expect(criterionStatusLabel('n/a')).toBe('Not applicable');
  });

  it('reports the committed marker as the verdict, not the criteria', () => {
    expect(journeyMarkerVerdict(journey)).toBe('No marker on origin/main.');
    expect(
      journeyMarkerVerdict({
        ...journey,
        marker: { valid: true, detail: 'ok', summary: 'Ready at 3f2a1b0.' },
      }),
    ).toBe('Ready at 3f2a1b0.');
    // A valid marker with no summary still says readiness, never a criteria count.
    expect(journeyMarkerVerdict({ ...journey, marker: { valid: true, detail: 'ok' } })).toMatch(
      /committed marker/,
    );
  });

  it('derives a summary from criteria counts when no detail is given', () => {
    expect(journeySummary(journey)).toBe('1 failing · 1 passing · 1 n/a');
    expect(journeySummary({ ...journey, detail: 'Paused after verify.' })).toBe(
      'Paused after verify.',
    );
    expect(journeySummary({ ...journey, criteria: [] })).toBe(
      readinessPhaseLabel('needs_continue'),
    );
  });

  it('offers the needs_continue actions from the phase, not from the action list', () => {
    expect(journeyNeedsContinue(journey)).toBe(true);
    expect(journeyActions(journey)).toEqual(['Continue', 'Start over', 'Skip']);
    expect(journeyActions({ ...journey, actions: ['Continue'] })).toEqual(['Continue']);
    expect(journeyActions({ ...journey, phase: 'complete' })).toEqual([]);
  });
});

describe('provider status helpers', () => {
  it('labels connection states in the operator\u2019s terms', () => {
    expect(providerConnectionLabel('connected')).toBe('Connected');
    expect(providerConnectionLabel('authenticating')).toBe('Signing in');
    expect(providerConnectionLabel('disconnected')).toBe('Not connected');
    expect(providerConnectionLabel('error')).toBe('Error');
  });

  it('says only whether a key exists, never anything about its value', () => {
    expect(providerKeyLabel(true)).toBe('API key stored');
    expect(providerKeyLabel(false)).toBe('No API key');
    expect(providerKeyLabel(undefined)).toBe('No API key');
  });

  it('summarizes providers, Bridge, and Companion device count', () => {
    expect(providerStatusSummary(providerStatus)).toBe(
      '1/2 providers connected · 1 in error · Bridge serving · Companion on (1 device)',
    );
    expect(providerStatusSummary({ summary: 'All good.' })).toBe('All good.');
    expect(providerStatusSummary({})).toBe('No provider or Companion state reported');
    expect(providerStatusSummary({ companion: { running: false } })).toBe('Companion off');
  });

  it('reports the Bridge endpoint when serving and the reason when it is not', () => {
    expect(bridgeStatusLine(providerStatus)).toBe('Serving on http://127.0.0.1:52810');
    expect(bridgeStatusLine({ bridge: { running: true, port: 52810 } })).toBe(
      'Serving on port 52810',
    );
    expect(bridgeStatusLine({ bridge: { running: false, reason: 'binary_missing' } })).toBe(
      'binary_missing',
    );
    expect(bridgeStatusLine({})).toBe('');
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
    expect(changeReceiptSummary(changeReceipt)).toBe('Modified 2 files');
    expect(changeReceiptSummary({ ...changeReceipt, summary: undefined })).toBe(
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

describe('action receipts', () => {
  it('never lets a failed action read like a successful one', () => {
    const ok = receiptOutcomeView(actionReceipt);
    const failed = receiptOutcomeView({
      ...actionReceipt,
      outcome: 'failed',
      failure: 'gh refused',
    });
    expect(ok.label).toBe('Done');
    expect(failed.label).toBe('Failed');
    expect(failed.color).not.toBe(ok.color);
  });

  it('shows the failure row only when the action failed', () => {
    const rows = receiptRows(actionReceipt).map((row) => row.label);
    expect(rows).toEqual(['Operation', 'Target', 'Consequences', 'Risk', 'Took']);

    const failedRows = receiptRows({
      ...actionReceipt,
      outcome: 'failed',
      failure: 'gh refused',
    });
    expect(failedRows).toContainEqual({ label: 'Failure', value: 'gh refused' });
    // The consequences the operator approved stay on a failed card: what was
    // attempted is as much of the record as what happened.
    expect(failedRows).toContainEqual({ label: 'Consequences', value: 'create using GitHub.' });
  });

  it('reports executor duration in bounded units', () => {
    expect(receiptDuration(0)).toBe('0ms');
    expect(receiptDuration(420)).toBe('420ms');
    expect(receiptDuration(1500)).toBe('1.5s');
    expect(receiptDuration(45_000)).toBe('45s');
    expect(receiptDuration(125_000)).toBe('2m 05s');
    // A clock skewed backwards must not render a negative duration.
    expect(receiptDuration(-5)).toBe('0ms');
  });

  it('follows only the link kinds this build knows', () => {
    expect(isActionableLink(undefined)).toBe(false);
    expect(isActionableLink({ kind: 'url', label: 'Open', url: 'https://x.test' })).toBe(true);
    expect(
      isActionableLink({ kind: 'run', label: 'Open run', projectId: 'p1', runId: 'run_7' }),
    ).toBe(true);
    expect(
      isActionableLink({ kind: 'entity', label: 'Open agent', entity: 'agent', name: 'planner' }),
    ).toBe(true);
    // A receipt written by a newer Foundry stays readable, not clickable.
    expect(isActionableLink({ kind: 'dashboard' } as unknown as SmithReceiptLink)).toBe(false);
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

  it('labels run statuses and isolation', () => {
    expect(runStatusLabel('accepted')).toBe('accepted');
    expect(runStatusLabel('running')).toBe('running');
    expect(runStatusLabel('failed')).toBe('failed');
    expect(isolationLabel(true, 'foundry/run_1')).toBe('isolated worktree (foundry/run_1)');
    expect(isolationLabel(true)).toBe('isolated worktree');
    expect(isolationLabel(false)).toBe('direct checkout');
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
