import { describe, expect, it } from 'vitest';
import { CLI_MARKS, providerMark } from '../src/renderer/components/BrandIcon.js';
import { providerOf } from '../src/main/droid/catalog.js';
import { CLI_VENDOR_IDS, type CliVendor } from '../src/shared/types.js';

describe('CLI marks', () => {
  it('covers every vendor the app can drive, and nothing else', () => {
    expect(Object.keys(CLI_MARKS).sort()).toEqual([...CLI_VENDOR_IDS].sort());
  });

  it('gives each vendor its own mark rather than a shared placeholder', () => {
    const marks = CLI_VENDOR_IDS.map((vendor) => CLI_MARKS[vendor]);
    expect(marks.every(Boolean)).toBe(true);
    expect(new Set(marks).size).toBe(CLI_VENDOR_IDS.length);
  });

  it('has a mark for droid, which lobehub does not publish', () => {
    // The regression this guards: droid is the default CLI, so dropping the
    // local Factory mark leaves the most-used vendor as the only blank one.
    expect(CLI_MARKS.droid).toBeDefined();
  });
});

describe('provider marks', () => {
  // Every branch of providerOf, which is the only thing that names a provider
  // for a droid model. A provider it can return but this file cannot draw would
  // leave the picker's icon slot empty for a model droid ships by default.
  const droidIds = [
    'claude-opus-4',
    'gpt-5-codex',
    'gemini-2.5-pro',
    'kimi-k2',
    'glm-4.6',
    'deepseek-v4-pro',
    'minimax-m3',
    'nemotron-3-ultra',
    'grok-4.5',
    'custom:meta:muse-spark-1.2',
    'inkling',
    'something-nobody-has-heard-of',
  ];

  it('draws every provider droid can report', () => {
    for (const id of droidIds) {
      expect(providerMark(providerOf(id)), `${id} -> ${providerOf(id)}`).toBeTruthy();
    }
  });

  it('draws every vendor used as its own provider', () => {
    // A CLI without a model catalog reports its vendor as the provider, so a
    // vendor id has to resolve here too.
    for (const vendor of CLI_VENDOR_IDS) {
      expect(providerMark(vendor), vendor).toBeTruthy();
    }
  });

  it("draws the providers behind junie's model aliases", () => {
    for (const provider of ['junie', 'claude', 'openai', 'gemini']) {
      expect(providerMark(provider), provider).toBeTruthy();
    }
  });

  it('matches regardless of case, because the name comes from a CLI', () => {
    expect(providerMark('OpenAI')).toBe(providerMark('openai'));
  });

  it('returns nothing for a provider it does not know', () => {
    // droid passes `modelProvider` through verbatim for session models, so an
    // unknown name is expected. An honest gap beats an anonymous glyph that
    // claims to be a brand.
    expect(providerMark('a-proxy-someone-configured')).toBeNull();
    expect(providerMark('')).toBeNull();
    expect(providerMark(null)).toBeNull();
  });
});

describe('unknown vendors', () => {
  it('falls back to droid, the way the adapter registry does', () => {
    expect(CLI_MARKS['retired-vendor' as CliVendor] ?? CLI_MARKS.droid).toBe(CLI_MARKS.droid);
  });
});
