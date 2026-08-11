/**
 * The stage board is redesign Option B. Its columns are derived from the phase
 * list, so the failure worth guarding is a board that renders a structure the
 * pipeline does not actually have — a gate in the wrong column, a card that
 * offers a cross-stage move it cannot make, an acceptance mark on the wrong
 * card. These render it to markup and assert against the data.
 *
 * `AgentAvatar` is stubbed: it reads app context for its colour and resolves
 * its emblem over IPC, neither of which exists in a node test.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDef, Acceptance, PhaseDef, ValidationIssue } from '../src/shared/types.js';
import StageBoard from '../src/renderer/components/StageBoard.js';

vi.mock('../src/renderer/components/AgentAvatar.js', async () => {
  const react = await import('react');
  return {
    default: ({ name }: { name: string | null }) =>
      react.createElement('span', { 'data-avatar': name ?? '' }),
  };
});

const AGENTS: AgentDef[] = [
  {
    name: 'builder',
    purpose: 'writes the code',
    cli: 'droid',
    model: 'test-model',
    reasoningEffort: 'medium',
    systemPrompt: '',
    userPrompt: '',
    writes: null,
    envelope: 'build',
    color: '#4fa8b8',
  },
];

const agent = (name: string, extra: Partial<PhaseDef> = {}): PhaseDef => ({
  name,
  kind: 'agent',
  description: `${name} does a thing`,
  agent: 'builder',
  envelope: 'build',
  ...extra,
});
const code = (name: string, extra: Partial<PhaseDef> = {}): PhaseDef => ({
  name,
  kind: 'code',
  description: `${name} runs a command`,
  command: { ref: 'npm test' },
  ...extra,
});
const gate = (name: string, question = 'Ship it?'): PhaseDef => ({
  name,
  kind: 'engineer',
  description: `${name} asks a human`,
  question,
});

function render(
  phases: PhaseDef[],
  opts: { selected?: number; acceptance?: Acceptance; issues?: ValidationIssue[] } = {},
): string {
  return renderToStaticMarkup(
    createElement(StageBoard, {
      phases,
      agents: AGENTS,
      agentColor: () => '#4fa8b8',
      acceptance: opts.acceptance ?? { kind: 'all_phases_pass' },
      issues: opts.issues ?? [],
      selected: opts.selected ?? -1,
      onSelect: () => {},
      onMove: () => {},
      onMoveStage: () => {},
      onRemove: () => {},
      onAdd: () => {},
      onAddGate: () => {},
    }),
  );
}

describe('the stage board', () => {
  it('draws one column per gated stage, numbered in execution order', () => {
    const html = render([agent('plan'), gate('g1'), code('test')]);
    expect(html).toContain('Stage 1');
    expect(html).toContain('Stage 2');
    expect(html.indexOf('Stage 1')).toBeLessThan(html.indexOf('Stage 2'));
  });

  it('calls an ungated pipeline one whole run rather than "Stage 1"', () => {
    const html = render([agent('plan'), code('test')]);
    expect(html).toContain('Whole run');
    expect(html).not.toContain('Stage 1');
  });

  it('renders the checkpoint as the gate between columns, not as a card', () => {
    const html = render([agent('plan'), gate('g1', 'Looks right?'), code('test')]);
    expect(html).toContain('Looks right?');
    // The gate carries its own remove control, distinct from a card's.
    expect(html).toContain('aria-label="Remove gate g1"');
    expect(html).not.toContain('aria-label="Move g1 to the next stage"');
  });

  it('offers to close an ungated stage with a new gate', () => {
    expect(render([agent('plan')])).toContain('Add gate');
  });

  it('only offers a cross-stage move where a stage exists to receive it', () => {
    const html = render([agent('plan'), gate('g1'), code('test')]);
    // plan is first: nowhere earlier to go, but it can cross the gate forward.
    expect(html).toContain('aria-label="Move plan to the next stage"');
    expect(html).toContain('aria-label="Move test to the previous stage"');
    // test is in the last stage; there is nothing after it.
    expect(html).toContain('aria-label="Move test to the next stage"');
    // Both dead-end controls render but are disabled rather than missing.
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('marks the phase acceptance reads, on its card', () => {
    const html = render([agent('plan'), gate('g1'), code('test')], {
      acceptance: { kind: 'envelope_status', phase: 'test' },
    });
    expect(html.match(/Acceptance reads this phase/g)).toHaveLength(1);
  });

  it('flags a phase that has a validation issue, error outranking warning', () => {
    const html = render([agent('plan')], {
      issues: [
        { level: 'warning', where: 'phases[0] plan', message: 'hmm' },
        { level: 'error', where: 'phases[0] plan', message: 'boom' },
      ],
    });
    expect(html).toContain('Has an error');
    expect(html).not.toContain('Has a warning');
  });

  it('shows a repair loop on the card that owns it', () => {
    const html = render([agent('build'), code('test', { feedbackTo: 'build' })]);
    expect(html).toContain('repairs to build');
  });

  it('marks the selected card so the slide-over is anchored to something', () => {
    const html = render([agent('plan'), code('test')], { selected: 1 });
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('gives every stage its own composer, including an empty one', () => {
    const html = render([gate('g1'), agent('later')]);
    expect(html).toContain('Nothing runs in this stage yet.');
    expect(html.match(/Add phase/g)).toHaveLength(2);
  });

  it('shows what each kind of phase will do', () => {
    const html = render([
      agent('plan'),
      code('lint', { command: { argv: ['npm', 'run', 'lint'] } }),
    ]);
    expect(html).toContain('builder');
    expect(html).toContain('npm run lint');
  });
});
