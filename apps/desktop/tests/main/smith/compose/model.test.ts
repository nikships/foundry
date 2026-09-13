import { describe, expect, it } from 'vitest';
import { resolveSmithModel } from '../../../../src/main/smith/compose/model.js';
import { defaultSettings } from '../../../../src/main/store/settings.js';

const settings = {
  smithModel: 'smith/model',
  smithReasoningEffort: 'high' as const,
  defaultModel: 'defaults/model',
  defaultReasoningEffort: 'low' as const,
};

describe.each(['chat', 'compose', 'repair'] as const)('resolveSmithModel(%s)', (purpose) => {
  it('prefers Smith to Agent Defaults, including its effort', () => {
    expect(resolveSmithModel(settings, purpose)).toEqual({
      model: 'smith/model',
      reasoningEffort: 'high',
    });
  });

  it.each(['', 'inherit'])('falls through a %j Smith model to Agent Defaults', (smithModel) => {
    expect(resolveSmithModel({ ...settings, smithModel }, purpose)).toEqual({
      model: 'defaults/model',
      reasoningEffort: 'low',
    });
  });

  it.each(['', 'inherit'])('keeps Smith effort when both tiers are %j', (model) => {
    expect(
      resolveSmithModel({ ...settings, smithModel: model, defaultModel: model }, purpose),
    ).toEqual({ model: 'inherit', reasoningEffort: 'high' });
  });

  it('honours independent model and effort overrides', () => {
    expect(resolveSmithModel(settings, purpose, { model: 'override/model' })).toEqual({
      model: 'override/model',
      reasoningEffort: 'high',
    });
    expect(resolveSmithModel(settings, purpose, { reasoningEffort: 'off' })).toEqual({
      model: 'smith/model',
      reasoningEffort: 'off',
    });
    expect(
      resolveSmithModel(settings, purpose, { model: 'override/model', reasoningEffort: 'medium' }),
    ).toEqual({ model: 'override/model', reasoningEffort: 'medium' });
  });

  it.each(['', 'inherit'])('treats an override of %j as following Smith', (model) => {
    expect(resolveSmithModel(settings, purpose, { model })).toEqual({
      model: 'smith/model',
      reasoningEffort: 'high',
    });
    expect(
      resolveSmithModel({ ...settings, smithModel: 'inherit' }, purpose, {
        model,
        reasoningEffort: 'off',
      }),
    ).toEqual({ model: 'defaults/model', reasoningEffort: 'off' });
  });

  it('resolves fresh-install settings without opening or requiring a model', () => {
    expect(resolveSmithModel(defaultSettings(), purpose)).toEqual({
      model: 'inherit',
      reasoningEffort: 'medium',
    });
  });
});
