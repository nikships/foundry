/**
 * The icon resolver decides the mark and identity colour every timeline and
 * transcript row wears. A misclassified event does not fail visibly — it just
 * renders the generic dot — so these tests pin the classifications the design
 * calls out: read blue, search purple, thinking amber, assistant green,
 * prompt teal, and build/builder accent-coloured instead of generic.
 */

import { describe, expect, it } from 'vitest';
import type { EventType } from '@shared/types.js';
import { eventIconSpec } from '@renderer/components/common/EventIcon.js';

function spec(type: EventType, name: string, payload: Record<string, unknown> = {}) {
  return eventIconSpec({ type, name, payload });
}

describe('tool call identity', () => {
  it('colours a read blue', () => {
    expect(spec('tool_call', 'read: src/a.ts', { kind: 'read' }).color).toBe('var(--blue)');
  });

  it('colours a search purple', () => {
    expect(spec('tool_call', 'grep: foo', { kind: 'search' }).color).toBe('var(--purple)');
  });

  it('colours an edit amber', () => {
    expect(spec('tool_call', 'edit: src/a.ts', { kind: 'edit' }).color).toBe('var(--amber)');
  });

  it('classifies a build code phase by name instead of the generic command shape', () => {
    const s = spec('tool_call', 'build: npm run build', { argv: ['npm', 'run', 'build'] });
    expect(s.color).toBe('var(--accent)');
    expect(s).not.toEqual(spec('tool_call', 'test: npm test', { argv: ['npm', 'test'] }));
  });

  it('classifies a builder-named row with build, not the wrench fallback', () => {
    const build = spec('tool_call', 'build: make', { argv: ['make'] });
    expect(spec('tool_call', 'builder: make', { argv: ['make'] })).toEqual(build);
  });

  it('falls back for a tool nobody classified rather than throwing', () => {
    expect(spec('tool_call', 'some_future_tool: x').icon).toBeTruthy();
  });

  it('infers from the row name when the folder recorded no kind', () => {
    expect(spec('tool_call', 'read: src/a.ts').color).toBe('var(--blue)');
    expect(spec('tool_call', 'grep: foo').color).toBe('var(--purple)');
  });
});

describe('event identity', () => {
  it('colours thinking amber and assistant green', () => {
    expect(spec('thinking', 'thinking').color).toBe('var(--amber)');
    expect(spec('assistant_text', 'assistant').color).toBe('var(--green)');
  });

  it('colours the prompt log teal, other logs stay neutral', () => {
    expect(spec('log', 'prompt').color).toBe('var(--teal)');
    expect(spec('log', 'worktree merge').color).toBeUndefined();
  });

  it('marks the builder agent distinctly from other agents', () => {
    const builder = spec('agent_start', 'builder');
    const other = spec('agent_start', 'planner');
    expect(builder.color).toBe('var(--accent)');
    expect(builder.icon).not.toBe(other.icon);
  });

  it('leaves status-coloured rows without an identity colour', () => {
    for (const type of ['gate_pass', 'gate_fail', 'correction', 'error'] as EventType[]) {
      expect(spec(type, type).color, type).toBeUndefined();
    }
  });

  it('has an icon for every event type', () => {
    const types: EventType[] = [
      'phase_start',
      'phase_end',
      'agent_start',
      'agent_end',
      'tool_call',
      'assistant_text',
      'thinking',
      'handoff',
      'gate_pass',
      'gate_fail',
      'correction',
      'interrupt',
      'compaction',
      'replan',
      'log',
      'error',
    ];
    for (const type of types) expect(spec(type, type).icon, type).toBeTruthy();
  });
});
