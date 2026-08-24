import { useMemo } from 'react';
import type { ReasoningEffort } from '@shared/types.js';
import { isReasoningEffort, modelForEffortPicker } from '@shared/reasoning-effort.js';
import { useAgentModels } from '../../hooks/useAgentModels.js';
import { safeGetItem, safeSetItem } from '../../utils/local-store.js';
import ModelPicker from '../common/ModelPicker.js';
import ReasoningEffortPicker from '../common/ReasoningEffortPicker.js';
import styles from './OrchestratorPicker.module.css';

const MODEL_KEY = 'foundry.orchestrator.model';
const REASONING_KEY = 'foundry.orchestrator.reasoning';

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
  const reasoning = safeGetItem(REASONING_KEY);
  return {
    model: safeGetItem(MODEL_KEY) ?? 'inherit',
    reasoningEffort: isReasoningEffort(reasoning) ? reasoning : 'medium',
  };
}

/**
 * Who plans the run. A small ceremony rather than a settings form: every run
 * answers to one mind, and this is where the operator appoints it.
 */
export default function OrchestratorPicker({
  choice,
  disabled,
  onChange,
}: {
  choice: OrchestratorChoice;
  disabled?: boolean;
  onChange: (next: OrchestratorChoice) => void;
}): React.JSX.Element {
  const { models, refresh } = useAgentModels();
  const effortModel = useMemo(
    () => modelForEffortPicker(choice.model, models),
    [choice.model, models],
  );
  const change = (next: OrchestratorChoice): void => {
    // Persist on an operator change, not on read: first render stays soft.
    safeSetItem(MODEL_KEY, next.model);
    safeSetItem(REASONING_KEY, next.reasoningEffort);
    onChange(next);
  };

  return (
    <div className={styles.picker} data-testid="orchestrator-picker">
      <div className={styles.ceremony}>
        <span className={styles.title}>The Orchestrator</span>
        <span className={styles.motto}>every run answers to one mind</span>
      </div>
      <div className={styles.controls}>
        <div className={styles.model} data-testid="orchestrator-model">
          <ModelPicker
            value={choice.model}
            models={models}
            allowInherit
            inheritLabel="The default model"
            showNotes={false}
            disabled={disabled}
            onChange={(model) => {
              change({ ...choice, model });
            }}
            onRefresh={() => void refresh()}
          />
        </div>
        <div className={styles.effort}>
          <ReasoningEffortPicker
            value={choice.reasoningEffort}
            model={effortModel}
            disabled={disabled}
            ariaLabel="Orchestrator reasoning effort"
            data-testid="orchestrator-effort"
            onChange={(reasoningEffort) => {
              change({ ...choice, reasoningEffort });
            }}
          />
        </div>
      </div>
    </div>
  );
}
