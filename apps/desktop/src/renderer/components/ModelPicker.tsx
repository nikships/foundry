import { useEffect, useMemo, useState } from 'react';
import type { ModelInfo } from '@shared/types.js';
import { api } from '../api.js';
import { modelLabel } from '../format.js';

export default function ModelPicker({ value, models, allowInherit, onChange }: { value: string; models: ModelInfo[]; allowInherit?: boolean; onChange: (value: string) => void }): React.JSX.Element {
  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const model of models) {
      const list = map.get(model.provider) ?? [];
      list.push(model);
      map.set(model.provider, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models]);

  const [icons, setIcons] = useState<Record<string, string>>({});
  useEffect(() => {
    void Promise.all(groups.map(async ([provider]) => [provider, await api.app.assetUrl(`providers/${provider}.png`)] as const)).then((entries) => setIcons(Object.fromEntries(entries)));
  }, [groups]);

  const current = useMemo(() => models.find((m) => m.id === value) ?? null, [models, value]);

  return (
    <>
      <div className="picker">
        <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
          {allowInherit && <option value="inherit">Inherit from Settings</option>}
          {groups.map(([provider, list]) => (
            <optgroup key={provider} label={provider}>
              {list.map((model) => (
                <option key={model.id} value={model.id}>{model.displayName || modelLabel(model.id)}</option>
              ))}
            </optgroup>
          ))}
          {value !== 'inherit' && !current && <option value={value}>{modelLabel(value)} (not in the current catalog)</option>}
        </select>
        {current && icons[current.provider] && <img src={icons[current.provider]} alt={current.provider} />}
      </div>
      <style>{`
        .picker { position: relative; display: flex; align-items: center; gap: var(--s2); }
        .picker .select { flex: 1; }
        .picker img { width: 18px; height: 18px; object-fit: contain; flex: none; opacity: 0.9; }
      `}</style>
    </>
  );
}
