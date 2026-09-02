/**
 * Which model a session runs on, and the two levers that travel with it.
 *
 * Pinned in its own file because both session shapes need the same answer: the
 * long-lived transport an agent phase runs on, and the short-lived one-shot a
 * detection or a repair opens. A second copy of "the roster asked for a model
 * this install cannot reach" would eventually disagree with the first.
 *
 * Pi's model, thinking-level, and usage types are read back off its own API
 * rather than imported from their declaring packages (`pi-agent-core`,
 * `pi-ai`), which are transitive dependencies of `pi-coding-agent` and not
 * Foundry's own.
 */

import type {
  AgentSession as PiAgentSession,
  getLastAssistantUsage,
} from '@earendil-works/pi-coding-agent';
import { MODEL_UNSET_MESSAGE, modelUnavailableMessage } from '@shared/model-choice.js';
import { REASONING_EFFORTS, normalizeReasoningEffort } from '@shared/reasoning-effort.js';
import type { ReasoningEffort } from '@shared/types.js';
import type { TransportModel } from './transport.js';

/**
 * A roster entry may decline to pick a model and take this install's default.
 *
 * For Smith this sentinel means "nothing chosen yet" rather than "choose for
 * me": `requireModel` refuses it instead of letting the runtime pick.
 */
export const INHERIT_MODEL = 'inherit';

export type PiModel = NonNullable<PiAgentSession['model']>;
export type PiThinkingLevel = PiAgentSession['thinkingLevel'];
export type PiUsage = NonNullable<ReturnType<typeof getLastAssistantUsage>>;

/**
 * Provider-qualified, because that is the id a roster stores and the
 * transports match on. A bare `claude-opus-5` is ambiguous the moment both
 * `anthropic` and `bridge-claude` offer it.
 */
export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

/** Prefer medium when offered, else the first supported level, else off. */
export function defaultEffortFor(efforts: readonly string[]): string {
  return efforts.includes('medium') ? 'medium' : (efforts[0] ?? 'off');
}

function matchesWanted(model: { provider: string; id: string }, wanted: string): boolean {
  return modelKey(model) === wanted || model.id === wanted;
}

/** Pi's thinking levels are a superset of `ReasoningEffort`, name for name. */
export function thinkingLevelFor(effort: string): PiThinkingLevel {
  return effort as PiThinkingLevel;
}

/**
 * The thinking levels a model actually offers.
 *
 * `thinkingLevelMap` is **tristate, not an allowlist** (`references/models.md`,
 * "Thinking Level Map"): a string means supported, `null` means unsupported,
 * and an **omitted** key means `off` / `low` / `medium` / `high` fall back to
 * the provider's default mapping, while `minimal` / `xhigh` / `max` are
 * unsupported unless named. Maps are routinely partial — `{"max": "max"}` is a
 * model that adds `max` on top of the standard four, not one that offers `max`
 * alone.
 *
 * `minimal` is opt-in even though pi lists it among the standard levels: most
 * providers reject it, and offering it from an omitted key would put a value
 * in the picker that OpenAI and Claude refuse. A Bridge model that supports it
 * names it in CLIProxyAPI's `thinking.levels`, which becomes a string entry
 * here.
 *
 * Reading the map as an allowlist is therefore wrong in the expensive
 * direction: of the 1004 reasoning models in the pinned catalog, 400 carry a
 * map and 277 of those would have had `medium` rewritten to something else,
 * `{"max": "max"}` models silently to `max`.
 */
export function effortsFor(model: Pick<PiModel, 'reasoning' | 'thinkingLevelMap'>): string[] {
  if (!model.reasoning) return ['off'];
  const map = model.thinkingLevelMap as Record<string, unknown> | undefined;
  const offered = REASONING_EFFORTS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (mapped === undefined && OMITTED_UNSUPPORTED.has(level)) return false;
    return true;
  });
  // Every model can decline to think, so a map that nulls out everything still
  // leaves `off` rather than an empty list no picker could render.
  return offered.length ? [...offered] : ['off'];
}

/** Available only when the map names them: omitted means unsupported. */
const OMITTED_UNSUPPORTED: ReadonlySet<string> = new Set(['minimal', 'xhigh', 'max']);

export function toTransportModel(model: PiModel): TransportModel {
  const levels = effortsFor(model);
  return {
    id: modelKey(model),
    displayName: model.name,
    provider: model.provider,
    supportedReasoningEfforts: levels,
    defaultReasoningEffort: defaultEffortFor(levels),
    contextWindow: model.contextWindow,
  };
}

/**
 * The effort this model can actually run at.
 *
 * A level outside the resolved model's thinking-level map would be rejected by
 * the provider, so it is replaced by that model's default and then `off`.
 * A null model is `inherit` or a fallback the runtime chose for itself; there
 * is nothing to clamp against, so the caller's choice stands.
 */
export function clampEffortToModel(
  effort: ReasoningEffort,
  model: PiModel | null,
): ReasoningEffort {
  return normalizeReasoningEffort(effort, model ? toTransportModel(model) : null);
}

/**
 * Why a chosen model cannot be used, or ok when it can.
 *
 * Callers that must not silently substitute a model use this instead of
 * `pickModel`. Both answers are refusals rather than fallbacks: running a
 * different model than the operator picked is the failure being prevented.
 * The copy comes from the shared module the renderer's gate reads, so the
 * disabled composer and this refusal always give the same reason.
 */
export function requireModel(
  available: readonly PiModel[],
  wanted: string,
): { ok: true } | { ok: false; reason: 'unset' | 'unavailable'; message: string } {
  if (!wanted || wanted === INHERIT_MODEL) {
    return { ok: false, reason: 'unset', message: MODEL_UNSET_MESSAGE };
  }
  const match = available.some((model) => matchesWanted(model, wanted));
  if (match) return { ok: true };
  return { ok: false, reason: 'unavailable', message: modelUnavailableMessage(wanted) };
}

/**
 * Pick the model the caller asked for. A caller may decline to choose, and a
 * model the install cannot reach is a warning rather than a failure: the turn
 * still runs, on something, and the trace says what happened.
 */
export function pickModel(
  available: readonly PiModel[],
  wanted: string,
): { model: PiModel | null; warning?: string } {
  if (!wanted || wanted === INHERIT_MODEL) return { model: null };
  const match = available.find((model) => matchesWanted(model, wanted));
  if (match) return { model: match };
  const fallback = available[0] ?? null;
  return {
    model: fallback,
    warning: fallback
      ? `${wanted} is not available to this install; this session runs on ${modelKey(fallback)}`
      : `${wanted} is not available to this install, and neither is anything else`,
  };
}
