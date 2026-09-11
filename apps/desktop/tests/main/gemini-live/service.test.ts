/**
 * GeminiLiveService: the stored key, the mint seam, and the token payload.
 * No network: minting goes through the injected test seam, and the key never
 * appears in any value the service returns.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
  },
}));

const { GeminiLiveCredentialStore } = await import('../../../src/main/gemini-live/credentials.js');
const { GeminiLiveService, GEMINI_LIVE_MODEL } =
  await import('../../../src/main/gemini-live/service.js');
type GeminiLiveServiceInstance = InstanceType<typeof GeminiLiveService>;

function store(mint?: (apiKey: string) => Promise<string>): {
  service: GeminiLiveServiceInstance;
  file: string;
} {
  const support = tempDir('foundry-gemini-live-');
  const file = join(support, 'credentials', 'gemini-live-api-key.bin');
  const credentials = new GeminiLiveCredentialStore(file, {
    available: () => true,
    encrypt: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decrypt: (value: Buffer) => value.toString().split('').reverse().join(''),
  });
  return { service: new GeminiLiveService({ credentials, ...(mint ? { mint } : {}) }), file };
}

describe('GeminiLiveCredentialStore', () => {
  it('round-trips the key without persisting it in the clear', () => {
    const support = tempDir('foundry-gemini-live-');
    const file = join(support, 'credentials', 'gemini-live-api-key.bin');
    const credentials = new GeminiLiveCredentialStore(file, {
      available: () => true,
      encrypt: (value: string) => Buffer.from(value.split('').reverse().join('')),
      decrypt: (value: Buffer) => value.toString().split('').reverse().join(''),
    });
    const key = 'AIza_real_secret_value';
    credentials.set(key);
    expect(credentials.has()).toBe(true);
    expect(credentials.get()).toBe(key);
    expect(readFileSync(file, 'utf8')).not.toContain(key);
    credentials.clear();
    expect(credentials.has()).toBe(false);
  });

  it('fails closed when OS encryption is unavailable', () => {
    const credentials = new GeminiLiveCredentialStore(join(tempDir('foundry-gemini-live-'), 'k'), {
      available: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => '',
    });
    expect(() => credentials.set('secret')).toThrow('Secure credential storage is unavailable');
  });
});

describe('GeminiLiveService', () => {
  it('reports unset state until a key is saved, and never echoes the key', async () => {
    const { service } = store();
    expect(service.state()).toMatchObject({ keySet: false });
    const saved = await service.setApiKey('  AIza_saved  ');
    expect(saved).toMatchObject({ ok: true });
    expect(JSON.stringify(service.state())).not.toContain('AIza_saved');
    expect(service.state()).toMatchObject({ keySet: true });
  });

  it('refuses an empty key and clears on request', async () => {
    const { service } = store();
    expect(await service.setApiKey('   ')).toMatchObject({ ok: false });
    await service.setApiKey('AIza_saved');
    const cleared = await service.clearApiKey();
    expect(cleared).toMatchObject({ ok: true });
    expect(service.state()).toMatchObject({ keySet: false });
  });

  it('mints a token that carries the model and persona but never the key', async () => {
    const { service } = store(async () => 'tokens/ephemeral-1');
    await service.setApiKey('AIza_real_secret_value');
    const minted = await service.mintToken();
    expect('error' in minted).toBe(false);
    if ('error' in minted) return;
    expect(minted.token).toBe('tokens/ephemeral-1');
    expect(minted.model).toBe(GEMINI_LIVE_MODEL);
    expect(minted.systemInstruction).toContain('smith_delegate');
    expect(JSON.stringify(minted)).not.toContain('AIza_real_secret_value');
  });

  it('refuses to mint with no stored key, and surfaces mint failures', async () => {
    const { service } = store();
    const refused = await service.mintToken();
    expect('error' in refused).toBe(true);
    if (!('error' in refused)) return;
    expect(refused.error).toContain('No Gemini API key');

    const support = tempDir('foundry-gemini-live-');
    const credentials = new GeminiLiveCredentialStore(
      join(support, 'credentials', 'gemini-live-api-key.bin'),
      {
        available: () => true,
        encrypt: (value: string) => Buffer.from(value),
        decrypt: (value: Buffer) => value.toString(),
      },
    );
    credentials.set('AIza_saved');
    const failing = new GeminiLiveService({
      credentials,
      mint: () => Promise.reject(new Error('quota exceeded')),
    });
    const failed = await failing.mintToken();
    expect('error' in failed).toBe(true);
    if ('error' in failed) expect(failed.error).toContain('quota exceeded');
  });
});
