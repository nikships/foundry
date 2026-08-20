/**
 * Mapping pi's available models onto the picker's `ModelInfo`.
 *
 * The pure half is tested directly. `availableModels` and the credential calls
 * need a real `ModelRuntime`, which `tests/pi-runtime.test.ts` already builds;
 * duplicating that here would buy a slower suite rather than more coverage.
 */

import { describe, expect, it } from 'vitest';
import {
  modelKey,
  providerOf,
  reasoningEffortsFor,
  toModelInfo,
} from '../../../src/main/pi/catalog.js';

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

describe('providerOf', () => {
  it('reads the lab out of a proxied id that only carries the family name', () => {
    // A model reached through a proxy keeps its own identity in the id and the
    // display name; the provider id says who served it, which is not a brand.
    expect(providerOf('bridge-claude/opus-5', 'Opus 5')).toBe('claude');
    expect(providerOf('bridge-grok/grok-4.5', 'Grok 4.5')).toBe('grok');
  });

  it('covers every brand it can name, so the picker never has a blank mark', () => {
    expect(providerOf('gemini-2.5-pro')).toBe('gemini');
    expect(providerOf('gemma-3')).toBe('gemma');
    expect(providerOf('palm-2')).toBe('palm');
    expect(providerOf('kimi-k2')).toBe('kimi');
    expect(providerOf('glm-4.6')).toBe('zai');
    expect(providerOf('deepseek-v4-pro')).toBe('deepseek');
    expect(providerOf('minimax-m3')).toBe('minimax');
    expect(providerOf('nemotron-3-ultra')).toBe('nvidia');
    expect(providerOf('llama-4')).toBe('meta');
    expect(providerOf('gpt-5-codex')).toBe('openai');
  });

  it('falls back to openai for a name it cannot place', () => {
    // A wrong-but-drawn mark beats an empty slot: the picker's row would
    // otherwise be the only one with nothing where every other model has a logo.
    expect(providerOf('something-nobody-has-heard-of')).toBe('openai');
  });
});
