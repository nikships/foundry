/**
 * Credential used to authenticate a local `droid daemon` WebSocket connection.
 *
 * Prefer `FACTORY_API_KEY` when set (fk-* keys are accepted on the wire).
 * Otherwise decrypt the WorkOS JWT the CLI stores under `~/.factory` —
 * read-only; this module never writes there and never logs the secret.
 *
 * Recipe verified against CLI 0.189 / SDK 0.7.0 (research/daemon.md):
 * AES-256-GCM over `iv:tag:ciphertext` with the 32-byte key at auth.v2.key.
 */

import { createDecipheriv } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type DaemonAuthSource = 'env' | 'stored';

export interface DaemonAuthCredential {
  /**
   * Opaque value for `connectToDaemon({ auth: { apiKey } })`.
   * May be an fk-* key or a WorkOS access token — never log or serialise it.
   */
  apiKey: string;
  source: DaemonAuthSource;
}

export interface ResolveDaemonAuthOptions {
  /** Defaults to `process.env`. Injected in tests. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to the real home directory. Injected so tests never touch ~/.factory. */
  homeDir?: string;
}

/**
 * Resolve a daemon auth credential without side effects.
 * Returns null when neither the env key nor a decryptable stored JWT is present.
 */
export function resolveDaemonAuth(
  opts: ResolveDaemonAuthOptions = {},
): DaemonAuthCredential | null {
  const env = opts.env ?? process.env;
  const fromEnv = env.FACTORY_API_KEY?.trim();
  if (fromEnv) return { apiKey: fromEnv, source: 'env' };

  const home = opts.homeDir ?? homedir();
  return readStoredJwt(home);
}

function readStoredJwt(homeDir: string): DaemonAuthCredential | null {
  const keyPath = join(homeDir, '.factory', 'auth.v2.key');
  const filePath = join(homeDir, '.factory', 'auth.v2.file');
  if (!existsSync(keyPath) || !existsSync(filePath)) return null;

  try {
    const keyB64 = readFileSync(keyPath, 'utf8').trim();
    const enc = readFileSync(filePath, 'utf8').trim();
    const key = Buffer.from(keyB64, 'base64');
    // AES-256-GCM requires a 32-byte key; anything else is corrupt storage.
    if (key.length !== 32) return null;

    const parts = enc.split(':');
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, ctB64] = parts;
    if (!ivB64 || !tagB64 || !ctB64) return null;

    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ciphertext = Buffer.from(ctB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain) as { access_token?: unknown };
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) return null;
    return { apiKey: parsed.access_token, source: 'stored' };
  } catch {
    // Corrupt key/file, bad JSON, or GCM auth failure — treat as missing.
    return null;
  }
}
