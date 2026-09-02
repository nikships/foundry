/**
 * CLIProxyAPI's model catalog, projected onto the providers Foundry can log into.
 *
 * The file is the one that ships with the pinned Bridge (`fetch:bridge` writes
 * it next to the binary). Foundry does not keep its own model list: a new model
 * in that file appears the next time models.json is regenerated. The only
 * mapping this module owns is *which catalog channels a login unlocks* — Claude
 * OAuth cannot start serving Vertex just because a channel showed up.
 *
 * Unknown fields on a catalog entry are ignored, so a CLIProxyAPI bump that
 * adds metadata does not break parsing.
 */

import { readFileSync } from 'node:fs';
import { bridgeCatalogPath } from './paths.js';
import {
  BRIDGE_MODEL_DENYLIST,
  isDeniedModel,
  type BridgeModelDenylist,
} from './model-denylist.js';
import type { BridgeProviderId } from './providers.js';

/** One model as CLIProxyAPI's models.json writes it. Extra keys are allowed. */
export interface CliproxyModel {
  id: string;
  display_name?: string;
  displayName?: string;
  name?: string;
  thinking?: CliproxyThinking | null;
  context_length?: number;
  max_completion_tokens?: number;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedInputModalities?: string[];
  supportedOutputModalities?: string[];
}

interface CliproxyThinking {
  levels?: string[];
  zero_allowed?: boolean;
}

/** Channel name → models, as the file is keyed. */
export type CliproxyCatalog = Record<string, CliproxyModel[]>;

/** A catalog model ready to land in pi's models.json (cost is applied later). */
export interface CatalogModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
}

const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Claude's adaptive-thinking compat, applied to every anthropic-messages model. */
const CLAUDE_COMPAT = { forceAdaptiveThinking: true, supportsStrictTools: true };

/** Which pi thinking dialect a provider's levels are translated into. */
type ThinkingKind = 'claude' | 'codex' | 'default';

/**
 * Levels a provider pins whatever the catalog offers: Claude has no discrete
 * low tier to expose, and Codex spells "no thinking" `none`.
 */
const PINNED_THINKING_LEVELS: Record<ThinkingKind, Record<string, string | null>> = {
  claude: { off: null, minimal: null },
  codex: { off: 'none', minimal: null },
  default: {},
};

/** Codex plan channels, poorest tier first. Unlisted channels rank lowest. */
const CODEX_CHANNEL_TIERS = ['codex-free', 'codex-team', 'codex-plus', 'codex-pro'];

/**
 * Reads the vendored catalog, or an empty document when the file is missing
 * or unparseable. A checkout that skipped `fetch:bridge` has no catalog, and
 * an empty result is what keeps regeneration from throwing over that.
 */
export function loadBridgeCatalog(catalogPath = bridgeCatalogPath()): CliproxyCatalog {
  if (!catalogPath) return {};
  try {
    return parseCliproxyCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')));
  } catch {
    return {};
  }
}

/**
 * Accepts the on-disk document (or a test fixture) and drops anything that
 * is not a channel → model-array entry with an id.
 */
export function parseCliproxyCatalog(value: unknown): CliproxyCatalog {
  if (!isRecord(value)) return {};
  const out: CliproxyCatalog = {};
  for (const [channel, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) continue;
    const models = entries
      .map(asCliproxyModel)
      .filter((model): model is CliproxyModel => model !== null);
    if (models.length) out[channel] = models;
  }
  return out;
}

/**
 * Every agent-usable model the given login unlocks, in catalog order.
 *
 * This is the one funnel every Bridge model passes through on its way into
 * pi's models.json, so the operator's denylist is applied here rather than at
 * each consumer: filtering later would leave a model the picker hides but the
 * roster could still name.
 */
export function modelsForProvider(
  catalog: CliproxyCatalog,
  provider: BridgeProviderId,
  denylist: BridgeModelDenylist = BRIDGE_MODEL_DENYLIST,
): CatalogModel[] {
  const kind = thinkingKind(provider);
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const channel of channelsForProvider(provider, Object.keys(catalog))) {
    for (const model of catalog[channel] ?? []) {
      if (seen.has(model.id) || !isAgentModel(model)) continue;
      seen.add(model.id);
      if (isDeniedModel(provider, model.id, denylist)) continue;
      out.push(toCatalogModel(model, kind));
    }
  }
  return out;
}

/**
 * Which catalog channels a Foundry login exposes.
 *
 * Prefix matches are deliberate for Codex: a future `codex-ultra` tier should
 * land without a Foundry change. Gemini stays pinned to `antigravity` because
 * that is the login we run; the `gemini` / `vertex` / `aistudio` channels are
 * different executors we have no OAuth for.
 */
export function channelsForProvider(
  provider: BridgeProviderId,
  channels: readonly string[],
): string[] {
  const match = (channel: string): boolean => {
    switch (provider) {
      case 'claude':
        return channel === 'claude';
      case 'codex':
        return channel === 'codex' || channel.startsWith('codex-');
      case 'gemini':
        return channel === 'antigravity';
      case 'kimi':
        return channel === 'kimi';
      case 'grok':
        return channel === 'xai' || channel === 'grok';
    }
  };
  const matched = channels.filter(match);
  // Codex: walk richer tiers first so an id that appears in several plans
  // keeps the pro metadata, then append ids that only a newer tier added.
  if (provider === 'codex') {
    return matched.sort((a, b) => codexChannelRank(b) - codexChannelRank(a));
  }
  return matched;
}

function codexChannelRank(channel: string): number {
  return CODEX_CHANNEL_TIERS.indexOf(channel) + 1;
}

function thinkingKind(provider: BridgeProviderId): ThinkingKind {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  return 'default';
}

/**
 * An agent phase needs a model that emits text and nothing else. Generators
 * stay in CLIProxyAPI's catalog for other clients; offering them here would put
 * a model in the picker and the Orchestrator's cast pool that every phase then
 * fails on.
 *
 * The test is "declares an image output", not "declares no text output".
 * `imagen-*` is image-only and was always caught, but an image-generating
 * Gemini declares `["text", "image"]` — the commentary beside the picture — so
 * a check for text passed it through. Nothing Foundry runs wants a picture
 * back, so any model that can emit one is a generator.
 *
 * A model that declares no modalities at all is kept: CLIProxyAPI omits the
 * field for some entries, and the failure that matters is silently hiding a
 * working text model, not showing one extra.
 */
export function isAgentModel(model: CliproxyModel): boolean {
  const outputs = model.supportedOutputModalities;
  if (!outputs || outputs.length === 0) return true;
  return !outputs.some((modality) => modality.toLowerCase() === 'image');
}

function toCatalogModel(model: CliproxyModel, kind: ThinkingKind): CatalogModel {
  const thinking = model.thinking ?? undefined;
  const input = modalities(model.supportedInputModalities);
  const converted: CatalogModel = {
    id: model.id,
    name: model.display_name || model.displayName || model.name || model.id,
    reasoning: thinking != null,
    input: input.length ? input : ['text'],
    contextWindow: numberOr(model.context_length ?? model.inputTokenLimit, 128_000),
    maxTokens: numberOr(model.max_completion_tokens ?? model.outputTokenLimit, 32_768),
  };
  const map = thinkingLevelMap(thinking, kind);
  if (map) converted.thinkingLevelMap = map;
  if (kind === 'claude') converted.compat = { ...CLAUDE_COMPAT };
  return converted;
}

function thinkingLevelMap(
  thinking: CliproxyThinking | undefined,
  kind: ThinkingKind,
): Record<string, string | null> | undefined {
  if (!thinking?.levels?.length) return undefined;
  const pinned = PINNED_THINKING_LEVELS[kind];
  const offered = new Set(thinking.levels.map((level) => level.toLowerCase()));
  const map: Record<string, string | null> = {};
  for (const level of PI_LEVELS) {
    if (level in pinned) {
      map[level] = pinned[level] ?? null;
    } else if (level === 'off' && thinking.zero_allowed) {
      map[level] = 'off';
    } else {
      map[level] = offered.has(level) ? level : null;
    }
  }
  return map;
}

function modalities(values: string[] | undefined): ('text' | 'image')[] {
  if (!values) return ['text', 'image'];
  const out: ('text' | 'image')[] = [];
  for (const value of values) {
    const lower = value.toLowerCase();
    if ((lower === 'text' || lower === 'image') && !out.includes(lower)) out.push(lower);
  }
  return out;
}

function asCliproxyModel(value: unknown): CliproxyModel | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim();
  if (!id) return null;
  return {
    id,
    display_name: asString(value.display_name),
    displayName: asString(value.displayName),
    name: asString(value.name),
    thinking: asThinking(value.thinking),
    context_length: asNumber(value.context_length),
    max_completion_tokens: asNumber(value.max_completion_tokens),
    inputTokenLimit: asNumber(value.inputTokenLimit),
    outputTokenLimit: asNumber(value.outputTokenLimit),
    supportedInputModalities: asStringArray(value.supportedInputModalities),
    supportedOutputModalities: asStringArray(value.supportedOutputModalities),
  };
}

/** Distinguishes "no thinking block" (undefined) from an explicit null. */
function asThinking(value: unknown): CliproxyThinking | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  return {
    levels: asStringArray(value.levels),
    zero_allowed: typeof value.zero_allowed === 'boolean' ? value.zero_allowed : undefined,
  };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
