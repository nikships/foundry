/**
 * Muse device-code login: mocked HTTPS, no Meta network, tokens stay out of
 * status payloads. The connect call returns once the device code is ready;
 * polling finishes in the background.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MuseAuthController, type MuseFetch } from '../../../src/main/bridge/muse-auth.js';
import { MuseCredentialStore } from '../../../src/main/bridge/muse-credentials.js';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-muse-auth-'));
  dirs.push(dir);
  return dir;
}

function jwt(subject: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: subject, iss: 'test', email: `${subject}@ex.test` }),
  )
    .toString('base64url')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

type Json = Record<string, unknown>;

function jsonResponse(
  status: number,
  body: Json,
): { status: number; json: () => Promise<unknown> } {
  return { status, json: async () => body };
}

function scriptedFetch(script: {
  authorize?: Json | { status: number; body: Json };
  token?: Array<Json | { status: number; body: Json }>;
  mint?: (identityToken: string) => Json | { status: number; body: Json };
}): MuseFetch {
  const tokens = [...(script.token ?? [])];
  return async (url, init) => {
    if (url.includes('/device/authorization/')) {
      const spec = script.authorize ?? {
        device_code: 'dev',
        user_code: 'ABCD-1234',
        verification_uri: 'https://www.meta.com/device',
        verification_uri_complete: 'https://www.meta.com/device?user_code=ABCD-1234',
        interval: 1,
        expires_in: 600,
      };
      return asResponse(spec);
    }
    if (url.includes('/device/token/')) {
      const next = tokens.shift() ?? { access_token: jwt('alice') };
      return asResponse(next);
    }
    if (url.includes('/muse-code/key')) {
      const auth = init.headers.Authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const spec = script.mint?.(token) ?? { api_key: 'muse-key' };
      return asResponse(spec);
    }
    return jsonResponse(404, { error: 'unknown' });
  };
}

function asResponse(spec: Json | { status: number; body: Json }): {
  status: number;
  json: () => Promise<unknown>;
} {
  if (isScriptedHttp(spec)) return jsonResponse(spec.status, spec.body);
  return jsonResponse(200, spec);
}

function isScriptedHttp(spec: Json | { status: number; body: Json }): spec is {
  status: number;
  body: Json;
} {
  if (!('status' in spec && 'body' in spec && typeof spec.status === 'number')) return false;
  const body = spec.body;
  return !!body && typeof body === 'object' && !Array.isArray(body);
}

async function waitFor(probe: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Muse login to settle');
}

describe('MuseAuthController', () => {
  it('returns once the device code is ready and then stores the minted key', async () => {
    const applied: Array<string | null> = [];
    const opened: string[] = [];
    const controller = new MuseAuthController({
      store: new MuseCredentialStore(tempDir()),
      fetch: scriptedFetch({}),
      openUrl: (url) => opened.push(url),
      applyApiKey: async (key) => {
        applied.push(key);
      },
      sleep: async () => undefined,
    });

    const result = await controller.connect();
    expect(result.ok).toBe(true);
    expect(controller.status().loginInFlight).toBe(true);
    expect(controller.status().loginPrompt?.userCode).toBe('ABCD-1234');
    expect(opened[0]).toContain('https://www.meta.com/device');
    expect(JSON.stringify(controller.status())).not.toContain(jwt('alice'));

    await waitFor(() => controller.status().authenticated);
    expect(controller.status().loginInFlight).toBe(false);
    expect(controller.status().accounts[0]?.label).toBe('alice@ex.test');
    expect(applied).toEqual(['muse-key']);
    expect(JSON.stringify(controller.status())).not.toContain('muse-key');
    expect(JSON.stringify(controller.status())).not.toContain(jwt('alice'));
  });

  it('rejects a verification URL that is not on meta.com', async () => {
    const controller = new MuseAuthController({
      store: new MuseCredentialStore(tempDir()),
      fetch: scriptedFetch({
        authorize: {
          device_code: 'dev',
          user_code: 'CODE',
          verification_uri: 'https://evil.example/device',
        },
      }),
    });
    const result = await controller.connect();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('invalid verification URL');
    expect(controller.status().loginInFlight).toBe(false);
  });

  it('surfaces access_denied without leaking a response body', async () => {
    const controller = new MuseAuthController({
      store: new MuseCredentialStore(tempDir()),
      fetch: scriptedFetch({
        token: [
          { status: 400, body: { error: 'access_denied', error_description: 'sensitive-body' } },
        ],
      }),
      sleep: async () => undefined,
    });
    await controller.connect();
    await waitFor(() => controller.status().loginError !== undefined);
    expect(controller.status().loginError).toContain('denied');
    expect(JSON.stringify(controller.status())).not.toContain('sensitive-body');
  });

  it('explains a mint that requires a payment method, without the action URL leaking as a token', async () => {
    const controller = new MuseAuthController({
      store: new MuseCredentialStore(tempDir()),
      fetch: scriptedFetch({
        mint: () => ({ action_url: 'https://www.meta.com/muse/pay' }),
      }),
      sleep: async () => undefined,
    });
    await controller.connect();
    await waitFor(() => controller.status().loginError !== undefined);
    expect(controller.status().loginError).toContain('payment method required');
  });

  it('cancels an in-flight sign-in and keeps existing accounts', async () => {
    const store = new MuseCredentialStore(tempDir());
    const existing = {
      identityToken: jwt('bob'),
      apiKey: 'existing-key',
      apiKeyExpiresAt: 2_000_000_000,
    };
    store.save(existing);
    let resolveToken: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveToken = resolve;
    });
    const controller = new MuseAuthController({
      store,
      fetch: async (url, init) => {
        if (url.includes('/device/authorization/')) {
          return jsonResponse(200, {
            device_code: 'dev',
            user_code: 'WAIT',
            verification_uri: 'https://www.meta.com/device',
          });
        }
        if (url.includes('/device/token/')) {
          await gate;
          return jsonResponse(200, { access_token: jwt('alice') });
        }
        return scriptedFetch({})(url, init);
      },
    });
    const started = controller.connect();
    await waitFor(() => controller.status().loginInFlight);
    expect(controller.cancel()).toBe(true);
    resolveToken?.();
    const result = await started;
    expect(result.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0]?.credentials.apiKey).toBe('existing-key');
    expect(controller.status().authenticated).toBe(true);
  });

  it('remints only due accounts and continues after one failure without echoing bodies', async () => {
    const store = new MuseCredentialStore(tempDir());
    const now = 1_000_000;
    for (const subject of ['bad', 'good'] as const) {
      store.save({
        identityToken: jwt(subject),
        apiKey: `old-${subject}`,
        apiKeyExpiresAt: now - 1,
      });
    }
    const applied: string[] = [];
    const controller = new MuseAuthController({
      store,
      now: () => now,
      fetch: async (url, init) => {
        if (!url.includes('/muse-code/key')) return jsonResponse(404, {});
        const token = (init.headers.Authorization ?? '').slice('Bearer '.length);
        if (token === jwt('good')) return jsonResponse(200, { api_key: 'new-good' });
        return jsonResponse(401, { error_description: 'sensitive-body' });
      },
      applyApiKey: async (key) => {
        if (key) applied.push(key);
      },
    });
    await controller.refreshIfNeeded();
    expect(store.accounts.map((account) => account.credentials.apiKey)).toEqual([
      'old-bad',
      'new-good',
    ]);
    expect(applied).toEqual(['new-good']);
    expect(controller.status().loginError).toContain('HTTP 401');
    expect(JSON.stringify(controller.status())).not.toContain('sensitive-body');
  });

  it('disconnects every account and clears the applied key', async () => {
    const store = new MuseCredentialStore(tempDir());
    store.save({
      identityToken: jwt('alice'),
      apiKey: 'keep-secret',
      apiKeyExpiresAt: 2_000_000_000,
    });
    const applied: Array<string | null> = [];
    const controller = new MuseAuthController({
      store,
      applyApiKey: async (key) => {
        applied.push(key);
      },
    });
    const result = await controller.disconnect();
    expect(result).toEqual({ ok: true, detail: 'signed out of 1 account' });
    expect(store.accounts).toEqual([]);
    expect(applied).toEqual([null]);
  });
});
