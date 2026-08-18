import { useMemo } from 'react';
import type { ModelInfo } from '@shared/types.js';
import { modelLabel } from '../format.js';
import { ProviderIcon } from './BrandIcon.js';
import { Dropdown, type DropdownOption } from './ui/Dropdown.js';
import styles from './ModelPicker.module.css';

export default function ModelPicker({
  value,
  models,
  allowInherit,
  inheritLabel = 'Inherit from Agent defaults',
  disabled,
  emptyHint,
  onChange,
  onRefresh,
}: {
  value: string;
  models: ModelInfo[];
  allowInherit?: boolean;
  /**
   * Closed-face copy for the `inherit` sentinel. Settings itself must name
   * the real fallback — inheriting "from Settings" is circular there.
   */
  inheritLabel?: string;
  disabled?: boolean;
  /** Shown when the catalog is empty (CLI missing or unauthenticated). */
  emptyHint?: string;
  onChange: (value: string) => void;
  onRefresh?: () => void;
}): React.JSX.Element {
  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const model of models) {
      const list = map.get(model.provider) ?? [];
      list.push(model);
      map.set(model.provider, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models]);

  const current = useMemo(
    () => models.find((m) => m.id === value || m.id.endsWith(`:${value}`)) ?? null,
    [models, value],
  );
  const catalogEmpty = models.length === 0;
  const unknownSelected = value !== 'inherit' && !current && !!value;

  const options = useMemo<DropdownOption[]>(() => {
    const next: DropdownOption[] = [];
    if (allowInherit) {
      next.push({ value: 'inherit', label: inheritLabel });
    }
    for (const [provider, list] of groups) {
      for (const model of list) {
        next.push({
          value: model.id,
          label: model.displayName || modelLabel(model.id),
          description: model.contextWindow
            ? `${Math.round(model.contextWindow / 1000)}k context`
            : undefined,
          group: provider,
          icon: <ProviderIcon provider={model.provider} size={16} />,
        });
      }
    }
    if (unknownSelected) {
      next.push({
        value,
        label: `${modelLabel(value)} (not in the current catalog)`,
      });
    }
    if (catalogEmpty && !allowInherit && !unknownSelected) {
      next.push({
        value: value || '',
        label: value ? modelLabel(value) : 'No models available',
        disabled: true,
      });
    }
    return next;
  }, [allowInherit, catalogEmpty, groups, inheritLabel, unknownSelected, value]);

  return (
    <>
      <div className={styles.picker}>
        <Dropdown
          className={styles.dropdown}
          value={value}
          options={options}
          onChange={onChange}
          disabled={disabled}
          aria-invalid={catalogEmpty && !allowInherit ? true : undefined}
          aria-label="Model"
        />
        {current && <ProviderIcon provider={current.provider} size={18} />}
      </div>
      {catalogEmpty && (
        <p className={styles.pickerEmpty}>
          {emptyHint ??
            'No models in the catalog. Install and sign in to this CLI, then refresh the list.'}
          {onRefresh && (
            <>
              {' '}
              <button type="button" className={styles.linkButton} onClick={onRefresh}>
                Refresh
              </button>
            </>
          )}
        </p>
      )}
      {unknownSelected && !catalogEmpty && (
        <p className={styles.pickerEmpty}>
          This model id is not in the current CLI catalog. Pick another or switch CLI.
        </p>
      )}
    </>
  );
}
