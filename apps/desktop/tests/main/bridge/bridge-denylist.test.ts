/**
 * The hand-maintained Bridge model denylist.
 *
 * The behaviour worth protecting is not which ids are listed today — that is
 * the operator's business and changes freely — but that editing the list is
 * safe: a stale id is inert, a new model is offered by default, and removing
 * a line restores the model.
 */

import { describe, expect, it } from 'vitest';
import {
  BRIDGE_MODEL_DENYLIST,
  isDeniedModel,
  type BridgeModelDenylist,
} from '../../../src/main/bridge/model-denylist.js';
import {
  loadBridgeCatalog,
  modelsForProvider,
  parseCliproxyCatalog,
} from '../../../src/main/bridge/catalog.js';
import { BRIDGE_PROVIDER_IDS } from '../../../src/main/bridge/providers.js';

describe('isDeniedModel', () => {
  const list: BridgeModelDenylist = { grok: ['grok-4.5'] };

  it('denies a listed id and offers everything else', () => {
    expect(isDeniedModel('grok', 'grok-4.5', list)).toBe(true);
    expect(isDeniedModel('grok', 'grok-4.6', list)).toBe(false);
  });

  it('scopes a denial to its own login', () => {
    expect(isDeniedModel('codex', 'grok-4.5', list)).toBe(false);
  });

  it('ignores case and stray whitespace on both sides', () => {
    expect(isDeniedModel('grok', '  GROK-4.5 ', list)).toBe(true);
    expect(isDeniedModel('grok', 'grok-4.5', { grok: [' Grok-4.5'] })).toBe(true);
  });

  it('treats a provider with no entry as fully offered', () => {
    expect(isDeniedModel('claude', 'claude-opus-5', list)).toBe(false);
    expect(isDeniedModel('claude', 'claude-opus-5', { claude: [] })).toBe(false);
  });

  it('never matches on a prefix, so a denied id cannot swallow a successor', () => {
    expect(isDeniedModel('grok', 'grok-4.5-turbo', list)).toBe(false);
    expect(isDeniedModel('grok', 'grok-4', list)).toBe(false);
  });
});

describe('modelsForProvider with a denylist', () => {
  const catalog = parseCliproxyCatalog({
    xai: [{ id: 'grok-4.6' }, { id: 'grok-4.5' }, { id: 'grok-3-mini' }],
  });

  it('drops the denied ids and keeps catalog order for the rest', () => {
    const ids = modelsForProvider(catalog, 'grok', {
      grok: ['grok-4.5', 'grok-3-mini'],
    }).map((model) => model.id);
    expect(ids).toEqual(['grok-4.6']);
  });

  it('is inert for an id that no longer ships, and denies nothing else', () => {
    // The whole point of a stale entry: a retired or mistyped id matches
    // nothing rather than throwing or taking a live model down with it.
    const ids = modelsForProvider(catalog, 'grok', {
      grok: ['grok-2-retired', 'typo-model', 'grok-4.5'],
    }).map((model) => model.id);
    expect(ids).toEqual(['grok-4.6', 'grok-3-mini']);
  });

  it('offers a model the denylist has never heard of', () => {
    const next = parseCliproxyCatalog({ xai: [{ id: 'grok-4.7' }] });
    expect(modelsForProvider(next, 'grok', BRIDGE_MODEL_DENYLIST).map((m) => m.id)).toEqual([
      'grok-4.7',
    ]);
  });

  it('restores a model when its line is removed', () => {
    expect(modelsForProvider(catalog, 'grok', {}).map((m) => m.id)).toEqual([
      'grok-4.6',
      'grok-4.5',
      'grok-3-mini',
    ]);
  });
});

/**
 * These read the vendored catalog, which is gitignored and absent unless
 * `fetch:bridge` has run, so they no-op in CI and assert locally.
 *
 * They deliberately do NOT pin the surviving id set. That set is upstream's to
 * change: CLIProxyAPI retiring `kimi-k2.7-code` or adding `kimi-k4` would fail
 * an exact assertion while nothing in Foundry was broken, and pinning it would
 * re-impose the very "a new model needs a Foundry edit" coupling the denylist
 * exists to avoid. What is Foundry's to guarantee is the intersection: no id
 * this file denies is ever offered.
 */
describe('the shipped denylist against the vendored catalog', () => {
  it('offers no denied id on any login', () => {
    const vendored = loadBridgeCatalog();
    if (Object.keys(vendored).length === 0) return;
    for (const provider of BRIDGE_PROVIDER_IDS) {
      const denied = new Set(
        (BRIDGE_MODEL_DENYLIST[provider] ?? []).map((id) => id.trim().toLowerCase()),
      );
      const leaked = modelsForProvider(vendored, provider)
        .map((model) => model.id)
        .filter((id) => denied.has(id.trim().toLowerCase()));
      expect(leaked).toEqual([]);
    }
  });

  it('leaves every login with something to run on', () => {
    const vendored = loadBridgeCatalog();
    if (Object.keys(vendored).length === 0) return;
    // A denylist that emptied a login would be a configuration mistake rather
    // than a filter, and the operator would find out at run time.
    for (const provider of BRIDGE_PROVIDER_IDS) {
      expect(modelsForProvider(vendored, provider).length).toBeGreaterThan(0);
    }
  });
});
