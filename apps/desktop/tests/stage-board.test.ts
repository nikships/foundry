import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import type { PhaseDef, ValidationIssue } from '@shared/types.js';
import StageBoard from '../src/renderer/components/StageBoard.js';

describe('StageBoard', () => {
  const samplePhases: PhaseDef[] = [
    {
      name: 'scope_analyst',
      kind: 'agent',
      description: 'Produces implementation brief',
      agent: 'builder',
      envelope: 'build',
      gates: ['lint_clean'],
    },
    {
      name: 'run_tests',
      kind: 'code',
      description: 'Executes test suite',
      command: { ref: 'test' },
      feedbackTo: 'scope_analyst',
    },
    {
      name: 'human_gate',
      kind: 'engineer',
      description: 'Sign off diff',
      question: 'Ready to ship?',
      timeoutMs: 600000,
    },
    {
      name: 'ship_release',
      kind: 'agent',
      description: 'Tags release',
      agent: 'builder',
    },
  ];

  const agentColor = () => 'var(--accent)';
  const noop = () => {};

  it('renders empty state when there are no phases', () => {
    const html = renderToStaticMarkup(
      React.createElement(StageBoard, {
        phases: [],
        selectedPhase: null,
        onSelectPhase: noop,
        onAddPhase: noop,
        onMovePhase: noop,
        onReorderPhase: noop,
        onNewStagePhase: noop,
        onRemovePhase: noop,
        agentColor,
        issues: [],
      }),
    );

    expect(html).toContain('No stages yet');
    expect(html).toContain('Agent');
    expect(html).toContain('Command');
    expect(html).toContain('Checkpoint');
  });

  it('renders stage columns and checkpoint gate slots', () => {
    const html = renderToStaticMarkup(
      React.createElement(StageBoard, {
        phases: samplePhases,
        selectedPhase: 0,
        onSelectPhase: noop,
        onAddPhase: noop,
        onMovePhase: noop,
        onReorderPhase: noop,
        onNewStagePhase: noop,
        onRemovePhase: noop,
        agentColor,
        issues: [],
      }),
    );

    // Stage 1 header and content
    expect(html).toContain('Stage <span class="');
    expect(html).toContain('01');
    expect(html).toContain('2 unattended');
    expect(html).toContain('scope_analyst');
    expect(html).toContain('run_tests');

    // Gate slot between stage 1 and stage 2
    expect(html).toContain('Checkpoint');
    expect(html).toContain('human_gate');
    expect(html).toContain('Ready to ship?');
    expect(html).toContain('Closes stage 01');

    // Stage 2 content
    expect(html).toContain('02');
    expect(html).toContain('ship_release');
    // Trailing slot to add a checkpoint
    expect(html).toContain('+ Checkpoint');
  });

  it('gives every card a drag surface and every stage its drop targets', () => {
    const html = renderToStaticMarkup(
      React.createElement(StageBoard, {
        phases: samplePhases,
        selectedPhase: null,
        onSelectPhase: noop,
        onAddPhase: noop,
        onMovePhase: noop,
        onReorderPhase: noop,
        onNewStagePhase: noop,
        onRemovePhase: noop,
        agentColor,
        issues: [],
      }),
    );

    // A settle id per phase, named after the phase so it survives a reorder;
    // the checkpoint is draggable on the same terms as the work.
    expect(html).toContain('data-settle="phase:scope_analyst"');
    expect(html).toContain('data-settle="phase:run_tests"');
    expect(html).toContain('data-settle="phase:human_gate"');
    expect(html).toContain('data-settle="phase:ship_release"');

    // The whole card above the toolbar is the handle, not a small grip.
    expect(html.match(/dragSurface/g)?.length).toBe(samplePhases.length);

    // Slots and rails are painted before a drag starts so the board does not
    // change geometry the moment a card is picked up.
    expect((html.match(/dropSlot/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('newStageRail');
  });

  it('renders validation issue indicators', () => {
    const issues: ValidationIssue[] = [
      { level: 'error', message: 'Unknown agent', where: 'phases[0] scope_analyst' },
      { level: 'warning', message: 'Question missing', where: 'phases[2] human_gate' },
    ];

    const html = renderToStaticMarkup(
      React.createElement(StageBoard, {
        phases: samplePhases,
        selectedPhase: null,
        onSelectPhase: noop,
        onAddPhase: noop,
        onMovePhase: noop,
        onReorderPhase: noop,
        onNewStagePhase: noop,
        onRemovePhase: noop,
        agentColor,
        issues,
      }),
    );

    expect(html).toContain('error');
    expect(html).toContain('issue');
  });

  it('renders the resolved configuration of each phase as chips', () => {
    const html = renderToStaticMarkup(
      React.createElement(StageBoard, {
        phases: samplePhases,
        selectedPhase: null,
        onSelectPhase: noop,
        onAddPhase: noop,
        onMovePhase: noop,
        onReorderPhase: noop,
        onNewStagePhase: noop,
        onRemovePhase: noop,
        agentColor,
        issues: [],
      }),
    );

    // Agent phase: owner, envelope, and gate count
    expect(html).toContain('builder');
    expect(html).toContain('build');
    expect(html).toContain('1 gate');
    // A phase with no envelope of its own inherits the agent's
    expect(html).toContain('inherit');
    // Code phase: the command it runs and where failure is handed back
    expect(html).toContain('test');
    expect(html).toContain('feedback');
    // Checkpoint: the two answers it accepts and its timeout
    expect(html).toContain('approve');
    expect(html).toContain('reject');
    expect(html).toContain('10m');
  });
});
