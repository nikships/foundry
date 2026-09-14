/**
 * GptLiveService: the stored key, the session-create seam, and the SDP payload.
 * No network: session create goes through the injected test seam, and the key
 * never appears in any value the service returns.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, afterEach, expect, it, vi } from 'vitest';
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

describe('defaultCreateWebRtcSession (POST /v1/realtime/calls)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(
    body: string,
    init: { status?: number; location?: string } = {},
  ): { url: unknown; init: RequestInit }[] {
    const seen: { url: unknown; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, request?: RequestInit) => {
        seen.push({ url, init: request ?? {} });
        const headers: Record<string, string> = {};
        if (init.location !== undefined) headers.location = init.location;
        return new Response(body, { status: init.status ?? 200, headers });
      }),
    );
    return seen;
  }

  it('posts multipart SDP + session to the realtime calls endpoint and keeps SDP bytes intact', async () => {
    const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    expect(offer.trim()).not.toBe(offer);
    const answer = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
    const seen = stubFetch(answer, { location: '/v1/realtime/calls/rtc_abc123' });
    const { service } = store();
    await service.setApiKey('sk-test-key');
    const created = await service.createSession(offer);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/realtime/calls');
    const request = seen[0]!.init;
    expect(request.method).toBe('POST');
    expect((request.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key');
    expect(JSON.stringify(request.headers)).not.toContain('application/json');
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect([...form.keys()].sort()).toEqual(['sdp', 'session']);

    const sdpPart = form.get('sdp');
    expect(sdpPart).toBeInstanceOf(Blob);
    expect((sdpPart as Blob).type).toBe('application/sdp');
    expect(await (sdpPart as Blob).text()).toBe(offer);

    const sessionPart = form.get('session');
    expect(sessionPart).toBeInstanceOf(Blob);
    expect((sessionPart as Blob).type).toBe('application/json');
    expect(JSON.parse(await (sessionPart as Blob).text())).toEqual(liveSessionConfig('marin'));

    expect('error' in created).toBe(false);
    if ('error' in created) return;
    expect(created.sessionId).toBe('rtc_abc123');
    expect(created.sdp).toBe(answer);
    expect(JSON.stringify(created)).not.toContain('sk-test-key');
  });

  it('extracts the call id from an absolute Location URL', async () => {
    const seen = stubFetch('v=0\r\n', {
      location: 'https://api.openai.com/v1/realtime/calls/rtc_xyz789',
    });
    const { service } = store();
    await service.setApiKey('sk-test-key');
    const created = await service.createSession('v=0\r\n');
    expect(seen).toHaveLength(1);
    expect('error' in created).toBe(false);
    if ('error' in created) return;
    expect(created.sessionId).toBe('rtc_xyz789');
  });

  it('fails when the answer body is empty', async () => {
    stubFetch('   \n', { location: '/v1/realtime/calls/rtc_abc123' });
    const { service } = store();
    await service.setApiKey('sk-test-key');
    const failed = await service.createSession('v=0\r\n');
    expect('error' in failed).toBe(true);
    if (!('error' in failed)) return;
    expect(failed.error).toContain('no SDP answer');
  });

  it('fails when the Location header is missing', async () => {
    stubFetch('v=0\r\n');
    const { service } = store();
    await service.setApiKey('sk-test-key');
    const failed = await service.createSession('v=0\r\n');
    expect('error' in failed).toBe(true);
    if (!('error' in failed)) return;
    expect(failed.error).toContain('no call id');
  });

  it('surfaces server failures without leaking the key', async () => {
    stubFetch('invalid_offer: unexpected EOF', { status: 400 });
    const { service } = store();
    await service.setApiKey('sk-test-key');
    const failed = await service.createSession('v=0\r\n');
    expect('error' in failed).toBe(true);
    if (!('error' in failed)) return;
    expect(failed.error).toContain('invalid_offer');
    expect(failed.error).not.toContain('sk-test-key');
  });
});
