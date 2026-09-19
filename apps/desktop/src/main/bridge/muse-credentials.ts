/**
 * Multi-account Meta Muse credential store.
 *
 * Mirrors droidproxy's `MetaMuseCredentialStore`: identity token + minted
 * Model API key, serialized under Foundry Application Support — never
 * `~/.droidproxy` or `~/.cli-proxy-api`. Tokens never leave this module;
 * callers receive account metadata or, through an explicit request, the
 * current usable API key so it can be written into pi's `meta` slot.
 *
 * Mutations are compare-and-swap. A late remint must not restore an account
 * the operator removed, or overwrite a newer login for the same subject.
 */

import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MUSE_PROVIDER_LABEL = 'Meta Muse';
export const MUSE_PROVIDER_ICON = 'meta';

export interface MuseCredentials {
  identityToken: string;
  apiKey: string;
  /** Unix seconds. */
  apiKeyExpiresAt: number;
}

export interface MuseAccount {
  id: string;
  email?: string;
  credentials: MuseCredentials;
  disabled: boolean;
}

/** The only account shape that may cross into status / IPC. */
export interface MuseAccountMeta {
  id: string;
  email?: string;
  label: string;
  expiresAt: string;
  expired: boolean;
  disabled: boolean;
}

const ACCOUNTS_FILE = 'accounts.json';

export function museStoreDir(supportDir: string): string {
  return join(supportDir, 'muse');
}

export class MuseCredentialStore {
  readonly directory: string;
  readonly accountsPath: string;

  constructor(directory: string) {
    this.directory = directory;
    this.accountsPath = join(directory, ACCOUNTS_FILE);
  }

  get accounts(): MuseAccount[] {
    try {
      return this.load();
    } catch {
      return [];
    }
  }

  get hasCredentials(): boolean {
    return this.accounts.length > 0;
  }

  hasUsableAPIKey(now = unixNow()): boolean {
    return usableAPIKeys(this.accounts, now).length > 0;
  }

  firstUsableApiKey(now = unixNow()): string | undefined {
    return usableAPIKeys(this.accounts, now)[0];
  }

  /** Persist credentials, matching an existing account by subject id. */
  save(credentials: MuseCredentials): boolean {
    const account = accountFromCredentials(credentials);
    return this.mutate((accounts) => {
      const index = accounts.findIndex((entry) => entry.id === account.id);
      if (index >= 0) {
        const existing = accounts[index]!;
        accounts[index] = {
          ...existing,
          credentials,
          email: account.email ?? existing.email,
        };
      } else {
        accounts.push(account);
      }
      return true;
    });
  }

  remove(id: string): boolean {
    return this.mutate((accounts) => {
      const next = accounts.filter((account) => account.id !== id);
      if (next.length === accounts.length) return false;
      accounts.length = 0;
      accounts.push(...next);
      return true;
    });
  }

  removeAll(): number {
    let removed = 0;
    this.mutate((accounts) => {
      removed = accounts.length;
      if (removed === 0) return false;
      accounts.length = 0;
      return true;
    });
    return removed;
  }

  /**
   * Compare-and-swap a reminted key. No-op when the snapshot no longer
   * matches — the account was removed or re-authenticated.
   */
  updateKey(snapshot: MuseAccount, apiKey: string, expiresAt: number): boolean {
    return this.mutate((accounts) => {
      const index = accounts.findIndex((account) => account.id === snapshot.id);
      if (index < 0) return false;
      const current = accounts[index]!;
      if (!credentialsEqual(current.credentials, snapshot.credentials)) return false;
      accounts[index] = {
        ...current,
        credentials: { ...current.credentials, apiKey, apiKeyExpiresAt: expiresAt },
      };
      return true;
    });
  }

  private load(): MuseAccount[] {
    let raw: string;
    try {
      raw = readFileSync(this.accountsPath, 'utf8');
    } catch {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('muse account store is malformed');
    return parsed.map(asAccount);
  }

  private mutate(update: (accounts: MuseAccount[]) => boolean): boolean {
    try {
      const accounts = this.load();
      if (!update(accounts)) return false;
      this.write(accounts);
      return true;
    } catch {
      return false;
    }
  }

  private write(accounts: MuseAccount[]): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    const rendered = `${JSON.stringify(accounts)}\n`;
    const tmp = join(dirname(this.accountsPath), `.accounts.json.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, rendered, { mode: 0o600 });
      renameSync(tmp, this.accountsPath);
      chmodSync(this.accountsPath, 0o600);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // Temp may never have been created.
      }
      throw error;
    }
  }
}

export function accountFromCredentials(credentials: MuseCredentials): MuseAccount {
  const claims = decodeJwtClaims(credentials.identityToken);
  const subject = asNonEmpty(claims.sub);
  const issuer = asNonEmpty(claims.iss) ?? '';
  const identity = subject ? `${issuer}:${subject}` : credentials.identityToken;
  const id = createHash('sha256').update(identity).digest('hex');
  const email = asNonEmpty(claims.email);
  return {
    id,
    ...(email ? { email } : {}),
    credentials,
    disabled: false,
  };
}

export function usableAPIKeys(accounts: readonly MuseAccount[], now = unixNow()): string[] {
  return accounts
    .filter((account) => !account.disabled && account.credentials.apiKeyExpiresAt > now)
    .map((account) => account.credentials.apiKey)
    .filter((key) => key.length > 0);
}

export function accountMeta(account: MuseAccount, now = unixNow()): MuseAccountMeta {
  const expiresAt = new Date(account.credentials.apiKeyExpiresAt * 1000).toISOString();
  return {
    id: account.id,
    ...(account.email ? { email: account.email } : {}),
    label: account.email ?? `Meta account ${account.id.slice(0, 8)}`,
    expiresAt,
    expired: account.credentials.apiKeyExpiresAt <= now,
    disabled: account.disabled,
  };
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function credentialsEqual(left: MuseCredentials, right: MuseCredentials): boolean {
  return (
    left.identityToken === right.identityToken &&
    left.apiKey === right.apiKey &&
    left.apiKeyExpiresAt === right.apiKeyExpiresAt
  );
}

function asAccount(value: unknown): MuseAccount {
  if (!isRecord(value)) throw new Error('muse account is malformed');
  if (typeof value.id !== 'string' || !value.id) throw new Error('muse account id is missing');
  if (!isRecord(value.credentials)) throw new Error('muse credentials are missing');
  const identityToken = asNonEmpty(
    value.credentials.identity_token ?? value.credentials.identityToken,
  );
  const apiKey = credentialString(value.credentials, 'api_key', 'apiKey') ?? '';
  const expires = credentialNumber(value.credentials, 'api_key_expires_at', 'apiKeyExpiresAt');
  if (!identityToken || expires === undefined) throw new Error('muse credentials are malformed');
  return {
    id: value.id,
    ...(asNonEmpty(value.email) ? { email: asNonEmpty(value.email) } : {}),
    credentials: { identityToken, apiKey, apiKeyExpiresAt: expires },
    disabled: value.disabled === true,
  };
}

function credentialString(
  record: Record<string, unknown>,
  snake: string,
  camel: string,
): string | undefined {
  const value = record[snake] ?? record[camel];
  return typeof value === 'string' ? value : undefined;
}

function credentialNumber(
  record: Record<string, unknown>,
  snake: string,
  camel: string,
): number | undefined {
  const value = record[snake] ?? record[camel];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function decodeJwtClaims(token: string): Record<string, string> {
  const parts = token.split('.');
  if (parts.length !== 3) return {};
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const parsed: unknown = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    if (!isRecord(parsed)) return {};
    const claims: Record<string, string> = {};
    for (const key of ['sub', 'iss', 'email'] as const) {
      const value = asNonEmpty(parsed[key]);
      if (value) claims[key] = value;
    }
    return claims;
  } catch {
    return {};
  }
}

function asNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
