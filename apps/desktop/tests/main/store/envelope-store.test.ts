/**
 * EnvelopeStore is app-level only: a shared library of named custom envelopes.
 * These tests pin CRUD, validation rails, and duplicate naming.
 */

import { rmSync } from 'node:fs';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvelopeStore, validate } from '../../../src/main/store/envelopes.js';
import type { EnvelopeDef } from '../../../src/shared/types.js';

let dir: string;
let store: EnvelopeStore;

const def = (over: Partial<EnvelopeDef> = {}): EnvelopeDef => ({
  name: 'severity_report',
  description: 'A severity-tagged report',
  fields: [
    { name: 'severity', type: 'string', required: true, description: 'low|med|high' },
    { name: 'score', type: 'number', required: false },
  ],
  ...over,
});

beforeEach(() => {
  dir = tempDir('foundry-envelopes-');
  store = new EnvelopeStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('EnvelopeStore CRUD', () => {
  it('starts empty', () => {
    expect(store.list()).toEqual([]);
  });

  it('saves and lists a def', () => {
    const result = store.save(def());
    expect(result.ok).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.get('severity_report')?.fields).toHaveLength(2);
  });

  it('upserts by name rather than appending', () => {
    store.save(def());
    store.save(def({ description: 'updated', fields: [] }));
    expect(store.list()).toHaveLength(1);
    expect(store.get('severity_report')?.description).toBe('updated');
    expect(store.get('severity_report')?.fields).toEqual([]);
  });

  it('removes by name', () => {
    store.save(def());
    expect(store.remove('severity_report')).toEqual([]);
    expect(store.get('severity_report')).toBeNull();
  });

  it('duplicates with a unique name', () => {
    store.save(def());
    const copy = store.duplicate('severity_report');
    expect(copy?.name).toBe('severity_report-copy');
    expect(store.list()).toHaveLength(2);
    // A second duplicate gets a numeric suffix.
    const copy2 = store.duplicate('severity_report');
    expect(copy2?.name).toBe('severity_report-copy-2');
  });

  it('returns null when duplicating a missing name', () => {
    expect(store.duplicate('nope')).toBeNull();
  });
});

describe('envelope validation', () => {
  it('accepts a well-formed def', () => {
    expect(validate(def())).toEqual([]);
  });

  it('rejects a built-in kind name', () => {
    const issues = validate(def({ name: 'build' }));
    expect(issues.some((i) => i.where === 'name')).toBe(true);
    expect(issues[0]!.message).toContain('built-in');
  });

  it('rejects reserved base field names', () => {
    const issues = validate(
      def({
        fields: [{ name: 'status', type: 'string', required: true }],
      }),
    );
    expect(issues.some((i) => i.message.includes('reserved'))).toBe(true);
  });

  it('rejects an invalid name shape', () => {
    const issues = validate(def({ name: 'Bad Name' }));
    expect(issues.some((i) => i.where === 'name')).toBe(true);
  });

  it('rejects duplicate field names', () => {
    const issues = validate(
      def({
        fields: [
          { name: 'severity', type: 'string', required: true },
          { name: 'severity', type: 'number', required: false },
        ],
      }),
    );
    expect(issues.some((i) => i.message.includes('duplicate'))).toBe(true);
  });

  it('blocks save when validation fails', () => {
    const result = store.save(def({ name: 'review' }));
    expect(result.ok).toBe(false);
    expect(store.list()).toEqual([]);
  });
});
