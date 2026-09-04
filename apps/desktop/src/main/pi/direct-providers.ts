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
import { DIRECT_PROVIDERS } from '@shared/direct-providers.js';

/**
 * Teaches a runtime every provider in the table and applies direct-key API overrides.
 *
 * A registration that throws is skipped rather than fatal: pi validates each
 * entry against its own model shape, and one malformed provider must not take
 * down a runtime that can still reach every other model the operator has.
 * Registration carries no credential, so a provider registered here stays
 * absent from `getAvailable()` until a key is stored for it.
 */
export function registerDirectProviders(runtime: ModelRuntime): void {
  for (const provider of DIRECT_PROVIDERS) {
    try {
      runtime.registerProvider(provider.id, {
        name: provider.label,
        baseUrl: provider.baseUrl,
        api: provider.api,
        // Copied out of the shared table because pi keeps the registration and
        // mutates model entries as it composes providers; the table is a
        // shipped constant the renderer reads from too.
        models: provider.models.map((model) => ({
          ...model,
          input: [...model.input],
          cost: { ...model.cost },
          ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
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
        ...model,
        api: 'openai-responses',
        input: [...model.input],
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
