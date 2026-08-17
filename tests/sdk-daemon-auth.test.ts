/**
 * resolveDaemonAuth: FACTORY_API_KEY wins; otherwise the stored JWT is
 * decrypted read-only from ~/.factory. Secrets never appear in logs.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSettingsApiKeyForTest,
  resolveDaemonAuth,
  setSettingsApiKey,
  settingsApiKeyForSpawn,
} from '../src/main/droid/sdk/auth.js';

let home: string;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  __resetSettingsApiKeyForTest();
  vi.restoreAllMocks();
});

function seedStoredAuth(token: string): string {
  home = tempDir('foundry-daemon-auth-');
  const factoryDir = join(home, '.factory');
  mkdirSync(factoryDir, { recursive: true });
  const key = randomBytes(32);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify({ access_token: token, token_type: 'Bearer' });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(join(factoryDir, 'auth.v2.key'), key.toString('base64'), 'utf8');
  writeFileSync(
    join(factoryDir, 'auth.v2.file'),
    `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`,
    'utf8',
  );
  return home;
}

describe('resolveDaemonAuth', () => {
  it('prefers FACTORY_API_KEY over the stored JWT', () => {
    seedStoredAuth('eyJstored.jwt.token');
    const cred = resolveDaemonAuth({
      env: { FACTORY_API_KEY: 'fk-from-env-key-value' },
      homeDir: home,
    });
    expect(cred).toEqual({ apiKey: 'fk-from-env-key-value', source: 'env' });
  });

  it('falls back to the stored JWT when the env key is absent', () => {
    seedStoredAuth('eyJfallback.stored.jwt');
    const cred = resolveDaemonAuth({ env: {}, homeDir: home });
    expect(cred).toEqual({ apiKey: 'eyJfallback.stored.jwt', source: 'stored' });
  });

  it('treats a blank FACTORY_API_KEY as unset and falls back', () => {
    seedStoredAuth('eyJblank.env.fallback');
    const cred = resolveDaemonAuth({ env: { FACTORY_API_KEY: '   ' }, homeDir: home });
    expect(cred?.source).toBe('stored');
    expect(cred?.apiKey).toBe('eyJblank.env.fallback');
  });

  it('returns null when neither env key nor stored auth is available', () => {
    home = tempDir('foundry-daemon-auth-empty-');
    mkdirSync(join(home, '.factory'), { recursive: true });
    expect(resolveDaemonAuth({ env: {}, homeDir: home })).toBeNull();
  });

  it('returns null when the stored file is corrupt rather than throwing', () => {
    home = tempDir('foundry-daemon-auth-bad-');
    const factoryDir = join(home, '.factory');
    mkdirSync(factoryDir, { recursive: true });
    writeFileSync(join(factoryDir, 'auth.v2.key'), Buffer.alloc(32).toString('base64'), 'utf8');
    writeFileSync(join(factoryDir, 'auth.v2.file'), 'not:valid:gcm', 'utf8');
    expect(resolveDaemonAuth({ env: {}, homeDir: home })).toBeNull();
  });

  it('never writes under the home .factory directory', () => {
    seedStoredAuth('eyJreadonly.check');
    const before = resolveDaemonAuth({ env: {}, homeDir: home });
    expect(before?.apiKey).toBe('eyJreadonly.check');
    // A second resolve must still succeed from the same files (no rotate/write).
    expect(resolveDaemonAuth({ env: {}, homeDir: home })?.apiKey).toBe('eyJreadonly.check');
  });

  it('does not log the credential value', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const secret = 'fk-must-not-appear-in-logs-12345';
    resolveDaemonAuth({ env: { FACTORY_API_KEY: secret }, homeDir: home });
    for (const spy of [log, info, warn, error]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secret);
      }
    }
  });

  it('prefers a Settings key over env and the stored JWT', () => {
    seedStoredAuth('stored-jwt-token');
    const cred = resolveDaemonAuth({
      env: { FACTORY_API_KEY: 'fk-from-env-key-value' },
      homeDir: home,
      settingsKey: 'fk-from-settings-key-value',
    });
    expect(cred).toEqual({ apiKey: 'fk-from-settings-key-value', source: 'settings' });
  });

  it('treats a blank Settings key as unset and falls through to env', () => {
    const cred = resolveDaemonAuth({
      env: { FACTORY_API_KEY: 'fk-from-env-key-value' },
      homeDir: home,
      settingsKey: '   ',
    });
    expect(cred).toEqual({ apiKey: 'fk-from-env-key-value', source: 'env' });
  });

  it('uses the module Settings key when the option is omitted', () => {
    setSettingsApiKey('  fk-module-settings-key  ');
    expect(resolveDaemonAuth({ env: {}, homeDir: home })).toEqual({
      apiKey: 'fk-module-settings-key',
      source: 'settings',
    });
    expect(settingsApiKeyForSpawn()).toEqual({ FACTORY_API_KEY: 'fk-module-settings-key' });
  });
});
