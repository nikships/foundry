/**
 * Soft persistence for which mind plans a run.
 *
 * Lives outside ComposePicker so the app shell can restore the choice
 * without importing the picker (and the model catalog UI) on first paint.
 */
import type { ReasoningEffort } from '@shared/types.js';
import { isReasoningEffort } from '@shared/reasoning-effort.js';
import { safeGetItem, safeSetItem } from './local-store.js';

export const COMPOSE_MODEL_KEY = 'foundry.orchestrator.model';
export const COMPOSE_REASONING_KEY = 'foundry.orchestrator.reasoning';

export interface ComposeChoice {
  model: string;
  reasoningEffort: ReasoningEffort;
}

/**
 * The softly persisted appointment: localStorage, not `AppSettings`, because
 * which mind runs the planning is a preference of this machine's operator,
 * not of the install.
 */
export function loadComposeChoice(): ComposeChoice {
  const reasoning = safeGetItem(COMPOSE_REASONING_KEY);
  return {
    model: safeGetItem(COMPOSE_MODEL_KEY) ?? 'inherit',
    reasoningEffort: isReasoningEffort(reasoning) ? reasoning : 'medium',
  };
}

export function persistComposeChoice(next: ComposeChoice): void {
  safeSetItem(COMPOSE_MODEL_KEY, next.model);
  safeSetItem(COMPOSE_REASONING_KEY, next.reasoningEffort);
}
