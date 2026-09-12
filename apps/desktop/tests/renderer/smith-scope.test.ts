import { describe, expect, it } from 'vitest';
import {
  resolveSmithProjectId,
  smithCapabilityScopeNote,
} from '../../src/renderer/view-models/smith-scope.js';

const projects = [{ id: 'one' }, { id: 'two' }];

describe('Smith scope resolution', () => {
  it('defaults a first-time preference to the selected project', () => {
    expect(resolveSmithProjectId(projects, 'two', null, false)).toBe('two');
  });

  it('preserves an explicit All projects preference', () => {
    expect(resolveSmithProjectId(projects, 'two', null, true)).toBeNull();
  });

  it('preserves a valid Smith project independently of app selection', () => {
    expect(resolveSmithProjectId(projects, 'two', 'one', true)).toBe('one');
  });

  it('falls back when a saved project was removed, and global when none remain', () => {
    expect(resolveSmithProjectId(projects, 'two', 'gone', true)).toBe('two');
    expect(resolveSmithProjectId([], '', 'gone', true)).toBeNull();
  });
});

describe('smith capability scope', () => {
  it('runs viewer-global capabilities from All projects without a note', () => {
    expect(smithCapabilityScopeNote('assigned-work', null)).toBeNull();
    expect(smithCapabilityScopeNote('ticket-status', null)).toBeNull();
    expect(smithCapabilityScopeNote('voice-key-state', null)).toBeNull();
  });

  it('asks for a project scope for plans, pipelines, and context refresh', () => {
    for (const capability of [
      'orchestrator-plan',
      'orchestrator-list',
      'pipeline-run',
      'linear-pipeline-run',
      'refresh-context',
    ] as const) {
      expect(smithCapabilityScopeNote(capability, null)).toMatch(/project scope/i);
      expect(smithCapabilityScopeNote(capability, 'one')).toBeNull();
    }
  });
});
