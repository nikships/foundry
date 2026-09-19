/**
 * Configures direct API-key providers on a pi runtime.
 *
 * Registration is in-memory rather than a `models.json` entry on purpose. That
 * file belongs to the operator (and, for `bridge-*` keys, to the Bridge);
 * writing Foundry-owned defaults into it would put shipped policy in a document
 * a person is expected to edit.
 *
 * Pi already owns OpenRouter's model catalog and authentication. Foundry only
 * replaces its Chat Completions API kind so direct-key turns use Responses,
 * preserving the rest of every model entry and pi's credential handling.
 */

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { DIRECT_PROVIDERS, sparkThinkingLevelMap } from '@shared/direct-providers.js';
import { MuseCredentialStore, museStoreDir } from '../bridge/muse-credentials.js';

/**
 * True when a usable Muse subscription key is present.
 *
 * Both credential modes share pi's `meta` provider id (the minted key is
 * stored on the existing `meta` slot), so this is the signal that separates
 * them: a direct API key leaves the Muse store empty, while a subscription
 * login mints a Model API key into it. Never throws: an unreadable store is
 * API-key mode.
 */
export function isMuseSubscriptionMode(supportDir: string): boolean {
  try {
    return new MuseCredentialStore(museStoreDir(supportDir)).hasUsableAPIKey();
  } catch {
    return false;
  }
}

/**
 * Re-registers `meta` with the thinking maps for this credential mode.
 *
 * The static table carries the API-key baseline (`muse-spark-1.3` offers
 * `max`, `muse-spark-1.3-contributor` stops at `xhigh`). Subscription mode
 * offers `max` on both. Re-registration replaces the provider config in
 * place and keeps the stored credential: the key lives in pi's auth store
 * under the same `meta` id, not in the registration. Called after the
 * credential changes (and before catalog reads) so the picker, the clamp,
 * and the value sent to the provider all agree.
 */
export function syncMetaThinkingLevels(runtime: ModelRuntime, supportDir: string): void {
  const subscription = isMuseSubscriptionMode(supportDir);
  const meta = DIRECT_PROVIDERS.find((provider) => provider.id === 'meta');
  if (!meta) return;
  try {
    runtime.registerProvider(meta.id, {
      name: meta.label,
      baseUrl: meta.baseUrl,
      api: meta.api,
      models: meta.models.map((model) => ({
        ...model,
        input: [...model.input],
        cost: { ...model.cost },
        thinkingLevelMap: { ...sparkThinkingLevelMap(model.id, subscription) },
      })),
    });
  } catch (error) {
    console.warn(`[pi] could not sync the meta thinking levels: ${message(error)}`);
  }
}

/**
 * Teaches a runtime every provider in the table and applies direct-key API overrides.
 *
 * A registration that throws is skipped rather than fatal: pi validates each
 * entry against its own model shape, and one malformed provider must not take
 * down a runtime that can still reach every other model the operator has.
 * Registration carries no credential, so a provider registered here stays
 * absent from `getAvailable()` until a key is stored for it.
 */
export function registerDirectProviders(runtime: ModelRuntime, supportDir?: string): void {
  const subscription = supportDir ? isMuseSubscriptionMode(supportDir) : false;
  for (const provider of DIRECT_PROVIDERS) {
    try {
      runtime.registerProvider(provider.id, {
        name: provider.label,
        baseUrl: provider.baseUrl,
        api: provider.api,
        // Copied out of the shared table because pi keeps the registration and
        // mutates model entries as it composes providers; the table is a
        // shipped constant the renderer reads from too. The `meta` maps are
        // resolved per credential mode so subscription `max` needs no second
        // table: `sparkThinkingLevelMap` is the matrix.
        models: provider.models.map((model) => ({
          ...model,
          input: [...model.input],
          cost: { ...model.cost },
          ...(provider.id === 'meta'
            ? { thinkingLevelMap: { ...sparkThinkingLevelMap(model.id, subscription) } }
            : model.thinkingLevelMap
              ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
              : {}),
        })),
      });
    } catch (error) {
      console.warn(`[pi] could not register the ${provider.id} provider: ${message(error)}`);
    }
  }

  applyDirectProviderOverrides(runtime);
}

/** Reapplies API overrides after pi refreshes its underlying model catalog. */
export function applyDirectProviderOverrides(runtime: ModelRuntime): void {
  try {
    if (runtime.getRegisteredProviderConfig('openrouter')) {
      runtime.unregisterProvider('openrouter');
    }
    runtime.registerProvider('openrouter', {
      models: runtime.getModels('openrouter').map((model) => ({
        ...structuredClone(model),
        api: 'openai-responses',
      })),
    });
  } catch (error) {
    console.warn(
      `[pi] could not route the openrouter provider through Responses: ${message(error)}`,
    );
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
