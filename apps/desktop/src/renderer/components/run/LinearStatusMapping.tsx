import type { LinearStatusMapping, LinearWorkflowState } from '@shared/types.js';
import { Dropdown } from '../ui/Dropdown.js';
import { Field } from '../ui/Field.js';
import styles from './LinearComposer.module.css';

const STAGES: ReadonlyArray<[keyof LinearStatusMapping, string]> = [
  ['started', 'Run started'],
  ['completed', 'Run accepted'],
  ['failed', 'Failed / rejected / killed'],
];

export default function LinearStatusMapping({
  teamName,
  states,
  mapping,
  loading,
  error,
  showErrors,
  onChange,
}: {
  teamName: string;
  states: LinearWorkflowState[];
  mapping: LinearStatusMapping;
  loading: boolean;
  error: string;
  showErrors: boolean;
  onChange: (mapping: LinearStatusMapping) => void;
}): React.JSX.Element {
  return (
    <div className={styles.mapping} data-testid="linear-status-mapping">
      <div className={styles.mappingHead}>
        <span>{teamName} workflow mapping</span>
        <span>Applied when this run changes state</span>
      </div>
      {error ? (
        <div className={styles.mappingError} role="alert">
          {error}
        </div>
      ) : (
        <div className={styles.mappingFields}>
          {STAGES.map(([stage, label]) => {
            const invalid = showErrors && !mapping[stage];
            return (
              <Field key={stage} label={label}>
                <Dropdown
                  value={mapping[stage] ?? ''}
                  options={states.map((state) => ({
                    value: state.id,
                    label: state.name,
                    description: state.type,
                  }))}
                  disabled={loading}
                  aria-label={label}
                  aria-invalid={invalid}
                  onChange={(stateId) => onChange({ ...mapping, [stage]: stateId || null })}
                />
              </Field>
            );
          })}
        </div>
      )}
    </div>
  );
}
