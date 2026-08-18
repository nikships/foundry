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
    const models: CliproxyModel[] = [];
    for (const entry of entries) {
      const model = asCliproxyModel(entry);
      if (model) models.push(model);
    }
    if (models.length) out[channel] = models;
  }
  return out;
}

/** Every agent-usable model the given login unlocks, in catalog order. */
export function modelsForProvider(
  catalog: CliproxyCatalog,
  provider: BridgeProviderId,
): CatalogModel[] {
  const kind = thinkingKind(provider);
  const seen = new Set<string>();
  const out: CatalogModel[] = [];
  for (const channel of channelsForProvider(provider, Object.keys(catalog))) {
    for (const model of catalog[channel] ?? []) {
      if (seen.has(model.id) || !isAgentModel(model)) continue;
      seen.add(model.id);
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
  // Codex: walk richer tiers first so an id that appears in several plans
  // keeps the pro metadata, then append ids that only a newer tier added.
  const matched = channels.filter(match);
  if (provider === 'codex') {
    return [...matched].sort((a, b) => codexChannelRank(b) - codexChannelRank(a));
  }
  return matched;
}

function codexChannelRank(channel: string): number {
  if (channel === 'codex-pro') return 4;
  if (channel === 'codex-plus') return 3;
  if (channel === 'codex-team') return 2;
  if (channel === 'codex-free') return 1;
  return 0;
}

function thinkingKind(provider: BridgeProviderId): 'claude' | 'codex' | 'default' {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  return 'default';
}

/**
 * An agent phase needs a model that can emit text. Image- and video-only
 * entries stay in CLIProxyAPI's catalog for other clients; offering them here
 * would put a generator in the picker that every phase then fails on.
 */
export function isAgentModel(model: CliproxyModel): boolean {
  const outputs = model.supportedOutputModalities;
  if (!outputs || outputs.length === 0) return true;
  return outputs.some((modality) => modality.toLowerCase() === 'text');
}

function toCatalogModel(model: CliproxyModel, kind: 'claude' | 'codex' | 'default'): CatalogModel {
  const thinking = model.thinking ?? undefined;
  const name = model.display_name || model.displayName || model.name || model.id;
  const input = modalities(model.supportedInputModalities);
  const converted: CatalogModel = {
    id: model.id,
    name,
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
  kind: 'claude' | 'codex' | 'default',
): Record<string, string | null> | undefined {
  if (!thinking?.levels?.length) return undefined;
  const offered = new Set(thinking.levels.map((level) => level.toLowerCase()));
  const map: Record<string, string | null> = {};
  for (const level of PI_LEVELS) {
    if (kind === 'claude' && (level === 'off' || level === 'minimal')) {
      map[level] = null;
      continue;
    }
    if (kind === 'codex' && level === 'off') {
      map[level] = 'none';
      continue;
    }
    if (kind === 'codex' && level === 'minimal') {
      map[level] = null;
      continue;
    }
    if (level === 'off' && thinking.zero_allowed) {
      map[level] = 'off';
      continue;
    }
    map[level] = offered.has(level) ? level : null;
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
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id) return null;
  const model: CliproxyModel = { id };
  if (typeof value.display_name === 'string') model.display_name = value.display_name;
  if (typeof value.displayName === 'string') model.displayName = value.displayName;
  if (typeof value.name === 'string') model.name = value.name;
  if (value.thinking && typeof value.thinking === 'object' && !Array.isArray(value.thinking)) {
    const raw = value.thinking as Record<string, unknown>;
    const thinking: CliproxyThinking = {};
    if (Array.isArray(raw.levels)) {
      thinking.levels = raw.levels.filter((level): level is string => typeof level === 'string');
    }
    if (typeof raw.zero_allowed === 'boolean') thinking.zero_allowed = raw.zero_allowed;
    model.thinking = thinking;
  } else if (value.thinking === null) {
    model.thinking = null;
  }
  if (typeof value.context_length === 'number') model.context_length = value.context_length;
  if (typeof value.max_completion_tokens === 'number') {
    model.max_completion_tokens = value.max_completion_tokens;
  }
  if (typeof value.inputTokenLimit === 'number') model.inputTokenLimit = value.inputTokenLimit;
  if (typeof value.outputTokenLimit === 'number') model.outputTokenLimit = value.outputTokenLimit;
  if (Array.isArray(value.supportedInputModalities)) {
    model.supportedInputModalities = value.supportedInputModalities.filter(
      (item): item is string => typeof item === 'string',
    );
  }
  if (Array.isArray(value.supportedOutputModalities)) {
    model.supportedOutputModalities = value.supportedOutputModalities.filter(
      (item): item is string => typeof item === 'string',
    );
  }
  return model;
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
