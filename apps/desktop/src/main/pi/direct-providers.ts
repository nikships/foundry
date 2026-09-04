/**
 * Registers the providers from `shared/direct-providers.ts` on a pi runtime.
 *
 * Registration is in-memory rather than a `models.json` entry on purpose. That
 * file belongs to the operator (and, for `bridge-*` keys, to the Bridge);
 * writing a Foundry-owned provider into it would put shipped defaults in a
 * document a person is expected to edit, and a model list corrected in a
 * release could not then replace a stale copy on disk.
 */

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { DIRECT_PROVIDERS } from '@shared/direct-providers.js';

/**
 * Teaches a runtime every provider in the table.
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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
