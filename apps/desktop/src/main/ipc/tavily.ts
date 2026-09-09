import { z } from 'zod';
import { IPC, type TavilyActionResult, type TavilyConnectionState } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';

type Ctx = Pick<AppContext, 'tavily'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.tavilyState, (): TavilyConnectionState => ctx.tavily.state());
  handle(IPC.tavilyInstall, (): Promise<TavilyActionResult> => ctx.tavily.install());
  handle(IPC.tavilyRemove, (): TavilyActionResult => ctx.tavily.remove());
  handle(IPC.tavilySetApiKey, (apiKey: string): TavilyActionResult => {
    const parsed = z.string().trim().min(1).max(4096).safeParse(apiKey);
    if (!parsed.success) return { ok: false, detail: 'Enter a valid Tavily API key.' };
    return ctx.tavily.setApiKey(parsed.data);
  });
  handle(IPC.tavilyClearApiKey, (): TavilyActionResult => ctx.tavily.clearApiKey());
}
