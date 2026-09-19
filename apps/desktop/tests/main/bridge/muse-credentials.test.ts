/**
 * Muse credential store: multi-account persistence, compare-and-swap remints,
 * 0700/0600 permissions, and no token in the metadata that crosses IPC.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountFromCredentials,
  accountMeta,
  MuseCredentialStore,
  usableAPIKeys,
  type MuseCredentials,
} from '../../../src/main/bridge/muse-credentials.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-muse-store-'));
  dirs.push(dir);
  return dir;
}

function credentials(subject: string, key = 'test-key', revision = 0): MuseCredentials {
  const payload = Buffer.from(
    JSON.stringify({
      sub: subject,
      iss: 'test',
      email: `${subject}@example.test`,
      iat: revision,
    }),
  )
    .toString('base64url')
    .replace(/=+$/, '');
  return {
    identityToken: `header.${payload}.signature`,
    apiKey: key,
    apiKeyExpiresAt: 2_000_000_000,
  };
}

describe('MuseCredentialStore', () => {
  it('saves multiple accounts and keeps permissions tight', () => {
    const store = new MuseCredentialStore(tempDir());
    expect(store.save(credentials('alice'))).toBe(true);
    expect(store.save(credentials('bob'))).toBe(true);
    expect(store.accounts).toHaveLength(2);
    expect(store.accounts.map((account) => account.email)).toEqual([
      'alice@example.test',
      'bob@example.test',
    ]);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(store.accountsPath).mode & 0o777).toBe(0o600);
  });

  it('re-authenticating the same subject updates the key and keeps the id', () => {
    const store = new MuseCredentialStore(tempDir());
    expect(store.save(credentials('alice'))).toBe(true);
    const aliceId = store.accounts[0]!.id;
    expect(store.save(credentials('alice', 'new-key', 1))).toBe(true);
    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0]?.id).toBe(aliceId);
    expect(store.accounts[0]?.credentials.apiKey).toBe('new-key');
  });

  it('refuses to overwrite a corrupt store', () => {
    const dir = tempDir();
    const store = new MuseCredentialStore(dir);
    expect(store.save(credentials('alice'))).toBe(true);
    writeFileSync(store.accountsPath, 'not-json');
    expect(store.save(credentials('bob'))).toBe(false);
    expect(readFileSync(store.accountsPath, 'utf8')).toBe('not-json');
  });

  it('does not restore a removed account or overwrite a newer login on remint', () => {
    const store = new MuseCredentialStore(tempDir());
    expect(store.save(credentials('alice'))).toBe(true);
    const old = store.accounts[0]!;
    expect(store.save(credentials('alice', 'new-login', 1))).toBe(true);
    expect(store.updateKey(old, 'stale', 3_000_000_000)).toBe(false);
    expect(store.accounts[0]?.credentials.apiKey).toBe('new-login');
    const current = store.accounts[0]!;
    expect(store.remove(current.id)).toBe(true);
    expect(store.updateKey(current, 'resurrected', 3_000_000_000)).toBe(false);
    expect(store.accounts).toEqual([]);
  });

  it('exposes no token in account metadata', () => {
    const account = accountFromCredentials(credentials('alice', 'sk-secret-value'));
    const meta = accountMeta(account, 1_000);
    expect(JSON.stringify(meta)).not.toContain('sk-secret-value');
    expect(JSON.stringify(meta)).not.toContain(account.credentials.identityToken);
    expect(meta.label).toBe('alice@example.test');
  });

  it('treats an empty, disabled, or expired key as unusable, including expiry-at-now', () => {
    const valid = accountFromCredentials(credentials('valid'));
    const empty = accountFromCredentials(credentials('empty', ''));
    const expired: ReturnType<typeof accountFromCredentials> = {
      ...accountFromCredentials(credentials('expired')),
      credentials: {
        ...accountFromCredentials(credentials('expired')).credentials,
        apiKeyExpiresAt: 50,
      },
    };
    const disabled = { ...valid, disabled: true };
    expect(usableAPIKeys([valid, empty, expired, disabled], 100)).toEqual(['test-key']);
    expect(usableAPIKeys([valid], valid.credentials.apiKeyExpiresAt)).toEqual([]);
  });

  it('hashes iss:sub so two tokens for the same person collapse', () => {
    const a = accountFromCredentials(credentials('alice', 'one', 0));
    const b = accountFromCredentials(credentials('alice', 'two', 99));
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it('removeAll reports how many accounts left', () => {
    const store = new MuseCredentialStore(tempDir());
    expect(store.removeAll()).toBe(0);
    store.save(credentials('alice'));
    store.save(credentials('bob'));
    expect(store.removeAll()).toBe(2);
    expect(store.accounts).toEqual([]);
  });
});
