/**
 * Airgap mode: droid runs BYOK-only, with no Factory credential and no request
 * ever aimed at a Factory endpoint.
 *
 * The three layers that must agree are covered here rather than in each of
 * their own suites, because the bug this guards against is exactly that they
 * disagree: a daemon that authenticates while the picker still offers hosted
 * models, or a doctor that blocks onboarding on a key the operator chose not
 * to have.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AIRGAP_TOKEN,
  __resetAirgapModeForTest,
  airgapEnabled,
  airgapEnvForSpawn,
  setAirgapMode,
} from '../src/main/droid/airgap.js';
import {
  __resetSettingsApiKeyForTest,
  resolveDaemonAuth,
  setSettingsApiKey,
} from '../src/main/droid/sdk/auth.js';
import { customOnly } from '../src/main/droid/catalog.js';
import { defaultSettings, migrate } from '../src/main/store/settings.js';
import { __setResolvedEnvForTest, setSpawnEnvExtra, spawnEnv } from '../src/main/system/env.js';
import type { ModelInfo } from '../src/shared/types.js';

let home = '';

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = '';
  __resetAirgapModeForTest();
  __resetSettingsApiKeyForTest();
  __setResolvedEnvForTest(null);
  setSpawnEnvExtra({});
});

/** A home with no `auth.v2.*` at all — the state airgap has to work from. */
function emptyHome(): string {
  home = tempDir('foundry-airgap-home-');
  mkdirSync(join(home, '.factory'), { recursive: true });
  return home;
}

const model = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: 'claude-opus-5',
  displayName: 'Claude Opus 5',
  provider: 'claude',
  supportedReasoningEfforts: [],
  defaultReasoningEffort: 'none',
  isCustom: false,
  deprecated: false,
  ...over,
});

describe('airgap daemon credentials', () => {
  it('yields a placeholder token when nothing else is configured', () => {
    const cred = resolveDaemonAuth({ env: {}, homeDir: emptyHome(), airgap: true });
    expect(cred).toEqual({ apiKey: AIRGAP_TOKEN, source: 'airgap' });
  });

  it('still returns null with no credential once airgap is off', () => {
    expect(resolveDaemonAuth({ env: {}, homeDir: emptyHome(), airgap: false })).toBeNull();
  });

  it('never sends a real key to a daemon that cannot verify it', () => {
    const cred = resolveDaemonAuth({
      env: { FACTORY_API_KEY: 'fk-env-key-value-here' },
      homeDir: emptyHome(),
      settingsKey: 'fk-settings-key-value',
      airgap: true,
    });
    expect(cred?.apiKey).toBe(AIRGAP_TOKEN);
    expect(cred?.source).toBe('airgap');
  });

  it('resolves a non-empty token, which is the one thing the daemon checks', () => {
    const cred = resolveDaemonAuth({ env: {}, homeDir: emptyHome(), airgap: true });
    expect(cred?.apiKey.length).toBeGreaterThan(0);
  });

  it('reads the module flag when the option is omitted', () => {
    setSettingsApiKey('fk-settings-key-value');
    expect(resolveDaemonAuth({ env: {}, homeDir: emptyHome() })?.source).toBe('settings');
    setAirgapMode(true);
    expect(resolveDaemonAuth({ env: {}, homeDir: emptyHome() })?.source).toBe('airgap');
  });
});

describe('airgap child environment', () => {
  it('adds FACTORY_AIRGAP_ENABLED only while the mode is on', () => {
    expect(airgapEnvForSpawn()).toEqual({});
    setAirgapMode(true);
    expect(airgapEnvForSpawn()).toEqual({ FACTORY_AIRGAP_ENABLED: '1' });
    setAirgapMode(false);
    expect(airgapEnvForSpawn()).toEqual({});
  });

  it('reaches a spawned child through the same overlay the API key uses', () => {
    __setResolvedEnvForTest({ path: '/custom/bin', via: 'login-shell' });
    setAirgapMode(true);
    setSpawnEnvExtra(airgapEnvForSpawn());
    expect(spawnEnv().FACTORY_AIRGAP_ENABLED).toBe('1');
    expect(spawnEnv().PATH).toBe('/custom/bin');
  });

  it('tracks the flag it was set with', () => {
    expect(airgapEnabled()).toBe(false);
    setAirgapMode(true);
    expect(airgapEnabled()).toBe(true);
  });

  /**
   * Mirrors the overlay `AppContext.syncFactoryAuth` writes. An airgapped child
   * gets the flag and no key: the CLI would ignore the key anyway, and an
   * operator who asked for no Factory credential should not have one reach a
   * subprocess.
   */
  it('withholds a stored Factory key from an airgapped child', () => {
    __setResolvedEnvForTest({ path: '/custom/bin', via: 'login-shell' });
    setSettingsApiKey('fk-settings-key-value');
    setAirgapMode(true);
    setSpawnEnvExtra(airgapEnvForSpawn());
    const env = spawnEnv();
    expect(env.FACTORY_AIRGAP_ENABLED).toBe('1');
    expect(env.FACTORY_API_KEY).toBeUndefined();
  });
});

describe('airgap model catalog', () => {
  it('drops every Factory-hosted model and keeps the BYOK ones', () => {
    const models = [
      model({ id: 'claude-opus-5' }),
      model({ id: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', provider: 'openai' }),
      model({ id: 'custom:local-qwen', displayName: 'Local Qwen', isCustom: true }),
    ];
    expect(customOnly(models).map((m) => m.id)).toEqual(['custom:local-qwen']);
  });

  it('returns an empty list rather than falling back to hosted models', () => {
    expect(customOnly([model(), model({ id: 'gpt-5.3-codex' })])).toEqual([]);
  });

  it('leaves a list that is already BYOK-only untouched', () => {
    const byok = [
      model({ id: 'custom:a', isCustom: true }),
      model({ id: 'custom:b', isCustom: true }),
    ];
    expect(customOnly(byok)).toHaveLength(2);
  });
});

describe('airgapMode setting', () => {
  it('defaults to off, so an existing install keeps its hosted models', () => {
    expect(defaultSettings().airgapMode).toBe(false);
  });

  it('is added to a settings file written before the mode existed', () => {
    const stored = { ...defaultSettings() } as Record<string, unknown>;
    delete stored.airgapMode;
    expect(migrate(stored).airgapMode).toBe(false);
  });

  it('survives a round trip once the operator turns it on', () => {
    expect(migrate({ ...defaultSettings(), airgapMode: true }).airgapMode).toBe(true);
  });

  it('falls back to off when a hand-edit leaves a non-boolean', () => {
    expect(migrate({ ...defaultSettings(), airgapMode: 'yes' }).airgapMode).toBe(false);
  });
});

describe('airgap credential handling', () => {
  it('does not read the stored JWT it was told to ignore', () => {
    home = tempDir('foundry-airgap-stored-');
    const factoryDir = join(home, '.factory');
    mkdirSync(factoryDir, { recursive: true });
    // Deliberately corrupt: a resolver that consulted these would return null.
    writeFileSync(join(factoryDir, 'auth.v2.key'), 'not-base64-at-all', 'utf8');
    writeFileSync(join(factoryDir, 'auth.v2.file'), 'garbage', 'utf8');
    expect(resolveDaemonAuth({ env: {}, homeDir: home, airgap: true })?.source).toBe('airgap');
  });
});
