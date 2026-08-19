import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../src/shared/types.js';
import { withoutHiddenModels } from '../src/shared/model-visibility.js';

function makeModel(id: string, displayName = id): ModelInfo {
  return {
    id,
    displayName,
    provider: id.split('/')[0] ?? 'anthropic',
    supportedReasoningEfforts: ['off', 'medium'],
    defaultReasoningEffort: 'medium',
    isCustom: false,
    deprecated: false,
    contextWindow: 200_000,
  };
}

describe('withoutHiddenModels', () => {
  const models: ModelInfo[] = [
    makeModel('bridge-claude/claude-opus-5', 'Claude Opus 5'),
    makeModel('bridge-claude/claude-sonnet-4', 'Claude Sonnet 4'),
    makeModel('openai/gpt-5', 'GPT-5'),
  ];

  it('returns a copy of all models when hidden list is empty', () => {
    const result = withoutHiddenModels(models, []);
    expect(result).toEqual(models);
    expect(result).not.toBe(models);
  });

  it('omits hidden model IDs', () => {
    const result = withoutHiddenModels(models, ['bridge-claude/claude-opus-5']);
    expect(result.map((m) => m.id)).toEqual(['bridge-claude/claude-sonnet-4', 'openai/gpt-5']);
  });

  it('omits multiple hidden model IDs', () => {
    const result = withoutHiddenModels(models, ['bridge-claude/claude-opus-5', 'openai/gpt-5']);
    expect(result.map((m) => m.id)).toEqual(['bridge-claude/claude-sonnet-4']);
  });

  it('ignores unknown hidden IDs without emptying the list', () => {
    const result = withoutHiddenModels(models, ['non-existent-provider/model-x']);
    expect(result.map((m) => m.id)).toEqual([
      'bridge-claude/claude-opus-5',
      'bridge-claude/claude-sonnet-4',
      'openai/gpt-5',
    ]);
  });

  it('does not mutate the input models or hiddenModelIds array', () => {
    const inputModels = [...models];
    const hiddenIds = ['bridge-claude/claude-opus-5'];
    Object.freeze(inputModels);
    Object.freeze(hiddenIds);
    expect(() => withoutHiddenModels(inputModels, hiddenIds)).not.toThrow();
    expect(inputModels).toHaveLength(3);
  });
});
