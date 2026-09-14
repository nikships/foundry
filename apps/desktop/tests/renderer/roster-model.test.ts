/**
 * The roster names a model by its catalog entry and badges it with the vendor
 * behind it. Both lookups go through the catalog rather than parsing the id,
 * so bridge-prefixed ids and disconnected providers behave honestly.
 */

import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@shared/types.js';
import { providerForModel, rosterModelLabel } from '@renderer/view-models/roster-model.js';

const models = [
  { id: 'anthropic/claude-sonnet-4', provider: 'anthropic' },
  { id: 'bridge-claude/claude-opus-4', provider: 'anthropic' },
  { id: 'openai/gpt-5', provider: 'openai' },
] as ModelInfo[];

describe('providerForModel', () => {
  it('reads the provider off the catalog entry, including bridge aliases', () => {
    expect(providerForModel('anthropic/claude-sonnet-4', models)).toBe('anthropic');
    expect(providerForModel('bridge-claude/claude-opus-4', models)).toBe('anthropic');
  });

  it('returns empty for models no connected provider offers', () => {
    expect(providerForModel('inherit', models)).toBe('');
    expect(providerForModel('gone/model', models)).toBe('');
    expect(providerForModel('openai/gpt-5', [])).toBe('');
  });
});

describe('rosterModelLabel', () => {
  it('names the inherit sentinel as the model default', () => {
    expect(rosterModelLabel('inherit', models)).toBe('default model');
  });

  it('labels catalog models with their display label', () => {
    expect(rosterModelLabel('openai/gpt-5', models)).toBe('gpt-5');
  });

  it('falls back to inherit for ids the catalog does not know', () => {
    expect(rosterModelLabel('gone/model', models)).toBe('inherit');
  });
});
