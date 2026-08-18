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
import type { TransportModel } from './transport.js';

/** A roster entry may decline to pick a model and take this install's default. */
export const INHERIT_MODEL = 'inherit';

export type PiModel = NonNullable<PiAgentSession['model']>;
export type PiThinkingLevel = PiAgentSession['thinkingLevel'];
export type PiUsage = NonNullable<ReturnType<typeof getLastAssistantUsage>>;

/** Pi's thinking levels are a superset of `ReasoningEffort`, name for name. */
export function thinkingLevelFor(effort: string): PiThinkingLevel {
  return effort as PiThinkingLevel;
}

export function toTransportModel(model: PiModel): TransportModel {
  const levels = model.thinkingLevelMap
    ? Object.entries(model.thinkingLevelMap)
        .filter(([, value]) => value !== null)
        .map(([level]) => level)
    : model.reasoning
      ? ['off', 'low', 'medium', 'high']
      : ['off'];
  return {
    id: `${model.provider}/${model.id}`,
    displayName: model.name,
    provider: model.provider,
    supportedReasoningEfforts: levels,
    defaultReasoningEffort: levels.includes('medium') ? 'medium' : (levels[0] ?? 'off'),
    contextWindow: model.contextWindow,
  };
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
  const match = available.find(
    (model) => `${model.provider}/${model.id}` === wanted || model.id === wanted,
  );
  if (match) return { model: match };
  const fallback = available[0] ?? null;
  return {
    model: fallback,
    warning: fallback
      ? `${wanted} is not available to this install; this session runs on ${fallback.provider}/${fallback.id}`
      : `${wanted} is not available to this install, and neither is anything else`,
  };
}
