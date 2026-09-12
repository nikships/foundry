/**
 * The Gemini Live IPC slice: key management and ephemeral-token minting for
 * Smith's voice layer. Delegation needs no router of its own — the renderer
 * calls the ordinary `smith` channels with the same scope the Smith UI uses,
 * which is the whole point: voice and text are one conversation.
 */

import { z } from 'zod';
import {
  IPC,
  type GeminiLiveActionResult,
  type GeminiLiveConnectionState,
  type GeminiLiveToken,
} from '@shared/ipc-contract.js';
import type { GeminiLiveService } from '../gemini-live/service.js';
import type { Handle } from './shared.js';

type Ctx = { geminiLive: GeminiLiveService };

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.geminiLiveState, (): GeminiLiveConnectionState => ctx.geminiLive.state());
  handle(IPC.geminiLiveSetApiKey, async (apiKey: string): Promise<GeminiLiveActionResult> => {
    const parsed = z.string().trim().min(1).max(4096).safeParse(apiKey);
    if (!parsed.success) return { ok: false, detail: 'Enter a valid Gemini API key.' };
    return ctx.geminiLive.setApiKey(parsed.data);
  });
  handle(IPC.geminiLiveClearApiKey, (): Promise<GeminiLiveActionResult> =>
    ctx.geminiLive.clearApiKey(),
  );
  handle(IPC.geminiLiveMintToken, (): Promise<GeminiLiveToken | { error: string }> =>
    ctx.geminiLive.mintToken(),
  );
}
