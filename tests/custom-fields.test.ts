/**
 * Agent extra fields and envelope library fields are the same shape edited in
 * two places, so the rules live in one pure module. These pin the two failures
 * `agentSchema` accepts but the engine cannot honour: a duplicate name, and a
 * name that collides with a base field.
 */

import { describe, expect, it } from 'vitest';
import type { CustomEnvelopeField } from '../src/shared/types.js';
import {
  addField,
  fieldTypeLabel,
  nextFieldName,
  normalizeFieldName,
  patchField,
  removeField,
  shadowedLibraryFields,
  validateCustomFields,
} from '../src/renderer/custom-fields.js';

const field = (name: string, over: Partial<CustomEnvelopeField> = {}): CustomEnvelopeField => ({
  name,
  type: 'string',
  required: true,
  ...over,
});

describe('adding a field', () => {
  it('starts at `field` and never collides with an existing name', () => {
    expect(nextFieldName([])).toBe('field');
    expect(nextFieldName([field('field')])).toBe('field_2');
    expect(nextFieldName([field('field'), field('field_2')])).toBe('field_3');
  });

  it('skips a gap rather than reusing a taken name', () => {
    expect(nextFieldName([field('field'), field('field_3')])).toBe('field_2');
  });

  it('appends a required text field, which is the common case', () => {
    const next = addField([]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: 'field', type: 'string', required: true });
  });

  it('does not mutate the list it was given', () => {
    const original = [field('risk_level')];
    addField(original);
    expect(original).toHaveLength(1);
  });
});

describe('editing a field', () => {
  it('patches only the row addressed', () => {
    const fields = [field('a'), field('b')];
    const next = patchField(fields, 1, { type: 'number' });
    expect(next[0]!.type).toBe('string');
    expect(next[1]!.type).toBe('number');
  });

  it('removes by index, so duplicate names do not remove the wrong row', () => {
    const fields = [field('dup'), field('dup'), field('keep')];
    const next = removeField(fields, 0);
    expect(next).toHaveLength(2);
    expect(next.map((f) => f.name)).toEqual(['dup', 'keep']);
  });
});

describe('normalising a typed name', () => {
  it('lowercases and strips characters the schema rejects', () => {
    expect(normalizeFieldName('Risk Level!')).toBe('risklevel');
    expect(normalizeFieldName('risk_level')).toBe('risk_level');
    expect(normalizeFieldName('RISK-LEVEL')).toBe('risklevel');
  });

  it('strips leading digits and underscores, which cannot start a name', () => {
    expect(normalizeFieldName('2fast')).toBe('fast');
    expect(normalizeFieldName('_private')).toBe('private');
  });

  it('leaves an unsalvageable name empty rather than inventing one', () => {
    expect(normalizeFieldName('123')).toBe('');
    expect(normalizeFieldName('!!!')).toBe('');
  });
});

describe('validating fields', () => {
  it('accepts an empty or absent list', () => {
    expect(validateCustomFields([])).toEqual([]);
    expect(validateCustomFields(undefined)).toEqual([]);
  });

  it('accepts snake_case names', () => {
    expect(validateCustomFields([field('risk_level'), field('score_2')])).toEqual([]);
  });

  it('rejects a name that is not snake_case', () => {
    const issues = validateCustomFields([field('RiskLevel')]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.where).toBe('customFields.0.name');
    expect(issues[0]!.message).toContain('snake_case');
  });

  it('rejects an empty name', () => {
    expect(validateCustomFields([field('')])[0]!.message).toContain('needs a name');
  });

  it('rejects a base field name, which would replace the engine field', () => {
    for (const reserved of ['status', 'summary', 'artifacts', 'notes_for_next_agent']) {
      const issues = validateCustomFields([field(reserved)]);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toContain('base field');
    }
  });

  it('rejects a duplicate name, which the engine would silently collapse', () => {
    const issues = validateCustomFields([field('risk'), field('risk')]);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.where).toBe('customFields.1.name');
    expect(issues[0]!.message).toContain('duplicate');
  });

  it('reports each bad row separately so the rail is not truncated', () => {
    const issues = validateCustomFields([field('Bad'), field('ok'), field('ok')]);
    expect(issues.map((i) => i.where)).toEqual(['customFields.0.name', 'customFields.2.name']);
  });

  it('does not report a second empty name as a duplicate of the first', () => {
    const issues = validateCustomFields([field(''), field('')]);
    expect(issues).toHaveLength(2);
    for (const issue of issues) expect(issue.message).toContain('needs a name');
  });

  it('namespaces the path so an envelope editor can reuse it', () => {
    expect(validateCustomFields([field('Bad')], 'fields')[0]!.where).toBe('fields.0.name');
  });
});

describe('shadowing a library field', () => {
  it('names an agent field that overrides one on the envelope', () => {
    expect(shadowedLibraryFields([field('risk')], [field('risk'), field('other')])).toEqual([
      'risk',
    ]);
  });

  it('is empty when nothing collides', () => {
    expect(shadowedLibraryFields([field('a')], [field('b')])).toEqual([]);
  });

  it('is empty when either side is absent, e.g. a built-in envelope', () => {
    expect(shadowedLibraryFields(undefined, [field('a')])).toEqual([]);
    expect(shadowedLibraryFields([field('a')], undefined)).toEqual([]);
  });
});

describe('field type labels', () => {
  it('maps every schema type to plain language', () => {
    expect(fieldTypeLabel('string')).toBe('Text');
    expect(fieldTypeLabel('number')).toBe('Number');
    expect(fieldTypeLabel('boolean')).toBe('Yes-no');
    expect(fieldTypeLabel('string[]')).toBe('List of text');
  });
});
