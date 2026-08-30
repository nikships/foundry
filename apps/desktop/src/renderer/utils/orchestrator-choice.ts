/**
 * Soft persistence for which mind plans a run.
 *
 * Lives outside OrchestratorPicker so the app shell can restore the choice
 * without importing the picker (and the model catalog UI) on first paint.
 */
import type { ReasoningEffort } from '@shared/types.js';
import { isReasoningEffort } from '@shared/reasoning-effort.js';
import { safeGetItem, safeSetItem } from './local-store.js';

export const ORCHESTRATOR_MODEL_KEY = 'foundry.orchestrator.model';
export const ORCHESTRATOR_REASONING_KEY = 'foundry.orchestrator.reasoning';

export interface OrchestratorChoice {
  model: string;
  reasoningEffort: ReasoningEffort;
}

/**
 * The softly persisted appointment: localStorage, not `AppSettings`, because
 * which mind runs the planning is a preference of this machine's operator,
 * not of the install.
 */
export function loadOrchestratorChoice(): OrchestratorChoice {
  const reasoning = safeGetItem(ORCHESTRATOR_REASONING_KEY);
  return {
    model: safeGetItem(ORCHESTRATOR_MODEL_KEY) ?? 'inherit',
    reasoningEffort: isReasoningEffort(reasoning) ? reasoning : 'medium',
  };
}

export function persistOrchestratorChoice(next: OrchestratorChoice): void {
  safeSetItem(ORCHESTRATOR_MODEL_KEY, next.model);
  safeSetItem(ORCHESTRATOR_REASONING_KEY, next.reasoningEffort);
}
