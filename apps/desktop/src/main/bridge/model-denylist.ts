/**
 * Bridge models this install does not want offered, keyed by login.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS MEANT TO BE EDITED BY HAND. It is the whole configuration.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A CLIProxyAPI subscription serves everything the plan includes — a decade of
 * superseded checkpoints, per-effort duplicates of one model, and executors
 * that happen to share a channel. All of it lands in the picker, in Settings,
 * and in the Orchestrator's cast pool, where every extra id is one more thing
 * to scroll past and one more model a plan can be cast onto by mistake.
 * Removing an id here removes it from all of them at once.
 *
 * **It is a denylist, not an allowlist.** An id absent from this file is
 * offered. That is the deliberate trade: a CLIProxyAPI bump that adds
 * `grok-4.7` shows it immediately rather than hiding a new flagship behind a
 * Foundry edit, and the cost is that a new model you do not want needs a line
 * here. Do not invert this into an allowlist without rereading that sentence —
 * an allowlist silently withholds every future model until someone notices.
 *
 * **A stale entry is inert.** Ids are matched against the catalog, never
 * resolved from it, so an id that no longer ships (a retired model, a renamed
 * one, a typo) simply matches nothing. Nothing throws, nothing is logged, and
 * no other model is affected. Leaving a retired id here costs nothing, which
 * is why this file never needs pruning.
 *
 * **Match is exact, on the bare catalog id**, lowercased and trimmed. That is
 * the id CLIProxyAPI writes (`grok-4.5`, `gemini-3.5-flash-low`), not the
 * provider-qualified one Foundry shows elsewhere (`bridge-grok/grok-4.5`).
 * Per-effort variants are separate ids and each needs its own line.
 *
 * To restore a model, delete its line. To silence a new one, add it. There is
 * no wildcard: a pattern that quietly swallowed a future flagship is the one
 * failure this file is shaped to avoid.
 */

import type { BridgeProviderId } from './providers.js';

export type BridgeModelDenylist = Partial<Record<BridgeProviderId, readonly string[]>>;

export const BRIDGE_MODEL_DENYLIST: BridgeModelDenylist = {
  // Grok: keep grok-4.6.
  grok: [
    'grok-4.5',
    'grok-4.3',
    'grok-build-0.1',
    'grok-composer-2.5-fast',
    'grok-3-mini',
    'grok-3-mini-fast',
    // The 4.20 line is exposed as three separate ids, one per mode.
    'grok-4.20-0309-reasoning',
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-multi-agent-0309',
  ],

  // ChatGPT (Codex): keep the 5.6 line (sol, terra, luna).
  codex: [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.3-codex-spark',
    // Not a chat model: a review executor that shares the codex channel.
    'codex-auto-review',
  ],

  // Gemini (Antigravity): keep gemini-3.7-flash-high and gemini-3.1-pro-low.
  // The channel also carries other vendors' models, which belong to their own
  // logins where they arrive with the right thinking dialect and compat flags.
  gemini: [
    'claude-opus-4-6-thinking',
    'claude-sonnet-4-6',
    'gpt-oss-120b-medium',
    'gemini-3-flash',
    'gemini-3-flash-agent',
    'gemini-pro-agent',
    'gemini-3.6-flash-high',
    'gemini-3.1-flash-lite',
    'gemini-3.5-flash-low',
    'gemini-3.5-flash-extra-low',
  ],

  // Kimi: keep the k2.7 code line and k3.
  kimi: [
    'kimi-k2',
    // A separate id, not a mode of the one above: exact matching means the
    // base id does not cover it.
    'kimi-k2-thinking',
    'kimi-k2.5',
    'kimi-k2.6',
  ],
};

/** True when this login should not offer the given bare catalog id. */
export function isDeniedModel(
  provider: BridgeProviderId,
  modelId: string,
  denylist: BridgeModelDenylist = BRIDGE_MODEL_DENYLIST,
): boolean {
  const denied = denylist[provider];
  if (!denied?.length) return false;
  const needle = modelId.trim().toLowerCase();
  return denied.some((entry) => entry.trim().toLowerCase() === needle);
}
