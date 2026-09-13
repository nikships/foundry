import { useMemo } from 'react';
import { modelForEffortPicker } from '@shared/reasoning-effort.js';
import { useAgentModels } from '../../hooks/useAgentModels.js';
import {
  loadComposeChoice,
  persistComposeChoice,
  type ComposeChoice,
} from '../../utils/compose-choice.js';
import ModelPicker from '../common/ModelPicker.js';
import ReasoningEffortPicker from '../common/ReasoningEffortPicker.js';
import styles from './ComposePicker.module.css';

export type { ComposeChoice };
export { loadComposeChoice };

interface ComposeControlsProps {
  choice: ComposeChoice;
  disabled?: boolean;
  onChange: (next: ComposeChoice) => void;
}

/**
 * Who plans the run. A small ceremony rather than a settings form: every run
 * answers to one mind, and this is where the operator appoints it.
 */
export default function ComposePicker({
  choice,
  disabled,
  onChange,
}: ComposeControlsProps): React.JSX.Element {
  return (
    <div className={styles.picker} data-testid="compose-picker">
      <div className={styles.ceremony}>
        <span className={styles.title}>Smith composes on</span>
        <span className={styles.motto}>every run answers to one mind</span>
      </div>
      <ComposeControls choice={choice} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** Model and effort controls without the hero ceremony, for compact request sources. */
export function ComposeControls({
  choice,
  disabled,
  onChange,
}: ComposeControlsProps): React.JSX.Element {
  const { models, refresh } = useAgentModels();
  const effortModel = useMemo(
    () => modelForEffortPicker(choice.model, models),
    [choice.model, models],
  );
  const change = (next: ComposeChoice): void => {
    // Persist on an operator change, not on read: first render stays soft.
    persistComposeChoice(next);
    onChange(next);
  };

  return (
    <div className={styles.controls} data-testid="compose-controls">
      <div className={styles.model} data-testid="compose-model">
        <ModelPicker
          value={choice.model}
          models={models}
          allowInherit
          inheritLabel="Smith's model"
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
          ariaLabel="Smith composition reasoning effort"
          data-testid="compose-effort"
          onChange={(reasoningEffort) => {
            change({ ...choice, reasoningEffort });
          }}
        />
      </div>
    </div>
  );
}
