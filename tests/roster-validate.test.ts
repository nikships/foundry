import { describe, expect, it } from 'vitest';
import { validate } from '../src/main/store/roster.js';
import type { AgentDef } from '../src/shared/types.js';

const base: AgentDef = {
  name: 'builder',
  purpose: 'Implements the plan.',
  model: 'inherit',
  reasoningEffort: 'medium',
  systemPrompt: 'Be careful.',
  userPrompt: 'Work on: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
};

describe('roster.validate', () => {
  it('accepts a well-formed agent including optional cli', () => {
    expect(validate({ ...base, cli: 'droid' })).toEqual([]);
  });

  it('coerces legacy or unknown cli values to droid during validation', () => {
    expect(validate({ ...base, cli: 'claude' as never })).toEqual([]);
  });

  it('rejects an invalid name and empty purpose before save', () => {
    const issues = validate({ ...base, name: 'Bad Name', purpose: '' });
    expect(issues.some((i) => i.where === 'name')).toBe(true);
    expect(issues.some((i) => i.where === 'purpose')).toBe(true);
    expect(issues.every((i) => i.level === 'error')).toBe(true);
  });

  it('rejects a colour that is not hex', () => {
    const issues = validate({ ...base, color: 'red' });
    expect(issues.some((i) => i.where === 'color')).toBe(true);
  });

  it('accepts a custom envelope name when it is known', () => {
    expect(validate({ ...base, envelope: 'severity_report' }, ['severity_report'])).toEqual([]);
  });

  it('warns (does not error) when the envelope name is unknown', () => {
    const issues = validate({ ...base, envelope: 'deleted_shape' }, []);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.level).toBe('warning');
    expect(issues[0]!.where).toBe('envelope');
  });
});
