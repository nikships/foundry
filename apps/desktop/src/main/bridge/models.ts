/**
 * Generates the Bridge's half of pi's `models.json`.
 *
 * pi discovers custom providers from a JSON file under its agent directory.
 * Foundry owns the `bridge-*` provider entries in that file and nothing else:
 * an operator who hand-added an Ollama or vLLM provider must still have it
 * after a login, so every write reads the current file, replaces only the keys
 * this module owns, and preserves the rest verbatim.
 *
 * Three properties the tests pin, because each one fails silently otherwise:
 *
 * - **Deterministic.** Providers and models come out in table order, keys in a
 *   fixed order, so the same auth state produces byte-identical output. That is
 *   what makes "did anything change" a string comparison rather than a diff.
 * - **Atomic.** Written to a sibling temp file and renamed. pi re-reads this
 *   file whenever the model list is opened; a half-written file read mid-write
 *   is a corrupted catalog, and rename is the only cheap way to rule it out.
 * - **Only authenticated providers.** A provider with no usable account is
 *   absent, not present-and-unavailable. pi would list its models and fail at
 *   request time, which reads as a broken model rather than a missing login.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBridgeCatalog, modelsForProvider, type CliproxyCatalog } from './catalog.js';
import { BRIDGE_MODEL_DENYLIST, type BridgeModelDenylist } from './model-denylist.js';
import {
  BRIDGE_PROVIDERS,
  isBridgeProviderId,
  piProviderId,
  type BridgeProviderId,
} from './providers.js';
import type { ModelCost } from '@shared/types.js';

/** A provider entry in pi's models.json, as this module writes one. */
export interface GeneratedProvider {
  name: string;
  baseUrl: string;
  api: string;
  /**
   * The Bridge authenticates upstream itself, so no real key exists. pi still
   * requires *some* configured auth before a model is offered in the picker, so
   * a placeholder is what makes these models selectable at all.
   */
  apiKey: string;
  models: GeneratedModel[];
}

export interface GeneratedModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

export type ModelsJson = { providers?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Cost is reported as zero for every Bridge model.
 *
 * These run against a subscription the operator already pays for. Pi's
 * models.json still requires a rate card; zeros are the honest one.
 */
const SUBSCRIPTION_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * The `bridge-*` provider entries for the given authenticated providers.
 *
 * `denylist` defaults to the operator's shipped list and exists as a parameter
 * so a test can pin projection mechanics without moving every time that list
 * is edited.
 */
export function generateProviders(
  authenticated: readonly BridgeProviderId[],
  baseUrl: string,
  catalog: CliproxyCatalog,
  denylist: BridgeModelDenylist = BRIDGE_MODEL_DENYLIST,
): Record<string, GeneratedProvider> {
  const wanted = new Set(authenticated);
  const out: Record<string, GeneratedProvider> = {};
  // Table order, not the caller's: two callers passing the same set in a
  // different order must produce the same file.
  for (const provider of BRIDGE_PROVIDERS) {
    if (!wanted.has(provider.id)) continue;
    out[piProviderId(provider.id)] = {
      name: `${provider.label} (Bridge)`,
      baseUrl: `${trimSlash(baseUrl)}${provider.baseUrlSuffix}`,
      api: provider.api,
      apiKey: 'foundry-bridge',
      models: modelsForProvider(catalog, provider.id, denylist).map((model) => ({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        input: [...model.input],
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        cost: { ...SUBSCRIPTION_COST },
        ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
        ...(model.compat ? { compat: { ...model.compat } } : {}),
      })),
    };
  }
  return out;
}

/**
 * Merges generated entries into an existing models.json document.
 *
 * Bridge-owned keys are dropped and re-added, so a provider that lost its last
 * account disappears. Everything else — foreign providers, unknown top-level
 * fields — is carried through untouched.
 */
export function mergeModelsJson(
  current: ModelsJson | null,
  generated: Record<string, GeneratedProvider>,
): ModelsJson {
  const base = current ?? {};
  const existing = isRecord(base.providers) ? base.providers : {};
  const providers: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!isBridgeProviderId(key)) providers[key] = value;
  }
  for (const [key, value] of Object.entries(generated)) providers[key] = value;
  return { ...base, providers };
}

/** Reads models.json, treating an absent or unparseable file as empty. */
export function readModelsJson(modelsPath: string): ModelsJson | null {
  const raw = readFileOrNull(modelsPath);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as ModelsJson) : null;
  } catch {
    return null;
  }
}

export interface WriteModelsResult {
  /** False when the rendered document was byte-identical to what was on disk. */
  changed: boolean;
  path: string;
}

/**
 * Writes models.json atomically, and only when it would differ.
 *
 * The "only when it would differ" half is what keeps `modelRuntime.refresh()`
 * from being called on every filesystem burst: an auth directory emits several
 * change events for one login, and each would otherwise rebuild pi's catalog.
 */
export function writeModelsJson(modelsPath: string, next: ModelsJson): WriteModelsResult {
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  if (readFileOrNull(modelsPath) === rendered) return { changed: false, path: modelsPath };

  // pi builds its own directory when a runtime is first created, and a Bridge
  // login can easily happen before any run has done that.
  mkdirSync(dirname(modelsPath), { recursive: true });
  const tmp = join(dirname(modelsPath), `.models.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, rendered, { mode: 0o600 });
    renameSync(tmp, modelsPath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; the original error is what matters.
    }
    throw error;
  }
  return { changed: true, path: modelsPath };
}

/**
 * The whole regeneration: read, merge, write. Returns whether anything moved,
 * so the caller knows whether a `modelRuntime.refresh()` is owed.
 */
export function regenerateModels(input: {
  modelsPath: string;
  authenticated: readonly BridgeProviderId[];
  baseUrl: string;
  /** Test seam. Production reads the catalog `fetch:bridge` left next to the binary. */
  catalog?: CliproxyCatalog;
}): WriteModelsResult {
  const catalog = input.catalog ?? loadBridgeCatalog();
  if (input.authenticated.length > 0 && Object.keys(catalog).length === 0) {
    console.warn(
      '[bridge] no CLIProxyAPI model catalog; run npm run fetch:bridge so subscription logins expose models',
    );
  }
  const generated = generateProviders(input.authenticated, input.baseUrl, catalog);
  const merged = mergeModelsJson(readModelsJson(input.modelsPath), generated);
  return writeModelsJson(input.modelsPath, merged);
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
