import { useMemo } from 'react';
import { modelForEffortPicker } from '@shared/reasoning-effort.js';
import { useAgentModels } from '../../hooks/useAgentModels.js';
import {
  loadOrchestratorChoice,
  persistOrchestratorChoice,
  type OrchestratorChoice,
} from '../../utils/orchestrator-choice.js';
import ModelPicker from '../common/ModelPicker.js';
import ReasoningEffortPicker from '../common/ReasoningEffortPicker.js';
import styles from './OrchestratorPicker.module.css';

export type { OrchestratorChoice };
export { loadOrchestratorChoice };

interface OrchestratorControlsProps {
  choice: OrchestratorChoice;
  disabled?: boolean;
  onChange: (next: OrchestratorChoice) => void;
}

/**
 * Who plans the run. A small ceremony rather than a settings form: every run
 * answers to one mind, and this is where the operator appoints it.
 */
export default function OrchestratorPicker({
  choice,
  disabled,
  onChange,
}: OrchestratorControlsProps): React.JSX.Element {
  return (
    <div className={styles.picker} data-testid="orchestrator-picker">
      <div className={styles.ceremony}>
        <span className={styles.title}>The Orchestrator</span>
        <span className={styles.motto}>every run answers to one mind</span>
      </div>
      <OrchestratorControls choice={choice} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** Model and effort controls without the hero ceremony, for compact request sources. */
export function OrchestratorControls({
  choice,
  disabled,
  onChange,
}: OrchestratorControlsProps): React.JSX.Element {
  const { models, refresh } = useAgentModels();
  const effortModel = useMemo(
    () => modelForEffortPicker(choice.model, models),
    [choice.model, models],
  );
  const change = (next: OrchestratorChoice): void => {
    // Persist on an operator change, not on read: first render stays soft.
    persistOrchestratorChoice(next);
    onChange(next);
  };

  return (
    <div className={styles.controls} data-testid="orchestrator-controls">
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
  );
}
