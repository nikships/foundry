import { describe, expect, it } from 'vitest';
import { validate } from '../../../src/main/store/roster.js';
import { resolveAgentExecution, type AgentDef } from '../../../src/shared/types.js';

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
  it('accepts a well-formed agent', () => {
    expect(validate(base)).toEqual([]);
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

  it('accepts inheritDefaults so the Execution checkbox can persist', () => {
    expect(validate({ ...base, inheritDefaults: true })).toEqual([]);
    expect(validate({ ...base, inheritDefaults: false })).toEqual([]);
  });
});

describe('resolveAgentExecution', () => {
  const defaults = { model: 'gpt-5.4', reasoningEffort: 'high' as const };

  it('follows Settings for both knobs when inheritDefaults is on', () => {
    expect(
      resolveAgentExecution(
        { model: 'claude-opus', reasoningEffort: 'low', inheritDefaults: true },
        defaults,
      ),
    ).toEqual({ model: 'gpt-5.4', reasoningEffort: 'high' });
  });

  it('lets the CLI pick the model when Settings also inherit', () => {
    expect(
      resolveAgentExecution(
        { model: 'claude-opus', reasoningEffort: 'low', inheritDefaults: true },
        { model: 'inherit', reasoningEffort: 'medium' },
      ),
    ).toEqual({ model: 'inherit', reasoningEffort: 'medium' });
  });

  it('inherits only the model when the checkbox is off', () => {
    expect(resolveAgentExecution({ model: 'inherit', reasoningEffort: 'low' }, defaults)).toEqual({
      model: 'gpt-5.4',
      reasoningEffort: 'low',
    });
  });

  it('keeps an explicit model and reasoning when nothing inherits', () => {
    expect(
      resolveAgentExecution({ model: 'claude-opus', reasoningEffort: 'max' }, defaults),
    ).toEqual({ model: 'claude-opus', reasoningEffort: 'max' });
  });
});

/**
 * `customFields` reaches the store from the agent editor and from a Smith
 * proposal, which validates through this same function before raising a card.
 * These pin what the schema does and does not catch — the gap the editor's own
 * checks cover (`src/renderer/custom-fields.ts`).
 */
describe('roster.validate on customFields', () => {
  const withFields = (customFields: AgentDef['customFields']): AgentDef => ({
    ...base,
    customFields,
  });

  it('accepts a well-formed field, so a Smith proposal carrying one passes', () => {
    expect(
      validate(
        withFields([
          { name: 'risk_level', type: 'string', required: true, description: 'low|med|high' },
        ]),
      ),
    ).toEqual([]);
  });

  it('accepts every supported type', () => {
    expect(
      validate(
        withFields([
          { name: 'a', type: 'string', required: true },
          { name: 'b', type: 'number', required: false },
          { name: 'c', type: 'boolean', required: true },
          { name: 'd', type: 'string[]', required: false },
        ]),
      ),
    ).toEqual([]);
  });

  it('rejects a name that is not snake_case', () => {
    const issues = validate(withFields([{ name: 'Risk Level', type: 'string', required: true }]));
    expect(issues.some((i) => i.where.startsWith('customFields'))).toBe(true);
    expect(issues.every((i) => i.level === 'error')).toBe(true);
  });

  it('rejects an unsupported type', () => {
    const issues = validate(withFields([{ name: 'due', type: 'date' as never, required: true }]));
    expect(issues.some((i) => i.where.startsWith('customFields'))).toBe(true);
  });

  it('accepts an absent list, which is every agent that adds nothing', () => {
    expect(validate(withFields(undefined))).toEqual([]);
  });

  /**
   * Documents a real gap rather than asserting desired behaviour: the schema is
   * per-field, so neither of these is caught here. The engine merges by name,
   * so both would silently collapse. The editor blocks them before save.
   */
  it('does NOT catch a duplicate name — the editor is what blocks it', () => {
    expect(
      validate(
        withFields([
          { name: 'x', type: 'string', required: true },
          { name: 'x', type: 'number', required: true },
        ]),
      ),
    ).toEqual([]);
  });

  it('does NOT catch a field shadowing a base field — likewise', () => {
    expect(validate(withFields([{ name: 'status', type: 'string', required: true }]))).toEqual([]);
  });
});
