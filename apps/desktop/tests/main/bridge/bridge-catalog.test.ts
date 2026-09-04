/**
 * CLIProxyAPI catalog projection: a login unlocks every agent-usable model
 * in its channels, and a model that only exists in a channel we cannot
 * authenticate does not leak into another login.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  channelsForProvider,
  isAgentModel,
  loadBridgeCatalog,
  modelsForProvider,
  parseCliproxyCatalog,
} from '../../../src/main/bridge/catalog.js';

const fixture = parseCliproxyCatalog(
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/cliproxy-models.json'),
      'utf8',
    ),
  ),
);

describe('parseCliproxyCatalog', () => {
  it('ignores unknown top-level keys and entries without an id', () => {
    const catalog = parseCliproxyCatalog({
      claude: [{ id: 'claude-opus-5' }, { display_name: 'no id' }, 'skip'],
      notAnArray: { id: 'nope' },
      futureChannel: [{ id: 'whatever', extra: true }],
    });
    expect(Object.keys(catalog)).toEqual(['claude', 'futureChannel']);
    expect(catalog.claude?.map((m) => m.id)).toEqual(['claude-opus-5']);
  });

  it('treats garbage as an empty catalog rather than throwing', () => {
    expect(parseCliproxyCatalog(null)).toEqual({});
    expect(parseCliproxyCatalog('nope')).toEqual({});
  });
});

describe('channelsForProvider', () => {
  it('maps each login onto the catalog channels that login can actually serve', () => {
    const channels = [
      'claude',
      'antigravity',
      'gemini',
      'vertex',
      'aistudio',
      'kimi',
      'xai',
      'codex-free',
      'codex-pro',
      'codex-ultra',
    ];
    expect(channelsForProvider('claude', channels)).toEqual(['claude']);
    expect(channelsForProvider('gemini', channels)).toEqual(['antigravity']);
    expect(channelsForProvider('kimi', channels)).toEqual(['kimi']);
    expect(channelsForProvider('grok', channels)).toEqual(['xai']);
    // Richer Codex tiers first so a shared id keeps pro metadata; a future
    // tier we have never heard of still matches the prefix.
    expect(channelsForProvider('codex', channels)).toEqual([
      'codex-pro',
      'codex-free',
      'codex-ultra',
    ]);
  });
});

/**
 * Channel projection is what this suite covers, so it passes an empty denylist
 * throughout: the operator's shipped list is their preference and may change,
 * and a projection test that moved every time someone edited it would be
 * testing the wrong thing. The denylist has its own suite.
 */
const NO_DENYLIST = {};

describe('modelsForProvider', () => {
  it('lists every text-capable model a login unlocks, and none from other executors', () => {
    expect(modelsForProvider(fixture, 'gemini', NO_DENYLIST).map((m) => m.id)).toEqual([
      'gemini-3.7-flash-high',
      'claude-sonnet-4-6',
    ]);
    expect(modelsForProvider(fixture, 'grok', NO_DENYLIST).map((m) => m.id)).toEqual([
      'grok-4.6',
      'grok-4.5',
    ]);
    expect(modelsForProvider(fixture, 'claude', NO_DENYLIST).map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('picks up a model that only exists in a future Codex tier, without a Foundry edit', () => {
    const next = parseCliproxyCatalog({
      ...fixture,
      'codex-ultra': [{ id: 'gpt-5.9-orbit', display_name: 'GPT 5.9 Orbit' }],
    });
    expect(modelsForProvider(next, 'codex', NO_DENYLIST).map((m) => m.id)).toEqual([
      'gpt-5.5',
      'gpt-5.6-sol',
      'gpt-5.9-orbit',
    ]);
    expect(
      modelsForProvider(next, 'codex', NO_DENYLIST).find((m) => m.id === 'gpt-5.5')?.name,
    ).toBe('GPT 5.5');
  });

  it('drops image generators that an agent phase cannot speak', () => {
    expect(isAgentModel({ id: 'grok-imagine-image', supportedOutputModalities: ['image'] })).toBe(
      false,
    );
    // An image-generating Gemini declares text too — the commentary beside the
    // picture — so a text check alone let it into the picker and cast pool.
    expect(
      isAgentModel({
        id: 'gemini-3-pro-image',
        supportedOutputModalities: ['text', 'image'],
      }),
    ).toBe(false);
    expect(isAgentModel({ id: 'claude-opus-5', supportedOutputModalities: ['text'] })).toBe(true);
    expect(isAgentModel({ id: 'mystery' })).toBe(true);
  });

  it('keeps every image generator in the vendored catalog out of the picker', () => {
    const vendored = loadBridgeCatalog();
    if (Object.keys(vendored).length === 0) return;
    const offered = new Set(
      Object.values(vendored)
        .flat()
        .filter((model) => isAgentModel(model))
        .map((model) => model.id),
    );
    for (const id of ['imagen-4.0-generate-001', 'gemini-3-pro-image', 'gemini-2.5-flash-image']) {
      expect(offered.has(id)).toBe(false);
    }
  });

  it('projects the vendored CLIProxyAPI catalog when fetch:bridge has run', () => {
    const vendored = loadBridgeCatalog();
    if (Object.keys(vendored).length === 0) return;
    const antigravity = modelsForProvider(vendored, 'gemini', NO_DENYLIST).map((model) => model.id);
    const grok = modelsForProvider(vendored, 'grok', NO_DENYLIST).map((model) => model.id);
    expect(antigravity).toEqual(
      expect.arrayContaining([
        'gemini-3.7-flash-high',
        'gemini-3.6-flash-high',
        'gemini-3-flash',
        'gemini-pro-agent',
        'claude-sonnet-4-6',
        'claude-opus-4-6-thinking',
        'gpt-oss-120b-medium',
      ]),
    );
    expect(grok).toEqual(expect.arrayContaining(['grok-4.6', 'grok-4.5']));
    expect(antigravity.length).toBeGreaterThan(2);
    expect(grok.length).toBeGreaterThan(1);
  });

  it('copies Claude adaptive-thinking compat only onto the anthropic-messages login', () => {
    const opus = modelsForProvider(fixture, 'claude', NO_DENYLIST).find(
      (m) => m.id === 'claude-opus-5',
    );
    const antigravityClaude = modelsForProvider(fixture, 'gemini', NO_DENYLIST).find(
      (m) => m.id === 'claude-sonnet-4-6',
    );
    expect(opus?.compat).toEqual({ forceAdaptiveThinking: true, supportsStrictTools: true });
    expect(opus?.thinkingLevelMap).toMatchObject({
      off: null,
      minimal: null,
      low: 'low',
      max: 'max',
    });
    expect(antigravityClaude?.compat).toBeUndefined();
  });

  it('projects Gemini thinking levels from the catalog, including minimal and without off', () => {
    const flash = modelsForProvider(fixture, 'gemini', NO_DENYLIST).find(
      (model) => model.id === 'gemini-3.7-flash-high',
    );
    expect(flash?.thinkingLevelMap).toEqual({
      off: null,
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null,
    });
  });
});
