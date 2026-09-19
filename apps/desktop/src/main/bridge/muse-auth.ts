/**
 * In-process Meta Muse device-code login.
 *
 * Reproduces `muse login` with three HTTPS calls and no child process:
 * device authorization and token polling against `auth.meta.com`, then
 * Model API key minting against `api.meta.ai/muse-code/key`. The minted
 * key is what pi's `meta` provider actually sends; the identity token is
 * kept only so a later remint does not need another sign-in.
 *
 * This contract matches droidproxy's `MetaMuseAuthManager`, reverse-engineered
 * from the installed `muse` CLI and `pi-meta-oauth`. Errors expose status
 * codes, never response bodies that could hold tokens.
 */

import type { BridgeAccount, BridgeLoginResult, BridgeProviderStatus } from './auth.js';
import { MUSE_PROVIDER_ID } from './providers.js';
import {
  accountMeta,
  unixNow,
  type MuseAccount,
  type MuseCredentialStore,
  type MuseCredentials,
  MUSE_PROVIDER_ICON,
  MUSE_PROVIDER_LABEL,
} from './muse-credentials.js';

const CLIENT_ID = '1031625952748946';
const DEVICE_AUTHORIZATION_URL = 'https://auth.meta.com/oidc/device/authorization/';
const DEVICE_TOKEN_URL = 'https://auth.meta.com/oidc/device/token/';
const MINT_URL = 'https://api.meta.ai/muse-code/key';
const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Minted keys are treated as valid for a day, matching the reference client. */
const MUSE_API_KEY_TTL_SECONDS = 24 * 60 * 60;
/** Remint this far ahead of expiry so a request never races an expiring key. */
const MUSE_REFRESH_MARGIN_SECONDS = 6 * 60 * 60;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 15 * 60;

interface MuseLoginPrompt {
  userCode: string;
  verificationUri: string;
}

export type MuseFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface MuseAuthOptions {
  store: MuseCredentialStore;
  fetch?: MuseFetch;
  openUrl?: (url: string) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Writes the current usable key into pi's `meta` slot, or clears it. */
  applyApiKey?: (apiKey: string | null) => Promise<void>;
  onChange?: () => void;
}

export class MuseAuthController {
  private readonly store: MuseCredentialStore;
  private readonly fetchFn: MuseFetch;
  private readonly openUrl?: (url: string) => void;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly applyApiKey?: (apiKey: string | null) => Promise<void>;
  private readonly onChange?: () => void;
  private abort: AbortController | null = null;
  private prompt: MuseLoginPrompt | null = null;
  private lastError: string | null = null;

  constructor(opts: MuseAuthOptions) {
    this.store = opts.store;
    this.fetchFn = opts.fetch ?? defaultFetch;
    this.openUrl = opts.openUrl;
    this.sleepFn = opts.sleep ?? abortableSleep;
    this.now = opts.now ?? unixNow;
    this.applyApiKey = opts.applyApiKey;
    this.onChange = opts.onChange;
  }

  get loginInFlight(): boolean {
    return this.abort !== null;
  }

  status(): BridgeProviderStatus {
    const now = this.now();
    const accounts = this.store.accounts.map((account) => toBridgeAccount(account, now));
    return {
      id: MUSE_PROVIDER_ID,
      label: MUSE_PROVIDER_LABEL,
      icon: MUSE_PROVIDER_ICON,
      authenticated: accounts.some((account) => !account.disabled && !account.expired),
      accounts,
      loginInFlight: this.loginInFlight,
      ...(this.prompt ? { loginPrompt: this.prompt } : {}),
      ...(this.lastError ? { loginError: this.lastError } : {}),
      bridgeRequired: false,
    };
  }

  /**
   * Starts device authorization and returns once the browser is open.
   * Polling continues in the background; completion is observed via `onChange`.
   */
  async connect(): Promise<BridgeLoginResult> {
    this.cancel();
    this.lastError = null;
    const abort = new AbortController();
    this.abort = abort;
    this.prompt = null;
    this.onChange?.();

    try {
      const device = await requestDeviceAuthorization(this.fetchFn, abort.signal);
      const verificationUri = validVerificationUri(device);
      if (!verificationUri) {
        return this.failConnect('Could not start Meta sign-in: invalid verification URL');
      }
      this.prompt = { userCode: device.userCode, verificationUri };
      this.openUrl?.(verificationUri);
      this.onChange?.();
      void this.completeInBackground(device, abort);
      return {
        ok: true,
        detail:
          'Complete Meta sign-in with the device code shown. Foundry picks up the account when it lands.',
      };
    } catch (error) {
      if (abort.signal.aborted) {
        return { ok: false, detail: 'Meta sign-in was cancelled' };
      }
      return this.failConnect(message(error, 'Could not start Meta sign-in'));
    }
  }

  async disconnect(): Promise<{ ok: boolean; detail: string }> {
    this.cancel();
    const removed = this.store.removeAll();
    if (removed > 0) {
      await this.safeApply(null);
      this.onChange?.();
    }
    return removed > 0
      ? {
          ok: true,
          detail: `signed out of ${removed} ${removed === 1 ? 'account' : 'accounts'}`,
        }
      : { ok: false, detail: 'there was no account to sign out of' };
  }

  cancel(): boolean {
    if (!this.abort) return false;
    this.abort.abort();
    this.abort = null;
    this.prompt = null;
    this.lastError = null;
    this.onChange?.();
    return true;
  }

  /** Remint keys that are inside the refresh margin. Does not throw. */
  async refreshIfNeeded(): Promise<void> {
    const now = this.now();
    const due = this.store.accounts.filter(
      (account) =>
        !account.disabled &&
        now >= account.credentials.apiKeyExpiresAt - MUSE_REFRESH_MARGIN_SECONDS,
    );
    if (due.length === 0) return;
    let changed = false;
    for (const account of due) {
      try {
        const apiKey = await mintApiKey(this.fetchFn, account.credentials.identityToken);
        if (this.store.updateKey(account, apiKey, now + MUSE_API_KEY_TTL_SECONDS)) {
          changed = true;
        }
      } catch (error) {
        this.lastError = message(error, 'Could not obtain a Meta Model API key');
      }
    }
    if (changed) {
      await this.applyCurrentKey();
      this.onChange?.();
    }
  }

  private async completeInBackground(
    device: DeviceAuthorization,
    abort: AbortController,
  ): Promise<void> {
    try {
      const identityToken = await pollForToken(this.fetchFn, this.sleepFn, device, abort.signal);
      const apiKey = await mintApiKey(this.fetchFn, identityToken, abort.signal);
      if (abort.signal.aborted || this.abort !== abort) return;
      const credentials: MuseCredentials = {
        identityToken,
        apiKey,
        apiKeyExpiresAt: this.now() + MUSE_API_KEY_TTL_SECONDS,
      };
      if (!this.store.save(credentials)) {
        this.finishFlight(
          abort,
          'Could not obtain a Meta Model API key: could not save credentials',
        );
        return;
      }
      await this.applyCurrentKey();
      this.finishFlight(abort);
    } catch (error) {
      if (abort.signal.aborted || this.abort !== abort) return;
      this.finishFlight(abort, message(error, 'Meta sign-in failed'));
    }
  }

  private failConnect(detail: string): BridgeLoginResult {
    this.abort = null;
    this.prompt = null;
    this.lastError = detail;
    this.onChange?.();
    return { ok: false, detail };
  }

  private finishFlight(abort: AbortController, error?: string): void {
    if (this.abort !== abort) return;
    this.abort = null;
    this.prompt = null;
    this.lastError = error ?? null;
    this.onChange?.();
  }

  private async applyCurrentKey(): Promise<void> {
    const key = this.store.firstUsableApiKey(this.now());
    if (key) await this.safeApply(key);
  }

  private async safeApply(apiKey: string | null): Promise<void> {
    if (!this.applyApiKey) return;
    try {
      await this.applyApiKey(apiKey);
    } catch (error) {
      console.warn(`[muse] could not update the Meta API key: ${message(error, 'apply failed')}`);
    }
  }
}

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
}

async function requestDeviceAuthorization(
  fetchFn: MuseFetch,
  signal: AbortSignal,
): Promise<DeviceAuthorization> {
  const response = await fetchFn(DEVICE_AUTHORIZATION_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formBody({ client_id: CLIENT_ID }),
    signal,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Could not start Meta sign-in: HTTP ${response.status}`);
  }
  const parsed = asRecord(await response.json());
  const deviceCode = asNonEmpty(parsed?.device_code);
  const userCode = asNonEmpty(parsed?.user_code);
  const verificationUri = asNonEmpty(parsed?.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error('Could not start Meta sign-in: malformed response');
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: asNonEmpty(parsed?.verification_uri_complete),
    expiresIn: asPositiveNumber(parsed?.expires_in),
    interval: asPositiveNumber(parsed?.interval),
  };
}

function validVerificationUri(device: DeviceAuthorization): string | null {
  const candidate = device.verificationUriComplete ?? device.verificationUri;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'meta.com' && !host.endsWith('.meta.com')) return null;
  return url.toString();
}

async function pollForToken(
  fetchFn: MuseFetch,
  sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
  device: DeviceAuthorization,
  signal: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + (device.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000;
  let interval = Math.max(1, device.interval ?? DEFAULT_POLL_INTERVAL_SECONDS);

  while (!signal.aborted) {
    if (Date.now() >= deadline) throw new Error('Meta sign-in request expired. Please try again.');

    const response = await fetchFn(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody({
        grant_type: DEVICE_CODE_GRANT,
        device_code: device.deviceCode,
        client_id: CLIENT_ID,
      }),
      signal,
    });
    const parsed = asRecord(await response.json().catch(() => null));
    const access = asNonEmpty(parsed?.access_token);
    if (response.status >= 200 && response.status < 300 && access) return access;

    const error = asNonEmpty(parsed?.error);
    switch (error) {
      case 'authorization_pending':
        await sleepFn(interval * 1000, signal);
        break;
      case 'slow_down':
        interval += 5;
        await sleepFn(interval * 1000, signal);
        break;
      case 'access_denied':
        throw new Error('Meta sign-in was denied.');
      case 'expired_token':
        throw new Error('Meta sign-in request expired. Please try again.');
      default:
        throw new Error(`Meta sign-in failed: HTTP ${response.status}`);
    }
  }
  throw new Error('Meta sign-in was cancelled');
}

async function mintApiKey(
  fetchFn: MuseFetch,
  identityToken: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetchFn(MINT_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identityToken}`,
      'x-api-version': '1.0.0',
    },
    body: '{}',
    ...(signal ? { signal } : {}),
  });
  const parsed = asRecord(await response.json().catch(() => null));
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Could not obtain a Meta Model API key: HTTP ${response.status}`);
  }
  const apiKey = asNonEmpty(parsed?.api_key);
  if (apiKey) return apiKey;
  if (asNonEmpty(parsed?.action_url)) {
    throw new Error(
      'Could not obtain a Meta Model API key: payment method required; complete setup in Meta Muse',
    );
  }
  throw new Error('Could not obtain a Meta Model API key: no API key was issued');
}

function toBridgeAccount(account: MuseAccount, now: number): BridgeAccount {
  const meta = accountMeta(account, now);
  return {
    id: meta.id,
    provider: MUSE_PROVIDER_ID,
    label: meta.label,
    expiresAt: meta.expiresAt,
    expired: meta.expired,
    disabled: meta.disabled,
  };
}

async function defaultFetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Meta sign-in was cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Meta sign-in was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString().replace(/\+/g, '%2B');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function message(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
