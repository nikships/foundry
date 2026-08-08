import { describe, expect, it } from 'vitest';
import {
  mergeCustomModels,
  mergeSessionModels,
  isKnownModel,
  providerOf,
  type CustomModelEntry,
} from '../src/main/droid/catalog.js';
import type { ModelInfo } from '../src/shared/types.js';

const fromHelp: ModelInfo[] = [
  {
    id: 'custom:droidproxy:opus-5',
    displayName: 'DroidProxy: Opus 5',
    provider: 'claude',
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'none',
    isCustom: true,
    deprecated: false,
  },
];

const entry = (over: Partial<CustomModelEntry> = {}): CustomModelEntry => ({
  id: 'custom:droidproxy:opus-5',
  model: 'claude-opus-5',
  displayName: 'DroidProxy: Opus 5',
  ...over,
});

describe('mergeCustomModels', () => {
  it('keeps the id droid published rather than deriving one from the display name', () => {
    const models = mergeCustomModels(fromHelp, [entry()]);
    expect(models.map((m) => m.id)).toEqual(['custom:droidproxy:opus-5']);
    expect(models.some((m) => /custom:DroidProxy:-Opus-5-\d+/.test(m.id))).toBe(false);
  });

  it('never invents an entry for a settings record without an id', () => {
    const models = mergeCustomModels(fromHelp, [entry({ id: undefined })]);
    expect(models).toHaveLength(1);
    expect(models[0]!.id).toBe('custom:droidproxy:opus-5');
  });

  it('does not duplicate a model already listed by --help', () => {
    const models = mergeCustomModels(fromHelp, [entry(), entry()]);
    expect(models).toHaveLength(1);
  });

  it('carries reasoning efforts that --help omits for custom models', () => {
    const models = mergeCustomModels(fromHelp, [
      entry({
        supportedReasoningEfforts: ['low', 'high', 'xhigh'],
        defaultReasoningEffort: 'xhigh',
      }),
    ]);
    expect(models[0]!.supportedReasoningEfforts).toEqual(['low', 'high', 'xhigh']);
    expect(models[0]!.defaultReasoningEffort).toBe('xhigh');
  });

  it('adds a custom model that --help did not list, under its own id', () => {
    const models = mergeCustomModels(fromHelp, [
      entry({ id: 'custom:kimi-0', model: 'kimi-k3', displayName: 'kimi' }),
    ]);
    expect(models.map((m) => m.id).sort()).toEqual(['custom:droidproxy:opus-5', 'custom:kimi-0']);
  });

  it('leaves a roster model that names a real custom id resolvable', () => {
    const models = mergeCustomModels(fromHelp, [entry()]);
    expect(isKnownModel(models, 'custom:droidproxy:opus-5')).toBe(true);
    expect(isKnownModel(models, 'custom:DroidProxy:-Opus-5-2')).toBe(false);
  });
});

describe('mergeSessionModels', () => {
  it('lets a session record win over the help table for the same id', () => {
    const merged = mergeSessionModels(fromHelp, [
      {
        id: 'custom:droidproxy:opus-5',
        modelId: 'claude-opus-5',
        modelProvider: 'anthropic',
        displayName: 'DroidProxy: Opus 5',
        supportedReasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        isCustom: true,
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.supportedReasoningEfforts).toEqual(['high']);
  });
});

describe('providerOf', () => {
  it('reads the provider out of a custom id that carries the family name', () => {
    expect(providerOf('custom:droidproxy:opus-5', 'DroidProxy: Opus 5')).toBe('claude');
    expect(providerOf('custom:droidproxy:grok-4.5', 'DroidProxy: Grok 4.5')).toBe('grok');
  });
});
