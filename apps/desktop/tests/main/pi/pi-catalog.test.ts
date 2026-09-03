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

  it('drops only the levels the map explicitly nulls out', () => {
    const efforts = reasoningEffortsFor(
      model({
        thinkingLevelMap: { off: null, minimal: null, low: 'low', high: 'high', max: 'max' },
      }),
    );
    // `medium` is absent from the map, which per `references/models.md` means
    // the provider's default mapping — supported, not withheld.
    expect(efforts).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('reads a partial map as an addition, not an allowlist', () => {
    // `{max: 'max'}` is the shape most current flagship models ship. Reading it
    // as an allowlist would leave `max` the only choice and quietly rewrite a
    // request for `medium` into the most expensive level the model has.
    expect(reasoningEffortsFor(model({ thinkingLevelMap: { max: 'max' } }))).toEqual([
      'off',
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(
      reasoningEffortsFor(model({ thinkingLevelMap: { xhigh: 'xhigh', max: 'max' } })),
    ).toEqual(['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('withholds the extended levels unless the map names them', () => {
    // Omitted means unsupported for `minimal` / `xhigh` / `max` — the one
    // place the tristate rule is not "absent implies available".
    expect(reasoningEffortsFor(model())).toEqual(['off', 'low', 'medium', 'high']);
    expect(reasoningEffortsFor(model({ thinkingLevelMap: { low: null } }))).toEqual([
      'off',
      'medium',
      'high',
    ]);
  });

  it('offers minimal only when the map names it, which is how Gemini 3.7 Flash arrives', () => {
    expect(
      reasoningEffortsFor(
        model({
          thinkingLevelMap: {
            off: null,
            minimal: 'minimal',
            low: 'low',
            medium: 'medium',
            high: 'high',
            xhigh: null,
            max: null,
          },
        }),
      ),
    ).toEqual(['minimal', 'low', 'medium', 'high']);
  });

  it('honours a model that cannot stop thinking, and one that never starts', () => {
    expect(reasoningEffortsFor(model({ thinkingLevelMap: { off: null } }))).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(reasoningEffortsFor(model({ reasoning: false }))).toEqual(['off']);
    // Nulling out every level still leaves something a picker can render.
    expect(
      reasoningEffortsFor(
        model({
          thinkingLevelMap: { off: null, low: null, medium: null, high: null },
        }),
      ),
    ).toEqual(['off']);
  });

  it('picks medium as the default when it is offered, and the first level otherwise', () => {
    expect(toModelInfo(model()).defaultReasoningEffort).toBe('medium');
    expect(
      toModelInfo(model({ thinkingLevelMap: { medium: null, low: 'low' } })).defaultReasoningEffort,
    ).toBe('off');
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

  it('badges anything Foundry does not ship as custom', () => {
    expect(toModelInfo(model()).isCustom).toBe(true);
    expect(toModelInfo(model({ provider: 'anthropic' })).isCustom).toBe(false);
    expect(toModelInfo(model({ provider: 'openai' })).isCustom).toBe(false);
    // A provider Foundry registers itself is shipped and reviewed like a
    // built-in, so it does not wear a Custom pill either.
    expect(
      toModelInfo(model({ id: 'muse-spark-1.3', name: 'Muse Spark 1.3', provider: 'meta' }))
        .isCustom,
    ).toBe(false);
  });

  it('carries the context window through, which the gauge needs', () => {
    expect(toModelInfo(model()).contextWindow).toBe(1_000_000);
  });

  it('carries catalog pricing through for evidence-based model casting', () => {
    const cost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
    expect(toModelInfo(model({ cost })).cost).toEqual(cost);
  });

  it('leaves pricing absent when the runtime model does not report it', () => {
    expect(toModelInfo(model({ cost: undefined })).cost).toBeUndefined();
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

  it('places Meta’s Model API ids, which name the family and not the lab', () => {
    // `muse-spark-1.3` says nothing about Meta, so a match on the corporate
    // name alone would leave every Muse model wearing the openai fallback.
    expect(providerOf('meta/muse-spark-1.3', 'Muse Spark 1.3')).toBe('meta');
    expect(providerOf('muse-spark-1.3-contributor')).toBe('meta');
  });

  it('falls back to openai for a name it cannot place', () => {
    // A wrong-but-drawn mark beats an empty slot: the picker's row would
    // otherwise be the only one with nothing where every other model has a logo.
    expect(providerOf('something-nobody-has-heard-of')).toBe('openai');
  });
});
