/**
 * The vendored Artificial Analysis score lookup.
 *
 * What matters here is the normalization, not the numbers: Foundry's ids are
 * provider-qualified and CLIProxyAPI mints one id per thinking level, while the
 * published index names each model once. A regression in the stripping rules
 * silently makes half the cast pool read "unrated".
 */

import { describe, expect, it } from 'vitest';
import { intelligenceFor, normalizeModelId } from '../../src/shared/model-intelligence.js';
import table from '../../src/shared/model-intelligence.json' with { type: 'json' };

describe('normalizeModelId', () => {
  it('strips the provider qualifier Foundry adds to every id', () => {
    expect(normalizeModelId('bridge-claude/claude-opus-5')).toBe('claudeopus5');
    expect(normalizeModelId('anthropic/claude-opus-5')).toBe('claudeopus5');
  });

  it('strips date stamps, preview tags, and OpenRouter batch suffixes', () => {
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claudehaiku4.5');
    expect(normalizeModelId('gemini-3-pro-preview')).toBe('gemini3pro');
    expect(normalizeModelId('anthropic/claude-opus-5:batch')).toBe('claudeopus5');
  });

  it('folds the effort variants CLIProxyAPI mints onto the measured model', () => {
    const base = normalizeModelId('gemini-3.5-flash');
    expect(normalizeModelId('gemini-3.5-flash-low')).toBe(base);
    expect(normalizeModelId('gemini-3.5-flash-extra-low')).toBe(base);
    expect(normalizeModelId('claude-opus-4-6-thinking')).toBe(normalizeModelId('claude-opus-4.6'));
  });

  it('reads a dash-separated version the same as a dotted one', () => {
    expect(normalizeModelId('claude-opus-4-5')).toBe(normalizeModelId('claude-opus-4.5'));
  });

  it('folds a billing tier onto the model it mirrors', () => {
    // Meta's contributor ids are the same weights at a lower price, so they
    // must not rank as unrated beside their identical twin.
    expect(normalizeModelId('meta/muse-spark-1.2-contributor')).toBe(
      normalizeModelId('meta/muse-spark-1.2'),
    );
    expect(intelligenceFor('meta/muse-spark-1.2-contributor')).toBe(
      intelligenceFor('meta/muse-spark-1.2'),
    );
  });
});

describe('intelligenceFor', () => {
  it('answers undefined rather than zero for an unrated id', () => {
    // A Bridge-minted variant exists in no published catalog and never will.
    expect(intelligenceFor('bridge-grok/grok-4.20-multi-agent-0309')).toBeUndefined();
    expect(intelligenceFor('')).toBeUndefined();
  });

  it('resolves a provider-qualified id against the vendored table', () => {
    const [key, score] = Object.entries(table.scores)[0]!;
    expect(intelligenceFor(`bridge-claude/${key}`)).toBe(score);
  });

  it('keeps the Artificial Analysis attribution their terms require', () => {
    expect(table.source).toContain('artificialanalysis.ai');
  });

  it('publishes scores in the index range rather than a normalized fraction', () => {
    const scores = Object.values(table.scores);
    expect(scores.length).toBeGreaterThan(50);
    for (const score of scores) {
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});
