import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { describe, expect, it } from 'vitest';
import { READINESS_CRITERION_IDS, type AgentReadyMarker } from '../src/shared/types.js';
import {
  markerFromEvaluation,
  parseMarkerText,
  readMarker,
  validateMarker,
  writeMarker,
} from '../src/main/readiness/marker.js';

function validMarker(over: Partial<AgentReadyMarker> = {}): AgentReadyMarker {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-11T05:00:00Z',
    commit: 'abc1234',
    agent: { harness: 'droid', model: 'inherit', reasoningEffort: 'high' },
    verdict: 'ready',
    summary: 'TypeScript repo is ready.',
    stack: { languages: ['typescript'], monorepo: false, packages: [] },
    criteria: READINESS_CRITERION_IDS.map((id) => ({
      id,
      status: id === 'typecheck' ? 'n/a' : 'pass',
      notes: id === 'typecheck' ? 'No type system applies.' : 'ok',
    })),
    ...over,
  };
}

describe('agent-ready marker validation', () => {
  it('accepts a complete schemaVersion 1 ready marker', () => {
    const result = validateMarker(validMarker());
    expect(result.ok).toBe(true);
    expect(result.marker?.verdict).toBe('ready');
  });

  it('rejects missing files as not ready', () => {
    const dir = tempDir('foundry-marker-missing-');
    const result = readMarker(dir);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('missing');
  });

  it('rejects corrupt JSON', () => {
    expect(parseMarkerText('{not json').ok).toBe(false);
  });

  it('rejects a schemaVersion mismatch', () => {
    const result = validateMarker({ ...validMarker(), schemaVersion: 2 });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/schemaVersion/i);
  });

  it('rejects a marker that still contains a failing criterion', () => {
    const marker = validMarker();
    marker.criteria = marker.criteria.map((c) => (c.id === 'tests' ? { ...c, status: 'fail' } : c));
    const result = validateMarker(marker);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('tests');
  });

  it('rejects a marker missing a required criterion', () => {
    const marker = validMarker();
    marker.criteria = marker.criteria.filter((c) => c.id !== 'coverage');
    expect(validateMarker(marker).ok).toBe(false);
  });

  it('round-trips a written marker from disk', () => {
    const dir = tempDir('foundry-marker-write-');
    mkdirSync(join(dir, '.agents'));
    writeMarker(dir, validMarker());
    const result = readMarker(dir);
    expect(result.ok).toBe(true);
    expect(result.marker?.summary).toContain('ready');
  });

  it('builds a marker from a passing evaluation', () => {
    const evaluation = {
      ready: true,
      summary: 'All green.',
      stack: { languages: ['go'], monorepo: false, packages: [] },
      criteria: READINESS_CRITERION_IDS.map((id) => ({
        id,
        status: 'pass' as const,
        notes: 'ok',
      })),
    };
    const marker = markerFromEvaluation(evaluation, {
      commit: 'def5678',
      generatedAt: '2026-08-12T00:00:00Z',
      model: 'inherit',
      reasoningEffort: 'high',
    });
    expect(validateMarker(marker).ok).toBe(true);
    expect(marker.commit).toBe('def5678');
  });

  it('treats a file that is not an object as invalid', () => {
    const dir = tempDir('foundry-marker-arr-');
    mkdirSync(join(dir, '.agents'));
    writeFileSync(join(dir, '.agents', 'agent-ready.json'), '[]\n');
    expect(readMarker(dir).ok).toBe(false);
  });
});
