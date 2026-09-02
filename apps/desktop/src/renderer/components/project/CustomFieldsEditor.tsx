/**
 * The row editor for `CustomEnvelopeField[]`, shared by the two places that
 * author them: a named envelope in the library, and one agent's extra fields.
 *
 * Both edit the same shape and the same rules, so they get the same control.
 * The caller owns the list and the surrounding copy; this renders rows and
 * reports the next list.
 */

import type { CustomEnvelopeField } from '@shared/types.js';
import {
  FIELD_TYPE_OPTIONS,
  fieldTypeLabel,
  normalizeFieldName,
} from '../../view-models/custom-fields.js';
import { Dropdown } from '../ui/Dropdown.js';
import { TextInput } from '../ui/Field.js';
import styles from './CustomFieldsEditor.module.css';

export default function CustomFieldsEditor({
  fields,
  onChange,
  disabled = false,
  readOnly = false,
  idPrefix,
}: {
  fields: CustomEnvelopeField[];
  onChange: (fields: CustomEnvelopeField[]) => void;
  disabled?: boolean;
  /** Render values without controls — used where the source is not editable. */
  readOnly?: boolean;
  /** Namespaces the generated input ids when two editors share a page. */
  idPrefix: string;
}): React.JSX.Element {
  const patch = (index: number, next: Partial<CustomEnvelopeField>): void => {
    onChange(fields.map((f, i) => (i === index ? { ...f, ...next } : f)));
  };

  if (readOnly) {
    return (
      <div className={styles.fieldStack}>
        {fields.map((field, index) => (
          <div key={`${field.name}-${index}`} className={`${styles.fieldRow} ${styles.locked}`}>
            <div className={styles.fieldMain}>
              <span className={`mono ${styles.fieldName}`}>{field.name}</span>
              <span className={styles.fieldMeta}>{fieldTypeLabel(field.type)}</span>
              <span className={styles.fieldMeta}>{field.required ? 'Required' : 'Optional'}</span>
              {field.description && <span className={styles.fieldHint}>{field.description}</span>}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.fieldStack}>
      {fields.map((field, index) => (
        <div key={index} className={styles.fieldRow}>
          <div className={styles.fieldGrid}>
            <label className={styles.fieldLabel} htmlFor={`${idPrefix}-name-${index}`}>
              <span>Name</span>
              <TextInput
                id={`${idPrefix}-name-${index}`}
                mono
                value={field.name}
                disabled={disabled}
                onChange={(e) => patch(index, { name: normalizeFieldName(e.target.value) })}
              />
            </label>
            <label className={styles.fieldLabel} htmlFor={`${idPrefix}-type-${index}`}>
              <span>Type</span>
              <Dropdown
                value={field.type}
                disabled={disabled}
                options={FIELD_TYPE_OPTIONS}
                onChange={(next) => patch(index, { type: next as CustomEnvelopeField['type'] })}
              />
            </label>
            <label className={`${styles.fieldLabel} ${styles.fieldReq}`}>
              <span>Required</span>
              <button
                type="button"
                role="switch"
                aria-checked={field.required}
                aria-label={`Required: ${field.name || `field ${index + 1}`}`}
                className={`${styles.switch} ${field.required ? styles.on : ''}`}
                disabled={disabled}
                onClick={() => patch(index, { required: !field.required })}
              >
                <span className={styles.switchKnob} />
                <span className={styles.switchText}>{field.required ? 'Yes' : 'No'}</span>
              </button>
            </label>
            <label className={`${styles.fieldLabel} ${styles.fieldHintCol}`}>
              <span>Hint in example JSON</span>
              <TextInput
                value={field.description ?? ''}
                disabled={disabled}
                placeholder={`e.g. ${fieldTypeLabel(field.type).toLowerCase()} the agent should fill`}
                onChange={(e) => patch(index, { description: e.target.value })}
              />
            </label>
          </div>
          <button
            type="button"
            className={styles.fieldRemove}
            disabled={disabled}
            onClick={() => onChange(fields.filter((_, i) => i !== index))}
            aria-label={`Remove field ${field.name || index + 1}`}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
