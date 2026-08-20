import { describe, expect, it } from 'vitest';
import { FoundryGlyph, PiGlyph, providerMark } from '@renderer/components/media/BrandIcon.js';
import { providerOf } from '@main/pi/catalog.js';
import { BRIDGE_PROVIDERS } from '@main/bridge/providers.js';

describe('app chrome marks', () => {
  it('draws Foundry and pi, neither of which lobehub publishes', () => {
    expect(FoundryGlyph).toBeTypeOf('function');
    expect(PiGlyph).toBeTypeOf('function');
    // Two distinct marks: the app and the harness it runs on are not the same
    // thing, and a shared glyph would say they are.
    expect(FoundryGlyph).not.toBe(PiGlyph);
  });
});

describe('provider marks', () => {
  // Every branch of providerOf, which is what names a provider for a model id.
  // A provider it can return but this file cannot draw would leave the picker's
  // icon slot empty for a model the app offers by default.
  const modelIds = [
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
    'something-nobody-has-heard-of',
  ];

  it('draws every provider the catalog can report', () => {
    for (const id of modelIds) {
      expect(providerMark(providerOf(id)), `${id} -> ${providerOf(id)}`).toBeTruthy();
    }
  });

  it('draws every icon key the Bridge provider table names', () => {
    // The Providers pane and the onboarding step both render `provider.icon`
    // straight off this table, so an unmapped key is a blank card header.
    for (const provider of BRIDGE_PROVIDERS) {
      expect(providerMark(provider.icon), `${provider.id} -> ${provider.icon}`).toBeTruthy();
    }
  });

  it('draws the providers a direct API key can be stored for', () => {
    // Mirrors KEY_PROVIDERS in SettingsScreen and ProvidersScreen.
    for (const provider of ['anthropic', 'openai', 'google', 'openrouter', 'xai']) {
      expect(providerMark(provider), provider).toBeTruthy();
    }
  });

  it("draws the providers behind junie's model aliases", () => {
    for (const provider of ['junie', 'claude', 'openai', 'gemini']) {
      expect(providerMark(provider), provider).toBeTruthy();
    }
  });

  it('matches regardless of case, because the name comes from a catalog', () => {
    expect(providerMark('OpenAI')).toBe(providerMark('openai'));
  });

  it('returns nothing for a provider it does not know', () => {
    // A catalog passes `provider` through verbatim, so an unknown name is
    // expected. An honest gap beats an anonymous glyph claiming to be a brand.
    expect(providerMark('a-proxy-someone-configured')).toBeNull();
    expect(providerMark('')).toBeNull();
    expect(providerMark(null)).toBeNull();
  });
});
