/**
 * Agent emblem catalog, mark resolution, and UI label helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultEmblemFor,
  EMBLEM_BY_ID,
  EMBLEM_GROUPS,
  EMBLEMS,
  isDefaultMark,
  markLabel,
  MONOGRAM_EMBLEM,
  resolveAgentMark,
  suggestedEmblemIds,
} from '../../src/renderer/data/emblems.js';

describe('emblem library catalog integrity', () => {
  it('defines unique IDs across all emblems', () => {
    const ids = EMBLEMS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('populates EMBLEM_BY_ID for every emblem in the library', () => {
    for (const emblem of EMBLEMS) {
      expect(EMBLEM_BY_ID[emblem.id]).toBe(emblem);
    }
  });

  it('assigns every emblem to a known group with non-empty SVG geometry', () => {
    const knownGroups = new Set(EMBLEM_GROUPS);
    for (const emblem of EMBLEMS) {
      expect(knownGroups.has(emblem.group)).toBe(true);
      const hasPaths = emblem.paths && emblem.paths.length > 0;
      const hasCircles = emblem.circles && emblem.circles.length > 0;
      expect(hasPaths || hasCircles).toBe(true);
    }
  });
});

describe('resolveAgentMark', () => {
  it('resolves undefined and monogram to kind: monogram', () => {
    expect(resolveAgentMark(undefined)).toEqual({ kind: 'monogram' });
    expect(resolveAgentMark(MONOGRAM_EMBLEM)).toEqual({ kind: 'monogram' });
    expect(resolveAgentMark('')).toEqual({ kind: 'monogram' });
  });

  it('resolves image:<file> to kind: image with agent-marks path', () => {
    expect(resolveAgentMark('image:abc12345.png')).toEqual({
      kind: 'image',
      imagePath: 'agent-marks/abc12345.png',
    });
  });

  it('rejects path traversal in image: identifiers', () => {
    expect(resolveAgentMark('image:../secret.png')).toEqual({ kind: 'monogram' });
    expect(resolveAgentMark('image:dir/sub.png')).toEqual({ kind: 'monogram' });
    expect(resolveAgentMark('image:\\bad.png')).toEqual({ kind: 'monogram' });
    expect(resolveAgentMark('image:')).toEqual({ kind: 'monogram' });
  });

  it('resolves known emblem IDs to kind: emblem', () => {
    expect(resolveAgentMark('anvil')).toEqual({
      kind: 'emblem',
      emblemId: 'anvil',
    });
    expect(resolveAgentMark('shield-check')).toEqual({
      kind: 'emblem',
      emblemId: 'shield-check',
    });
  });

  it('resolves portrait tokens to kind: portrait with agents/ path', () => {
    expect(resolveAgentMark('refiner')).toEqual({
      kind: 'portrait',
      imagePath: 'agents/refiner.png',
    });
    expect(resolveAgentMark('agent_smith')).toEqual({
      kind: 'portrait',
      imagePath: 'agents/agent_smith.png',
    });
  });

  it('falls back to monogram for unknown or malformed strings', () => {
    expect(resolveAgentMark('123invalid')).toEqual({ kind: 'monogram' });
    expect(resolveAgentMark('Has Spaces')).toEqual({ kind: 'monogram' });
  });
});

describe('markLabel', () => {
  it('labels custom images', () => {
    expect(markLabel('image:photo.png')).toBe('Custom image');
  });

  it('labels known emblems with their display name', () => {
    expect(markLabel('anvil')).toBe('Emblem · Anvil');
    expect(markLabel('shield-check')).toBe('Emblem · Shield check');
  });

  it('labels portraits', () => {
    expect(markLabel('refiner')).toBe('Portrait');
  });

  it('labels monograms/initials', () => {
    expect(markLabel(undefined)).toBe('Initial');
    expect(markLabel('monogram')).toBe('Initial');
  });
});

describe('defaultEmblemFor and isDefaultMark', () => {
  it('defaults builtin agents to their name as portrait token', () => {
    expect(defaultEmblemFor({ name: 'builder', builtin: true })).toBe('builder');
    expect(isDefaultMark({ name: 'builder', emblem: 'builder', builtin: true })).toBe(true);
    expect(isDefaultMark({ name: 'builder', emblem: 'anvil', builtin: true })).toBe(false);
    expect(isDefaultMark({ name: 'builder', emblem: undefined, builtin: true })).toBe(false);
  });

  it('defaults custom agents to undefined (initial monogram)', () => {
    expect(defaultEmblemFor({ name: 'my-agent', builtin: false })).toBeUndefined();
    expect(isDefaultMark({ name: 'my-agent', emblem: undefined, builtin: false })).toBe(true);
    expect(isDefaultMark({ name: 'my-agent', emblem: 'monogram', builtin: false })).toBe(true);
    expect(isDefaultMark({ name: 'my-agent', emblem: 'anvil', builtin: false })).toBe(false);
  });
});

describe('suggestedEmblemIds', () => {
  it('suggests relevant emblems based on name keywords', () => {
    expect(suggestedEmblemIds('pr-reviewer')).toContain('loupe');
    expect(suggestedEmblemIds('code-builder')).toContain('anvil');
    expect(suggestedEmblemIds('doc-writer')).toContain('quill');
    expect(suggestedEmblemIds('security-guard')).toContain('shield');
  });

  it('returns fallback suggestions for unrecognized names', () => {
    const fallback = suggestedEmblemIds('custom-xyz');
    expect(fallback).toHaveLength(4);
    expect(fallback).toContain('operator');
  });
});
