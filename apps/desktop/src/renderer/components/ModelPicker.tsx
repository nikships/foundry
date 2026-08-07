import { useMemo } from 'react';
import type { ModelInfo } from '@shared/types.js';
import { modelLabel } from '../format.js';
import { ProviderIcon } from './BrandIcon.js';

export default function ModelPicker({
  value,
  models,
  allowInherit,
  emptyHint,
  onChange,
  onRefresh,
}: {
  value: string;
  models: ModelInfo[];
  allowInherit?: boolean;
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

  const current = useMemo(() => models.find((m) => m.id === value) ?? null, [models, value]);
  const catalogEmpty = models.length === 0;
  const unknownSelected = value !== 'inherit' && !current && !!value;

  return (
    <>
      <div className="picker">
        <select
          className="select"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={catalogEmpty && !allowInherit ? true : undefined}
        >
          {allowInherit && <option value="inherit">Inherit from Settings</option>}
          {groups.map(([provider, list]) => (
            <optgroup key={provider} label={provider}>
              {list.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName || modelLabel(model.id)}
                </option>
              ))}
            </optgroup>
          ))}
          {unknownSelected && (
            <option value={value}>{modelLabel(value)} (not in the current catalog)</option>
          )}
          {catalogEmpty && !allowInherit && !unknownSelected && (
            <option value={value || ''} disabled>
              {value ? modelLabel(value) : 'No models available'}
            </option>
          )}
        </select>
        {current && <ProviderIcon provider={current.provider} size={18} />}
      </div>
      {catalogEmpty && (
        <p className="picker-empty">
          {emptyHint ??
            'No models in the catalog. Install and sign in to this CLI, then refresh the list.'}
          {onRefresh && (
            <>
              {' '}
              <button type="button" className="linkish" onClick={onRefresh}>
                Refresh
              </button>
            </>
          )}
        </p>
      )}
      {unknownSelected && !catalogEmpty && (
        <p className="picker-empty">
          This model id is not in the current CLI catalog. Pick another or switch CLI.
        </p>
      )}
      <style>{`
        .picker { display: flex; align-items: center; gap: var(--s2); }
        .picker .select { flex: 1; }
        .picker-empty { margin-top: var(--s1); font-size: var(--text-xs); color: var(--amber); line-height: var(--leading); }
        .linkish {
          border: none; background: none; padding: 0; font: inherit; font-size: inherit;
          color: var(--cyan); text-decoration: underline; cursor: default;
        }
      `}</style>
    </>
  );
}
