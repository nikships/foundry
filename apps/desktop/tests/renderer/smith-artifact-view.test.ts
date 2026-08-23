/**
 * The artifact registry's pure half: which kinds/versions this build renders,
 * the display labels the design bodies draw, and the semantic before/after an
 * edit proposal shows. All DOM-free on purpose — the rules live here so the
 * components stay thin.
 */

import { describe, expect, it } from 'vitest';
import type {
  AgentDef,
  ChecklistDef,
  EnvelopeDef,
  PipelineDef,
  SmithArtifact,
} from '@shared/types.js';
import { SMITH_ARTIFACT_VERSION } from '@shared/types.js';
import {
  ARTIFACT_KIND_LABEL,
  acceptanceLabel,
  artifactName,
  checklistStatusGlyph,
  checklistStatusLabel,
  checklistSummary,
  commandLabel,
  compareEntities,
  gateLabel,
  groupChecklistItems,
  isRenderableArtifact,
  phaseWorkLabel,
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

function artifactOf(kind: SmithArtifact['kind'], version = SMITH_ARTIFACT_VERSION): SmithArtifact {
  const base = { id: 'a1', version, createdAt: 0, warnings: [] };
  if (kind === 'pipeline_design') return { ...base, kind, pipeline };
  if (kind === 'agent_design') return { ...base, kind, agent };
  if (kind === 'envelope_design') return { ...base, kind, envelope };
  return { ...base, kind, checklist };
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
    expect(isRenderableArtifact({ kind: 'run_summary' } as unknown as SmithArtifact)).toBe(false);
  });

  it('names each artifact by its identifying field', () => {
    expect(artifactName(artifactOf('pipeline_design'))).toBe('ship-it');
    expect(artifactName(artifactOf('agent_design'))).toBe('planner');
    expect(artifactName(artifactOf('envelope_design'))).toBe('severity_report');
    expect(artifactName(artifactOf('checklist'))).toBe('Project Health');
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
