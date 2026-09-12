/**
 * Smith's live voice layer, main-process side: the stored Gemini key, the
 * persona the voice model speaks with, and the ephemeral tokens the renderer
 * connects with.
 *
 * The voice model never does the work itself. It is a pleasant conversational
 * front-end: `smith_delegate` routes the operator's words into the same
 * `SmithChatSession` the Smith UI drives — so the model the operator chose in
 * the Smith header stays the one doing the work, and proposals land in the
 * ordinary approval queue. The key itself never reaches the renderer; only
 * short-lived tokens minted here do.
 *
 * Token minting uses Case 1 of the ephemeral-token flow: the token carries no
 * locked config, so the renderer states the session config at connect time
 * and a reconnect after a dropped socket needs only a fresh token, not a new
 * key grant. The persona lives here so the voice layer's character cannot
 * drift between reconnects; the tool declarations it names live beside the
 * renderer's dispatch table in `view-models/smith-voice-view.ts`.
 */

import type {
  GeminiLiveActionResult,
  GeminiLiveConnectionState,
  GeminiLiveToken,
} from '@shared/ipc-contract.js';
import type { SecretStore } from '../system/secret-file.js';

/** The Live API model the voice layer speaks with. */
export const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';

/**
 * Maps a token-mint failure to the one line the voice overlay shows. Google's
 * mint failures arrive as raw JSON-RPC blobs (an invalid key carries
 * `API_KEY_INVALID` inside `{"error":{"code":400,...}}`); rendering that
 * verbatim leaves the operator with no hint that the fix is a new key, so an
 * invalid key always resolves to the Settings → Integrations pointer and
 * anything else keeps its short detail without the blob.
 */
export function friendlyMintError(message: string): string {
  if (/API_KEY_INVALID|API key not valid|invalid API key|API key expired/i.test(message)) {
    return 'Your Gemini API key was rejected. Replace it in Settings → Integrations.';
  }
  const oneLine = message.replace(/\s+/g, ' ').trim();
  if (oneLine.length > 240) {
    return `Could not mint a Live API token: ${oneLine.slice(0, 240)}… Check Settings → Integrations and try again.`;
  }
  return `Could not mint a Live API token: ${oneLine}`;
}

export interface GeminiLiveServiceDeps {
  credentials: SecretStore;
  /** Test seam: mints the ephemeral token from the stored key. */
  mint?: (apiKey: string) => Promise<string>;
}

/**
 * The persona installed as the live session's system instruction. Kept here,
 * in main, so the voice layer's character and its bounded tool set are stated
 * once and the renderer cannot restyle what the model is allowed to do.
 */
export function voiceSystemInstruction(): string {
  return [
    'You are Smith, the operator agent of Foundry, speaking by voice.',
    'You are a pleasant, concise conversational layer over the real Smith: a full coding agent the operator drives from the Foundry app on their chosen model.',
    "You do not do the work yourself. For anything that reads or changes Foundry — runs, pipelines, agents, projects, files, settings — call smith_delegate with a faithful, self-contained statement of what the operator wants. Speak the operator's language; do not translate it into commands.",
    'smith_delegate returns immediately with "started". The delegated turn settles in the background; its answer arrives as a later user message you then summarize briefly and helpfully. Do not guess outcomes, do not pretend the work finished.',
    'While a delegated turn is running, say so plainly if asked. Use smith_cancel to stop it when the operator asks.',
    'When a proposal card is waiting for approval, smith_proposal_read describes it; smith_proposal_answer approves or rejects it by voice only when the operator clearly asks you to.',
    'Small talk, clarification questions, and restating what you heard need no tool call. Never invent Foundry data; if you do not know, delegate or ask.',
    'Keep replies short and spoken-natural. No markdown, no lists you cannot say aloud.',
  ].join(' ');
}

export class GeminiLiveService {
  constructor(private readonly deps: GeminiLiveServiceDeps) {}

  state(): GeminiLiveConnectionState {
    return {
      keySet: this.deps.credentials.has(),
      detail: this.deps.credentials.has()
        ? 'A Gemini API key is stored. Voice mode can connect.'
        : 'Save a Gemini API key to enable Smith voice mode.',
    };
  }

  async setApiKey(apiKey: string): Promise<GeminiLiveActionResult> {
    const key = apiKey.trim();
    if (!key) return { ok: false, detail: 'Enter a valid Gemini API key.' };
    try {
      this.deps.credentials.set(key);
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
    return { ok: true, detail: 'Gemini API key saved. Voice mode can connect.' };
  }

  async clearApiKey(): Promise<GeminiLiveActionResult> {
    this.deps.credentials.clear();
    return { ok: true, detail: 'Removed the stored Gemini API key.' };
  }

  /**
   * Mints one short-lived ephemeral token for a live session connection. The
   * stored key stays in main; the renderer presents the token as the Live API
   * credential. One mint per connection attempt, so a reconnect never reuses
   * a token that might have leaked through a stale socket.
   */
  async mintToken(): Promise<GeminiLiveToken | { error: string }> {
    const apiKey = this.deps.credentials.get();
    if (!apiKey)
      return { error: 'No Gemini API key is stored. Save one in Settings → Integrations.' };
    try {
      const token = await (this.deps.mint ?? defaultMint)(apiKey);
      return {
        token,
        model: GEMINI_LIVE_MODEL,
        systemInstruction: voiceSystemInstruction(),
      };
    } catch (error) {
      return { error: friendlyMintError((error as Error).message) };
    }
  }
}

/** Production mint path; the `@google/genai` import stays lazy so startup stays lean. */
async function defaultMint(apiKey: string): Promise<string> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } });
  const token = await ai.authTokens.create({ config: { uses: 1 } });
  if (!token.name) throw new Error('the token response carried no token');
  return token.name;
}
