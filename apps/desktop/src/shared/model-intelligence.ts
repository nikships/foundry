/**
 * The Artificial Analysis Intelligence Index for a model id, when one exists.
 *
 * The table is vendored (`model-intelligence.json`, refreshed by
 * `npm run fetch:intelligence`) rather than fetched, because the Orchestrator's
 * planning rail must work offline and a score is advisory: it improves a
 * casting decision but no run depends on it.
 *
 * Matching is by normalized id, not exact string. Foundry's ids are
 * provider-qualified (`bridge-claude/claude-opus-5-20250514`) and CLIProxyAPI
 * mints one id per thinking level (`gemini-3.5-flash-extra-low`), while the
 * published index names the model once. Normalization strips the provider, the
 * date stamp, the preview tag, and the effort suffix so those all resolve to
 * the measured model.
 *
 * An unmatched id is `undefined`, never 0. Bridge-invented variants
 * (`grok-4.20-multi-agent-0309`) and models the index has retired both land
 * there, and scoring them zero would rank a current flagship below a small
 * measured model.
 *
 * Data: Artificial Analysis (https://artificialanalysis.ai). Attribution is
 * required by their terms; it also rides in the JSON file's `source` field.
 */

import table from './model-intelligence.json' with { type: 'json' };

/**
 * Suffixes CLIProxyAPI appends to expose one model at several thinking levels.
 * Kept in sync with `scripts/fetch-intelligence.mjs`, which normalizes the
 * published ids the same way — the two sides must agree or nothing matches.
 */
const EFFORT_SUFFIXES = [
  '-non-reasoning',
  '-reasoning',
  '-extra-low',
  '-highspeed',
  '-thinking',
  '-medium',
  '-agent',
  '-high',
  '-fast',
  '-low',
  '-256k',
] as const;

export function normalizeModelId(id: string): string {
  let value = id.toLowerCase().split('/').pop() ?? '';
  value = value.split(':')[0] ?? '';
  value = value.replace(/-20\d{6}/g, '');
  value = value.replace(/-(preview|latest|exp)\b/g, '');
  for (;;) {
    const hit = EFFORT_SUFFIXES.find((suffix) => value.endsWith(suffix));
    if (!hit) break;
    value = value.slice(0, -hit.length);
  }
  value = value.replace(/(\d)[-_](\d)/g, '$1.$2');
  return value.replace(/[^a-z0-9.]+/g, '');
}

const SCORES: Record<string, number> = table.scores;

/** The published score for a model id, or undefined when it is unrated. */
export function intelligenceFor(id: string): number | undefined {
  return SCORES[normalizeModelId(id)];
}
