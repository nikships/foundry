/**
 * The GPT-Live IPC slice: key management and WebRTC session creation for
 * Smith's voice layer. Delegation needs no router of its own — the renderer
 * calls the ordinary `smith` channels with the same scope the Smith UI uses,
 * which is the whole point: voice and text are one conversation.
 */

import { z } from 'zod';
import {
  IPC,
  type GptLiveActionResult,
  type GptLiveConnectionState,
  type GptLiveSession,
} from '@shared/ipc-contract.js';
import type { GptLiveService } from '../gpt-live/service.js';
import type { Handle } from './shared.js';

type Ctx = { gptLive: GptLiveService };

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.gptLiveState, (): GptLiveConnectionState => ctx.gptLive.state());
  handle(IPC.gptLiveSetApiKey, async (apiKey: string): Promise<GptLiveActionResult> => {
    const parsed = z.string().trim().min(1).max(4096).safeParse(apiKey);
    if (!parsed.success) return { ok: false, detail: 'Enter a valid OpenAI API key.' };
    return ctx.gptLive.setApiKey(parsed.data);
  });
  handle(IPC.gptLiveClearApiKey, (): Promise<GptLiveActionResult> => ctx.gptLive.clearApiKey());
  handle(
    IPC.gptLiveCreateSession,
    async (sdp: string): Promise<GptLiveSession | { error: string }> => {
      const parsed = z.string().min(1).max(256_000).safeParse(sdp);
      if (!parsed.success) return { error: 'A WebRTC offer is required to start voice.' };
      return ctx.gptLive.createSession(parsed.data);
    },
  );
}
