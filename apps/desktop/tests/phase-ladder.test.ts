/**
 * The ladder is the pipeline designer. A rung that stops being a tab, a loop
 * arc that stops being drawn, or an acceptance mark that lands on the wrong
 * phase are all silent failures — the screen still renders, it just stops
 * telling the truth. These render it to markup and assert the structure.
 *
 * `AgentAvatar` is stubbed because it reads the app context for its colour and
 * resolves its emblem over IPC; neither exists in a node test, and neither is
 * what this file is about.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDef, Acceptance, PhaseDef, ValidationIssue } from '../src/shared/types.js';
import PhaseLadder from '../src/renderer/components/PhaseLadder.js';
import { feedbackArcs, gutterWidth, rungCenter } from '../src/renderer/pipeline-view.js';

// `vi.mock` is hoisted above the imports, so the factory resolves React itself
// rather than closing over the binding at the top of this file.
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

function render(
  phases: PhaseDef[],
  opts: {
    selected?: number;
    acceptance?: Acceptance;
    issues?: ValidationIssue[];
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(PhaseLadder, {
      phases,
      agents: AGENTS,
      agentColor: () => '#4fa8b8',
      acceptance: opts.acceptance ?? { kind: 'all_phases_pass' },
      issues: opts.issues ?? [],
      selected: opts.selected ?? 0,
      panelId: 'dock',
      onSelect: () => {},
      onMove: () => {},
      onRemove: () => {},
      onAdd: () => {},
    }),
  );
}

describe('the phase ladder', () => {
  it('renders one tab per phase, in pipeline order', () => {
    const html = render([agent('plan'), agent('build'), code('test')]);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    // Match the rendered name element, not the bare word: the agent behind a
    // phase is called "builder", which contains a phase name.
    expect(html.indexOf('>plan<')).toBeLessThan(html.indexOf('>build<'));
    expect(html.indexOf('>build<')).toBeLessThan(html.indexOf('>test<'));
  });

  it('is a vertical tablist, so arrow keys read up and down rather than across', () => {
    expect(render([agent('plan')])).toContain('aria-orientation="vertical"');
  });

  it('selects exactly one rung and points every rung at the inspector panel', () => {
    const html = render([agent('plan'), agent('build')], { selected: 1 });
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/aria-controls="dock"/g)).toHaveLength(2);
    // Roving tabindex: only the selected rung is in the tab order.
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
  });

  it('falls back to the first rung when the selection is out of range', () => {
    // A phase removed from the end can leave the index past the list.
    const html = render([agent('plan')], { selected: 7 });
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('id="dock-tab-0"');
  });

  it('draws a loop arc and labels it when a phase sends failures back', () => {
    const phases = [agent('build'), code('test', { feedbackTo: 'build' })];
    const looped = render(phases);
    expect(looped).toContain('1 repair loop');

    // The arc has to start on the rail at the failing rung, or the picture is
    // decorative rather than true. Only arcs use a quadratic curve; every
    // other path in the ladder is a glyph.
    const arcs = feedbackArcs(phases);
    const railX = gutterWidth(arcs) - 0.5;
    expect(looped).toContain(`d="M ${railX} ${rungCenter(1)}`);
    expect(looped).toContain(' Q ');

    const plain = render([agent('build'), code('test')]);
    expect(plain).not.toContain('repair loop');
    expect(plain).not.toContain(' Q ');
  });

  it('marks the phase acceptance reads, and only that phase', () => {
    const html = render([agent('plan'), agent('build')], {
      acceptance: { kind: 'envelope_status', phase: 'build' },
    });
    expect(html.match(/Acceptance reads this phase/g)).toHaveLength(1);
  });

  it('does not mark every rung when acceptance reads all of them', () => {
    const html = render([agent('plan'), agent('build')], {
      acceptance: { kind: 'all_phases_pass' },
    });
    expect(html).not.toContain('Acceptance reads this phase');
  });

  it('flags the rung a validation issue belongs to, so it is not only in the status bar', () => {
    const html = render([agent('plan'), agent('build')], {
      issues: [{ level: 'error', where: 'phases[1] build', message: 'needs an agent' }],
    });
    expect(html).toContain('Has an error');
    expect(html).not.toContain('Has a warning');
  });

  it('lets an error outrank a warning reported against the same phase', () => {
    const html = render([agent('plan')], {
      issues: [
        { level: 'warning', where: 'phases[0] plan', message: 'hmm' },
        { level: 'error', where: 'phases[0] plan', message: 'boom' },
      ],
    });
    expect(html).toContain('Has an error');
    expect(html).not.toContain('Has a warning');
  });

  it('shows what each kind of phase will actually do', () => {
    const checkpoint: PhaseDef = {
      name: 'ship',
      kind: 'engineer',
      description: 'ask a human',
      question: 'Ship it?',
    };
    const html = render([
      agent('plan'),
      code('test', { command: { argv: ['npm', 'run', 'lint'] } }),
      checkpoint,
    ]);
    expect(html).toContain('builder');
    expect(html).toContain('npm run lint');
    expect(html).toContain('Ship it?');
  });

  it('keeps reorder and remove reachable on every rung', () => {
    const html = render([agent('plan'), agent('build')]);
    expect(html).toContain('aria-label="Move plan later"');
    expect(html).toContain('aria-label="Move build earlier"');
    expect(html).toContain('aria-label="Remove plan"');
    // The ends of the ladder cannot move past themselves.
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it('offers the add control and an explanation when the pipeline has no phases', () => {
    const html = render([]);
    expect(html).toContain('No phases yet');
    expect(html).toContain('Add phase');
    expect(html).not.toContain('role="tab"');
  });
});
