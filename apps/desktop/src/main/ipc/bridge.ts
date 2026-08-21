/**
 * The Bridge's IPC surface: status, provider connect/disconnect, and direct
 * API keys.
 *
 * Everything here answers with plain data. Provider ids are validated against
 * the table rather than trusted, because a renderer-supplied string ends up in
 * a spawn argument and in a filesystem path; an unknown one is refused with a
 * message rather than passed through.
 */

import type { BridgeActionResult, BridgeState, StoredProviderKey } from '@shared/ipc-contract.js';
import { IPC } from '@shared/ipc-contract.js';
import { isBridgeProvider } from '../bridge/providers.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';

type Ctx = Pick<AppContext, 'bridge' | 'supportDir' | 'broadcast'>;

const unknownProvider = (provider: string): BridgeActionResult => ({
  ok: false,
  detail: `unknown provider: ${provider}`,
});

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.bridgeState, (): BridgeState => {
    const snapshot = ctx.bridge.snapshot();
    return {
      running: snapshot.status.running,
      port: snapshot.status.port,
      pid: snapshot.status.pid,
      ...(snapshot.status.reason ? { reason: snapshot.status.reason } : {}),
      ...(snapshot.status.detail ? { detail: snapshot.status.detail } : {}),
      baseUrl: snapshot.baseUrl,
      providers: snapshot.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        icon: provider.icon,
        authenticated: provider.authenticated,
        loginInFlight: provider.loginInFlight,
        accounts: provider.accounts.map((account) => ({ ...account })),
      })),
    };
  });

  handle(IPC.bridgeConnect, async (provider: string): Promise<BridgeActionResult> => {
    if (!isBridgeProvider(provider)) return unknownProvider(provider);
    const result = await ctx.bridge.connect(provider);
    // The flow finishes in a browser; the auth watcher broadcasts again when
    // the account actually lands. This first one moves the pane out of its
    // pending state right away.
    ctx.broadcast(IPC.eventBridgeChanged);
    return result;
  });

  handle(IPC.bridgeDisconnect, async (provider: string): Promise<BridgeActionResult> => {
    if (!isBridgeProvider(provider)) return unknownProvider(provider);
    const result = await ctx.bridge.disconnect(provider);
    ctx.broadcast(IPC.eventBridgeChanged);
    return result;
  });

  handle(IPC.bridgeCancelLogin, (provider: string): boolean => {
    if (!isBridgeProvider(provider)) return false;
    const cancelled = ctx.bridge.cancel(provider);
    if (cancelled) ctx.broadcast(IPC.eventBridgeChanged);
    return cancelled;
  });

  handle(
    IPC.bridgeSetApiKey,
    async (providerId: string, apiKey: string): Promise<BridgeActionResult> => {
      const key = apiKey.trim();
      if (!key) return { ok: false, detail: 'the API key is empty' };
      try {
        // Imported lazily: this is the only path in the router that needs pi's
        // runtime, and building one reads catalogs off disk.
        const { setProviderApiKey } = await import('../pi/catalog.js');
        await setProviderApiKey(ctx.supportDir, providerId, key);
        ctx.broadcast(IPC.eventBridgeChanged);
        return { ok: true, detail: `stored an API key for ${providerId}` };
      } catch (error) {
        // pi's error, which names the provider and the failure mode. It never
        // carries the key: nothing in this path logs or echoes it.
        return { ok: false, detail: message(error) };
      }
    },
  );

  handle(IPC.bridgeClearApiKey, async (providerId: string): Promise<BridgeActionResult> => {
    try {
      const { clearProviderApiKey } = await import('../pi/catalog.js');
      await clearProviderApiKey(ctx.supportDir, providerId);
      ctx.broadcast(IPC.eventBridgeChanged);
      return { ok: true, detail: `removed the stored key for ${providerId}` };
    } catch (error) {
      return { ok: false, detail: message(error) };
    }
  });

  handle(IPC.bridgeStoredKeys, async (): Promise<StoredProviderKey[]> => {
    try {
      const { storedCredentials } = await import('../pi/catalog.js');
      return await storedCredentials(ctx.supportDir);
    } catch {
      // An unbuildable runtime means no keys to report, not a failed call: the
      // pane shows every key row as unset rather than an error.
      return [];
    }
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
