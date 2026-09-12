/**
 * A new report's name is the library key. These pin the gate that must refuse
 * a collision before autosave upserts and silently replaces the other report.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  commitCustomEnvelopeName,
  sanitizeEnvelopeName,
} from '@renderer/view-models/envelope-name.js';

const here = dirname(fileURLToPath(import.meta.url));
const editorSrc = readFileSync(
  join(here, '../..', 'src/renderer/components/pipeline/EnvelopesEditor.tsx'),
  'utf8',
);

describe('sanitizeEnvelopeName', () => {
  it('lowercases and strips to the store contract', () => {
    expect(sanitizeEnvelopeName('Beta')).toBe('beta');
    expect(sanitizeEnvelopeName('  severity report  ')).toBe('severity_report');
    expect(sanitizeEnvelopeName('2beta')).toBe('beta');
  });

  it('collapses junk to empty rather than inventing a name', () => {
    expect(sanitizeEnvelopeName('')).toBe('');
    expect(sanitizeEnvelopeName('___')).toBe('');
    expect(sanitizeEnvelopeName('123')).toBe('');
  });
});

describe('commitCustomEnvelopeName', () => {
  const library = ['beta', 'severity_report'];

  it('keeps a no-op commit, including after sanitizing', () => {
    expect(commitCustomEnvelopeName('my_envelope', 'my_envelope', library)).toEqual({
      status: 'unchanged',
      name: 'my_envelope',
    });
    expect(commitCustomEnvelopeName('My_Envelope', 'my_envelope', library)).toEqual({
      status: 'unchanged',
      name: 'my_envelope',
    });
  });

  it('applies a free name', () => {
    expect(commitCustomEnvelopeName('gamma', 'my_envelope', library)).toEqual({
      status: 'applied',
      name: 'gamma',
    });
  });

  it('refuses a name that already exists in the library', () => {
    expect(commitCustomEnvelopeName('beta', 'my_envelope', library)).toEqual({
      status: 'collision',
      name: 'beta',
    });
    expect(commitCustomEnvelopeName('Beta!', 'my_envelope', library)).toEqual({
      status: 'collision',
      name: 'beta',
    });
  });

  it('does not treat the draft’s own name as a collision even if it is already persisted', () => {
    expect(
      commitCustomEnvelopeName('my_envelope', 'my_envelope', [...library, 'my_envelope']),
    ).toEqual({ status: 'unchanged', name: 'my_envelope' });
  });

  it('rejects an empty repair', () => {
    expect(commitCustomEnvelopeName('***', 'my_envelope', library)).toEqual({ status: 'empty' });
  });
});

describe('EnvelopesEditor wiring', () => {
  it('runs the collision gate before the draft identity changes', () => {
    const commitName = editorSrc.slice(editorSrc.indexOf('const commitName'));
    expect(commitName).toContain('commitCustomEnvelopeName');
    expect(commitName).toContain("status === 'collision'");
    expect(commitName).not.toContain('upsertBy');
  });
});
