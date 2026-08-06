type Mode = 'anywhere' | 'nowhere' | 'paths';

export default function BoundaryEditor({ value, onChange }: { value: string[] | null; onChange: (value: string[] | null) => void }): React.JSX.Element {
  const mode: Mode = value === null ? 'anywhere' : value.length ? 'paths' : 'nowhere';

  const setMode = (next: Mode): void => {
    if (next === 'anywhere') onChange(null);
    else if (next === 'nowhere') onChange([]);
    else onChange(value?.length ? value : ['src/**']);
  };

  const update = (index: number, newVal: string): void => {
    const next = [...(value ?? [])];
    next[index] = newVal;
    onChange(next);
  };

  const add = (): void => onChange([...(value ?? []), '']);
  const remove = (index: number): void => {
    const next = [...(value ?? [])];
    next.splice(index, 1);
    onChange(next);
  };

  return (
    <>
      <div className="boundary">
        <div className="modes">
          <button className={`mode ${mode === 'anywhere' ? 'on' : ''}`} onClick={() => setMode('anywhere')}>Anywhere in the worktree</button>
          <button className={`mode ${mode === 'paths' ? 'on' : ''}`} onClick={() => setMode('paths')}>Only these paths</button>
          <button className={`mode ${mode === 'nowhere' ? 'on' : ''}`} onClick={() => setMode('nowhere')}>Read-only</button>
        </div>
        {mode === 'paths' && (
          <>
            {(value ?? []).map((pattern, i) => (
              <div key={i} className="pattern">
                <input className="input mono" value={pattern} placeholder="src/**" onChange={(e) => update(i, e.target.value)} />
                <button className="btn sm ghost" onClick={() => remove(i)}>✕</button>
              </div>
            ))}
            <button className="btn sm" onClick={add}>Add pattern</button>
          </>
        )}
        <p className="hint">
          {mode === 'anywhere' && <>Anything this agent writes inside its worktree is kept. Files outside the worktree are always reverted.</>}
          {mode === 'nowhere' && <>Every write is reverted after the phase, with the paths recorded as evidence. Use this for reviewers and scouts.</>}
          {mode === 'paths' && <><code>*</code> matches within a path segment, <code>**</code> matches across segments. Writes outside these patterns are reverted after the phase and the phase fails.</>}
        </p>
      </div>
      <style>{`
        .boundary { display: flex; flex-direction: column; gap: var(--s2); }
        .modes { display: flex; gap: var(--s1); padding: 3px; border-radius: var(--r-sm); background: var(--bg-input); border: 1px solid var(--line); width: fit-content; }
        .mode { padding: var(--s1) var(--s3); border: none; border-radius: 5px; background: transparent; color: var(--text-faint); font: inherit; font-size: var(--text-xs); cursor: default; }
        .mode:hover { color: var(--text); }
        .mode.on { background: var(--bg-active); color: var(--text); }
        .pattern { display: flex; gap: var(--s2); }
        .hint { font-size: var(--text-xs); color: var(--text-faint); line-height: var(--leading); }
        .hint code { font-family: var(--font-mono); padding: 1px 4px; border-radius: 4px; background: var(--bg-raised); color: var(--cyan); }
      `}</style>
    </>
  );
}
