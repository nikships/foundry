/**
 * Mapping pi's available models onto the picker's `ModelInfo`.
 *
 * The pure half is tested directly. `availableModels` and the credential calls
 * need a real `ModelRuntime`, which `tests/pi-runtime.test.ts` already builds;
 * duplicating that here would buy a slower suite rather than more coverage.
 */

import { describe, expect, it } from 'vitest';
import { modelKey, reasoningEffortsFor, toModelInfo } from '../src/main/pi/catalog.js';

type PiModel = Parameters<typeof toModelInfo>[0];

function model(overrides: Partial<PiModel> = {}): PiModel {
  return {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    api: 'anthropic-messages',
    provider: 'bridge-claude',
    baseUrl: 'http://127.0.0.1:37717',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    ...overrides,
  } as PiModel;
}

describe('the agent model catalog', () => {
  it('qualifies every id with its provider, which is what a roster stores', () => {
    expect(modelKey(model())).toBe('bridge-claude/claude-opus-5');
    // A bare id would be ambiguous the moment two providers offer the model.
    expect(modelKey(model({ provider: 'anthropic' }))).toBe('anthropic/claude-opus-5');
  });

  it('offers only the thinking levels the model’s map allows', () => {
    const efforts = reasoningEffortsFor(
      model({
        thinkingLevelMap: { off: null, minimal: null, low: 'low', high: 'high', max: 'max' },
      }),
    );
    expect(efforts).toEqual(['low', 'high', 'max']);
  });

  it('falls back to a conservative set without a map, and to off for a plain model', () => {
    expect(reasoningEffortsFor(model())).toEqual(['off', 'low', 'medium', 'high']);
    expect(reasoningEffortsFor(model({ reasoning: false }))).toEqual(['off']);
  });

  it('picks medium as the default when it is offered, and the first level otherwise', () => {
    expect(toModelInfo(model()).defaultReasoningEffort).toBe('medium');
    expect(
      toModelInfo(model({ thinkingLevelMap: { low: 'low', high: 'high' } })).defaultReasoningEffort,
    ).toBe('low');
  });

  it('marks a Bridge-routed model with its lab’s icon, not the bridge provider id', () => {
    // The provider id is `bridge-claude`, but the mark the picker draws has to
    // be Claude's: the model is a Claude, however it is reached.
    expect(toModelInfo(model()).provider).toBe('claude');
    expect(
      toModelInfo(model({ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', provider: 'bridge-codex' }))
        .provider,
    ).toBe('openai');
    expect(
      toModelInfo(model({ id: 'grok-4.6', name: 'Grok 4.6', provider: 'bridge-grok' })).provider,
    ).toBe('grok');
  });

  it('badges anything outside pi’s built-ins as custom', () => {
    expect(toModelInfo(model()).isCustom).toBe(true);
    expect(toModelInfo(model({ provider: 'anthropic' })).isCustom).toBe(false);
    expect(toModelInfo(model({ provider: 'openai' })).isCustom).toBe(false);
  });

  it('carries the context window through, which the gauge needs', () => {
    expect(toModelInfo(model()).contextWindow).toBe(1_000_000);
  });
});
