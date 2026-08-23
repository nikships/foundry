/**
 * What models the pi runtime can actually reach, and the credential operations
 * that change that answer.
 *
 * `getAvailable()` is the honest list: a provider whose credential is missing,
 * expired, or unresolvable is absent from it, so a model reaching the picker
 * is one a run can start on. The Bridge's `models.json` entries appear here for
 * free once the Bridge has logged a provider in and the file has been written —
 * that is the whole point of generating the file rather than a second catalog.
 *
 * Direct API keys land here too. `ModelRuntime.setRuntimeApiKey` sets an
 * in-memory override that dies with the process, so a key entered in Settings
 * would silently stop working on the next launch; `login(providerId,
 * 'api_key', …)` is the path that goes through `credentials.modify` and reaches
 * pi's auth store. The interaction below answers the provider's own secret
 * prompt with the key rather than asking a human, which is what makes an
 * interactive flow usable from an IPC call.
 */

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelInfo } from '@shared/types.js';
import { effortsFor } from './model.js';
import { modelRuntime } from './runtime.js';

/** pi's own model shape, derived from the runtime rather than imported. */
type PiModel = Awaited<ReturnType<ModelRuntime['getAvailable']>>[number];

/**
 * Provider-qualified, because that is the id a roster stores and
 * `pi-transport.ts` matches on. A bare `claude-opus-5` is ambiguous the moment
 * both `anthropic` and `bridge-claude` offer it.
 */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/**
 * Which brand a model belongs to, which is what names its mark in the picker.
 *
 * Read off the id and display name rather than the provider id, because the
 * provider says who serves the model and not who made it: a Claude reached
 * through `bridge-claude` is still a Claude, and a proxy someone configured
 * themselves can call itself anything at all.
 */
export function providerOf(id: string, displayName = ''): string {
  const s = `${id} ${displayName}`.toLowerCase();
  return (
    MODEL_BRANDS.find((brand) => brand.matches.some((token) => s.includes(token)))?.provider ??
    'openai'
  );
}

const MODEL_BRANDS = [
  { provider: 'claude', matches: ['claude', 'opus', 'sonnet', 'haiku', 'fable'] },
  { provider: 'openai', matches: ['gpt', 'codex', 'openai'] },
  { provider: 'gemini', matches: ['gemini'] },
  { provider: 'gemma', matches: ['gemma'] },
  { provider: 'palm', matches: ['palm'] },
  { provider: 'kimi', matches: ['kimi', 'moonshot'] },
  { provider: 'zai', matches: ['glm', 'zai', 'z.ai', 'zhipu'] },
  { provider: 'deepseek', matches: ['deepseek'] },
  { provider: 'minimax', matches: ['minimax'] },
  { provider: 'nvidia', matches: ['nemotron'] },
  { provider: 'grok', matches: ['grok'] },
  { provider: 'meta', matches: ['meta', 'llama'] },
] as const;

/**
 * The thinking levels a model actually offers.
 *
 * One derivation, shared with the transports through `model.ts`: the picker and
 * the value sent to a provider must agree, and `thinkingLevelMap`'s tristate
 * reading is subtle enough that a second copy would eventually disagree.
 */
export const reasoningEffortsFor = effortsFor;

export function toModelInfo(model: PiModel): ModelInfo {
  const efforts = reasoningEffortsFor(model);
  return {
    id: modelKey(model),
    displayName: model.name,
    // The icon comes from the model's identity, not its provider id: a Claude
    // served through `bridge-claude` is still a Claude, and `providerOf` reads
    // the id and name the way the picker's mark needs.
    provider: providerOf(model.id, model.name),
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: efforts.includes('medium') ? 'medium' : (efforts[0] ?? 'off'),
    // "Custom" means "not one of pi's built-ins": everything that arrived
    // through models.json, which is exactly what the Bridge writes.
    isCustom: !BUILTIN_PI_PROVIDERS.has(model.provider),
    deprecated: false,
    contextWindow: model.contextWindow,
  };
}

/**
 * pi's built-in provider ids, used only to decide the `isCustom` badge.
 *
 * A provider missing from this set is badged custom, which is the safe
 * direction to be wrong in: a new built-in shows a Custom pill until this list
 * catches up, rather than a proxied model claiming to be a first-party one.
 */
const BUILTIN_PI_PROVIDERS = new Set([
  'amazon-bedrock',
  'anthropic',
  'azure-openai-responses',
  'baseten',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'deepseek',
  'fireworks',
  'github-copilot',
  'google',
  'google-vertex',
  'groq',
  'huggingface',
  'kimi-coding',
  'minimax',
  'mistral',
  'moonshotai',
  'nvidia',
  'openai',
  'openai-codex',
  'openrouter',
  'together',
  'xai',
  'zai',
]);

/** Every model the runtime can reach right now, picker-shaped. */
export async function availableModels(supportDir: string): Promise<ModelInfo[]> {
  const runtime = await modelRuntime(supportDir);
  const available = await runtime.getAvailable();
  return available.map(toModelInfo);
}

/**
 * Re-read `models.json` and re-check availability.
 *
 * Called after the Bridge writes that file and after a credential changes.
 * Network is left off: a refresh triggered by a login must not stall on a
 * catalog fetch, and the model metadata Foundry cares about is in the file it
 * just wrote.
 */
export async function refreshCatalog(supportDir: string): Promise<void> {
  const runtime = await modelRuntime(supportDir);
  await runtime.refresh({ allowNetwork: false });
}

/**
 * Store a direct provider API key in pi's credential store.
 *
 * The key is written by pi and never by Foundry: no copy is kept, nothing is
 * logged, and the value does not travel back out of this function.
 */
export async function setProviderApiKey(
  supportDir: string,
  providerId: string,
  apiKey: string,
): Promise<void> {
  const runtime = await modelRuntime(supportDir);
  await runtime.login(providerId, 'api_key', {
    // The provider's api-key flow asks for the secret through `prompt`. There
    // is no human here, so the one question it can ask is answered with the key
    // the operator already typed in Settings; any other prompt (a select, a
    // manual code) means this provider needs an interactive flow rather than a
    // key, and rejecting is better than answering it with a secret.
    prompt: (prompt) =>
      prompt.type === 'secret'
        ? Promise.resolve(apiKey)
        : Promise.reject(
            new Error(`${providerId} needs an interactive login rather than an API key`),
          ),
    notify: () => undefined,
  });
  await refreshCatalog(supportDir);
}

/** Remove a stored provider credential. */
export async function clearProviderApiKey(supportDir: string, providerId: string): Promise<void> {
  const runtime = await modelRuntime(supportDir);
  await runtime.logout(providerId);
  await refreshCatalog(supportDir);
}

/**
 * Which providers have a stored credential, and of what kind. Never resolves or
 * returns the secret itself — `CredentialInfo` is metadata by construction.
 */
export async function storedCredentials(
  supportDir: string,
): Promise<{ providerId: string; type: string }[]> {
  const runtime = await modelRuntime(supportDir);
  const credentials = await runtime.listCredentials();
  return credentials.map((credential) => ({
    providerId: credential.providerId,
    type: credential.type,
  }));
}
