/**
 * Which reasoning efforts a model actually offers, and what to do with a
 * choice it does not.
 *
 * Pure and shared because the same answer is needed on both sides of the IPC
 * seam: a picker must not offer a level the provider would reject, and the
 * transport must not send one. A model's capability list is authoritative
 * (`pi/catalog.ts:reasoningEffortsFor` derives it from pi's own thinking-level
 * map), so the fallback order is the model's default first and `off` last —
 * `off` is the one level every model has.
 */

import type { ReasoningEffort } from './types.js';

/**
 * Every level Foundry knows, in ascending order. Not a per-model list.
 *
 * A non-empty readonly tuple rather than an array, so `z.enum()` can be built
 * from it: the store's schemas derive from this one declaration instead of
 * repeating the literals, and a new level cannot be half-added.
 */
export const REASONING_EFFORTS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[];

/** The capability slice of `ModelInfo` / `TransportModel` this module reads. */
export interface ReasoningCapableModel {
  supportedReasoningEfforts: readonly string[];
  defaultReasoningEffort?: string;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

/**
 * The catalog entry an effort picker should filter by.
 *
 * `inherit` (or an empty choice) defers to `fallback`, which is how helper
 * effort follows the default model. A concrete id the catalog does not offer
 * is null rather than the fallback — the stored choice is gone, and showing
 * another model's levels would be a lie. Null means the picker has nothing
 * to filter against and offers every known level.
 */
function chosenModelId(value: string | null | undefined): string | null {
  return value && value !== 'inherit' ? value : null;
}

export function modelForEffortPicker<T extends { id: string }>(
  chosen: string | null | undefined,
  models: readonly T[],
  fallback?: string | null,
): T | null {
  const id = chosenModelId(chosen) ?? chosenModelId(fallback);
  if (!id) return null;
  return models.find((model) => model.id === id) ?? null;
}

/**
 * What a picker may offer for this model, in Foundry's own order.
 *
 * A model Foundry cannot see (`inherit`, or a catalog that has not loaded)
 * yields every level: offering the full set is better than offering nothing,
 * and the transport clamps against the real model once the session opens.
 */
export function supportedReasoningEfforts(
  model: ReasoningCapableModel | null | undefined,
): ReasoningEffort[] {
  if (!model) return [...REASONING_EFFORTS];
  const supported = REASONING_EFFORTS.filter((effort) =>
    model.supportedReasoningEfforts.includes(effort),
  );
  return supported.length ? supported : ['off'];
}

/**
 * The effort this model can actually run at: the one asked for when it is
 * supported, then the model's own default, then `off`. An unknown model is
 * taken at the caller's word — there is nothing to normalize against.
 */
export function normalizeReasoningEffort(
  wanted: ReasoningEffort,
  model: ReasoningCapableModel | null | undefined,
): ReasoningEffort {
  if (!model) return wanted;
  const supported = supportedReasoningEfforts(model);
  if (supported.includes(wanted)) return wanted;
  const fallback = model.defaultReasoningEffort;
  if (isReasoningEffort(fallback) && supported.includes(fallback)) return fallback;
  return supported[0] ?? 'off';
}

/** Normalize an effort as the operator changes the model it belongs to. */
export function normalizeReasoningEffortForModelChoice<
  T extends ReasoningCapableModel & {
    id: string;
  },
>(
  wanted: ReasoningEffort,
  chosen: string,
  models: readonly T[],
  fallback?: string | null,
): ReasoningEffort {
  return normalizeReasoningEffort(wanted, modelForEffortPicker(chosen, models, fallback));
}
