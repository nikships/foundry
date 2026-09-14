/**
 * Smith's live voice layer, main-process side: the stored OpenAI key, the
 * persona the voice model speaks with, and the GPT-Live sessions the
 * renderer and companion connect with.
 *
 * The voice model presents one Smith identity while client delegation routes
 * work into the same `SmithChatSession` the Smith UI drives — so the model
 * the operator chose in the Smith header stays the one doing the work, and
 * proposals land in the ordinary approval queue. The key itself never reaches
 * the renderer or a paired phone.
 *
 * GPT-Live has no Gemini-style ephemeral token. Desktop WebRTC posts the
 * browser SDP offer here (`POST /v1/realtime/calls`); the companion host
 * relays a WebSocket so Android never sees the key either.
 */

import {
  DEFAULT_GPT_LIVE_VOICE,
  GPT_LIVE_MODEL,
  isGptLiveVoiceId,
  type GptLiveVoiceId,
} from '@shared/gpt-live.js';
import type {
  GptLiveActionResult,
  GptLiveConnectionState,
  GptLiveSession,
} from '@shared/ipc-contract.js';
import type { SecretStore } from '../system/secret-file.js';

const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';

/**
 * Maps a session-create failure to the one line the voice overlay shows.
 * OpenAI auth failures should point at Settings, not a raw JSON blob.
 */
export function friendlyLiveError(message: string): string {
  if (/invalid.?api.?key|incorrect api key|authentication|unauthorized|401/i.test(message)) {
    return 'Your OpenAI API key was rejected. Replace it in Settings → Integrations.';
  }
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length > 240) {
    return `Could not start a GPT-Live session: ${oneLine.slice(0, 240)}… Check Settings → Integrations and try again.`;
  }
  return `Could not start a GPT-Live session: ${oneLine}`;
}

export interface GptLiveServiceDeps {
  credentials: SecretStore;
  voice: () => string;
  /** Test seam: exchanges an SDP offer for a Live WebRTC answer. */
  createWebRtcSession?: (
    apiKey: string,
    sdp: string,
    voice: GptLiveVoiceId,
  ) => Promise<GptLiveSession>;
}

/**
 * The persona installed as the live session's instructions. Kept here, in
 * main, so the voice layer's character and when it delegates cannot drift
 * between reconnects.
 */
export function voiceSystemInstruction(): string {
  return [
    'You are Smith, the operator agent of Foundry, speaking by voice. You and the Smith text agent are one identity and one continuous first-person conversation.',
    'Speak warmly and naturally, at an unhurried pace. Be clear and direct. Keep replies short and spoken-natural. No markdown, no lists you cannot say aloud.',
    'Backchannel policy: Use moderate backchannels. Acknowledge naturally without competing with the main response.',
    'Interruption policy: Stop speaking when the user interrupts. Listen to what they say.',
    'Delegation policy: The backend can read and change Foundry — runs, pipelines, agents, projects, files, settings, Linear tickets, and proposals — and can cancel in-flight work.',
    'Delegate to the backend when the request needs Foundry state or an action, when the operator asks to cancel in-flight work, or when they ask what proposal is waiting or to approve or reject it.',
    'Do not delegate when you can answer from the conversation or a still-current result, or when the operator is making small talk.',
    'When you delegate, briefly say something natural such as “let me check” or “let me think about that” in the same turn as the delegation, never instead of it. Then wait for the backend result and answer as Smith in the first person.',
    'Never expose the internal handoff or imply that another agent, Smith instance, backend, backend team, or separate system must do the work. Never say you need to delegate, ask Smith, hand this off, or wait for someone else.',
    'Never invent Foundry data; if you do not know, delegate. Never speak a secret aloud: a proposal that needs a key is completed in the masked card in the app.',
  ].join(' ');
}

export function resolveLiveVoice(value: string): GptLiveVoiceId {
  return isGptLiveVoiceId(value) ? value : DEFAULT_GPT_LIVE_VOICE;
}

/** Session fields shared by WebRTC create and the companion WebSocket start. */
export function liveSessionConfig(voice: GptLiveVoiceId): {
  model: typeof GPT_LIVE_MODEL;
  instructions: string;
  audio: { output: { voice: GptLiveVoiceId } };
  delegation: { type: 'client' };
} {
  return {
    model: GPT_LIVE_MODEL,
    instructions: voiceSystemInstruction(),
    audio: { output: { voice } },
    delegation: { type: 'client' },
  };
}

export class GptLiveService {
  constructor(private readonly deps: GptLiveServiceDeps) {}

  state(): GptLiveConnectionState {
    return {
      keySet: this.deps.credentials.has(),
      detail: this.deps.credentials.has()
        ? 'An OpenAI API key is stored. Voice mode can connect.'
        : 'Save an OpenAI API key to enable Smith voice mode.',
    };
  }

  voice(): GptLiveVoiceId {
    return resolveLiveVoice(this.deps.voice());
  }

  /** Presence-only for the companion relay; the value never leaves main. */
  apiKey(): string | null {
    return this.deps.credentials.get();
  }

  async setApiKey(apiKey: string): Promise<GptLiveActionResult> {
    const key = apiKey.trim();
    if (!key) return { ok: false, detail: 'Enter a valid OpenAI API key.' };
    try {
      this.deps.credentials.set(key);
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
    return { ok: true, detail: 'OpenAI API key saved. Voice mode can connect.' };
  }

  async clearApiKey(): Promise<GptLiveActionResult> {
    this.deps.credentials.clear();
    return { ok: true, detail: 'Removed the stored OpenAI API key.' };
  }

  /**
   * Creates one GPT-Live WebRTC session from the renderer's SDP offer. The
   * stored key stays in main; the renderer only receives the session id and
   * SDP answer. Voice is read from Settings at create time.
   */
  async createSession(sdp: string): Promise<GptLiveSession | { error: string }> {
    if (!sdp.trim()) return { error: 'A WebRTC offer is required to start voice.' };
    const apiKey = this.deps.credentials.get();
    if (!apiKey)
      return { error: 'No OpenAI API key is stored. Save one in Settings → Integrations.' };
    const voice = this.voice();
    try {
      return await (this.deps.createWebRtcSession ?? defaultCreateWebRtcSession)(
        apiKey,
        sdp,
        voice,
      );
    } catch (error) {
      return { error: friendlyLiveError((error as Error).message) };
    }
  }
}

async function defaultCreateWebRtcSession(
  apiKey: string,
  sdp: string,
  voice: GptLiveVoiceId,
): Promise<GptLiveSession> {
  const form = new FormData();
  form.append('sdp', new Blob([sdp], { type: 'application/sdp' }));
  form.append(
    'session',
    new Blob([JSON.stringify(liveSessionConfig(voice))], { type: 'application/json' }),
  );
  const response = await fetch(REALTIME_CALLS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(raw || `GPT-Live returned ${response.status}`);
  }
  if (!raw.trim()) throw new Error('the session response carried no SDP answer');
  const sessionId = extractCallId(response.headers.get('location'));
  if (!sessionId) throw new Error('the session response carried no call id');
  return { sessionId, sdp: raw };
}

/**
 * Reads the call id from the create-call `Location` response header, which
 * points at the new call resource (for example `/v1/realtime/calls/rtc_...`).
 */
function extractCallId(location: string | null): string | null {
  if (!location) return null;
  const trimmed = location.trim();
  if (!trimmed) return null;
  const withoutSuffix = trimmed.split('?')[0]?.split('#')[0] ?? '';
  const segments = withoutSuffix.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1]?.trim() ?? '';
  return last || null;
}

export { REALTIME_CALLS_URL };
