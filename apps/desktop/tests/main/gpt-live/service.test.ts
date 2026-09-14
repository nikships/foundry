/**
 * GptLiveService: the stored key, the session-create seam, and the SDP payload.
 * No network: session create goes through the injected test seam, and the key
 * never appears in any value the service returns.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { GPT_LIVE_MODEL } from '../../../src/shared/gpt-live.js';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value: Buffer) => value.toString().split('').reverse().join(''),
  },
}));

const { GptLiveCredentialStore } = await import('../../../src/main/gpt-live/credentials.js');
const { GptLiveService, voiceSystemInstruction, liveSessionConfig } =
  await import('../../../src/main/gpt-live/service.js');
type GptLiveServiceInstance = InstanceType<typeof GptLiveService>;

function store(
  createWebRtcSession?: (
    apiKey: string,
    sdp: string,
    voice: string,
  ) => Promise<{ sessionId: string; sdp: string }>,
  voice = 'marin',
): {
  service: GptLiveServiceInstance;
  file: string;
} {
  const support = tempDir('foundry-gpt-live-');
  const file = join(support, 'credentials', 'gpt-live-api-key.bin');
  const credentials = new GptLiveCredentialStore(file, {
    available: () => true,
    encrypt: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decrypt: (value: Buffer) => value.toString().split('').reverse().join(''),
  });
  return {
    service: new GptLiveService({
      credentials,
      voice: () => voice,
      ...(createWebRtcSession ? { createWebRtcSession } : {}),
    }),
    file,
  };
}

describe('GptLiveCredentialStore', () => {
  it('round-trips the key without persisting it in the clear', () => {
    const support = tempDir('foundry-gpt-live-');
    const file = join(support, 'credentials', 'gpt-live-api-key.bin');
    const credentials = new GptLiveCredentialStore(file, {
      available: () => true,
      encrypt: (value: string) => Buffer.from(value.split('').reverse().join('')),
      decrypt: (value: Buffer) => value.toString().split('').reverse().join(''),
    });
    const key = 'sk-real_secret_value';
    credentials.set(key);
    expect(credentials.has()).toBe(true);
    expect(credentials.get()).toBe(key);
    expect(readFileSync(file, 'utf8')).not.toContain(key);
    credentials.clear();
    expect(credentials.has()).toBe(false);
  });

  it('fails closed when OS encryption is unavailable', () => {
    const credentials = new GptLiveCredentialStore(join(tempDir('foundry-gpt-live-'), 'k'), {
      available: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => '',
    });
    expect(() => credentials.set('secret')).toThrow('Secure credential storage is unavailable');
  });
});

describe('GptLiveService', () => {
  it('pins one first-person Smith identity and forbids exposing internal handoffs', () => {
    const instruction = voiceSystemInstruction();
    expect(instruction).toContain('You are Smith');
    expect(instruction).toContain('one identity and one continuous first-person conversation');
    expect(instruction).toContain('briefly say something natural');
    expect(instruction).toContain('Never say you need to delegate, ask Smith, hand this off');
    expect(instruction).not.toContain('front-end over the real Smith');
    expect(instruction).not.toContain('You do not do the work yourself');
  });

  it('configures gpt-live-1 with client delegation and the chosen voice', () => {
    const config = liveSessionConfig('quartz');
    expect(config.model).toBe(GPT_LIVE_MODEL);
    expect(config.audio.output.voice).toBe('quartz');
    expect(config.delegation).toEqual({ type: 'client' });
    expect(config.instructions).toContain('You are Smith');
  });

  it('reports unset state until a key is saved, and never echoes the key', async () => {
    const { service } = store();
    expect(service.state()).toMatchObject({ keySet: false });
    const saved = await service.setApiKey('  sk-saved  ');
    expect(saved).toMatchObject({ ok: true });
    expect(JSON.stringify(service.state())).not.toContain('sk-saved');
    expect(service.state()).toMatchObject({ keySet: true });
  });

  it('refuses an empty key and clears on request', async () => {
    const { service } = store();
    expect(await service.setApiKey('   ')).toMatchObject({ ok: false });
    await service.setApiKey('sk-saved');
    const cleared = await service.clearApiKey();
    expect(cleared).toMatchObject({ ok: true });
    expect(service.state()).toMatchObject({ keySet: false });
  });

  it('creates a session that carries the SDP answer but never the key', async () => {
    const { service } = store(async () => ({ sessionId: 'live_1', sdp: 'answer-sdp' }));
    await service.setApiKey('sk-real_secret_value');
    const created = await service.createSession('offer-sdp');
    expect('error' in created).toBe(false);
    if ('error' in created) return;
    expect(created.sessionId).toBe('live_1');
    expect(created.sdp).toBe('answer-sdp');
    expect(JSON.stringify(created)).not.toContain('sk-real_secret_value');
  });

  it('refuses to create a session with no stored key, and surfaces failures', async () => {
    const { service } = store();
    const refused = await service.createSession('offer');
    expect('error' in refused).toBe(true);
    if (!('error' in refused)) return;
    expect(refused.error).toContain('No OpenAI API key');

    const support = tempDir('foundry-gpt-live-');
    const credentials = new GptLiveCredentialStore(
      join(support, 'credentials', 'gpt-live-api-key.bin'),
      {
        available: () => true,
        encrypt: (value: string) => Buffer.from(value),
        decrypt: (value: Buffer) => value.toString(),
      },
    );
    credentials.set('sk-saved');
    const failing = new GptLiveService({
      credentials,
      voice: () => 'marin',
      createWebRtcSession: () => Promise.reject(new Error('quota exceeded')),
    });
    const failed = await failing.createSession('offer');
    expect('error' in failed).toBe(true);
    if ('error' in failed) expect(failed.error).toContain('quota exceeded');
  });

  it('maps an invalid-key failure to the Settings pointer, never the raw blob', async () => {
    const support = tempDir('foundry-gpt-live-');
    const credentials = new GptLiveCredentialStore(
      join(support, 'credentials', 'gpt-live-api-key.bin'),
      {
        available: () => true,
        encrypt: (value: string) => Buffer.from(value),
        decrypt: (value: Buffer) => value.toString(),
      },
    );
    credentials.set('sk-saved');
    const invalid = new GptLiveService({
      credentials,
      voice: () => 'marin',
      createWebRtcSession: () => Promise.reject(new Error('Incorrect API key provided: sk-…')),
    });
    const refused = await invalid.createSession('offer');
    expect('error' in refused).toBe(true);
    if (!('error' in refused)) return;
    expect(refused.error).toBe(
      'Your OpenAI API key was rejected. Replace it in Settings → Integrations.',
    );
    expect(refused.error).not.toContain('sk-');
  });
});
