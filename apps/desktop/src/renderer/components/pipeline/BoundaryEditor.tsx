import { Button } from '../ui/Button.js';
import { SegmentedControl } from '../ui/SegmentedControl.js';
import styles from './BoundaryEditor.module.css';

type Mode = 'anywhere' | 'nowhere' | 'paths';

export default function BoundaryEditor({
  value,
  onChange,
}: {
  value: string[] | null;
  onChange: (value: string[] | null) => void;
}): React.JSX.Element {
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
    <div className={styles.boundary}>
      <SegmentedControl
        options={[
          {
            label: 'Anywhere in the worktree',
            on: mode === 'anywhere',
            onClick: () => setMode('anywhere'),
          },
          { label: 'Only these paths', on: mode === 'paths', onClick: () => setMode('paths') },
          { label: 'Read-only', on: mode === 'nowhere', onClick: () => setMode('nowhere') },
        ]}
      />
      {mode === 'paths' && (
        <>
          {(value ?? []).map((pattern, i) => (
            <div key={i} className={styles.pattern}>
              <input
                className="input mono"
                value={pattern}
                placeholder="src/**"
                onChange={(e) => update(i, e.target.value)}
              />
              <Button variant="ghost" size="sm" onClick={() => remove(i)}>
                ✕
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={add}>
            Add pattern
          </Button>
        </>
      )}
      <p className={styles.hint}>
        {mode === 'anywhere' && (
          <>
            Anything this agent writes inside its worktree is kept. Files outside the worktree are
            always reverted.
          </>
        )}
        {mode === 'nowhere' && (
          <>
            Every write is reverted after the phase, with the paths recorded as evidence. Use this
            for reviewers and scouts.
          </>
        )}
        {mode === 'paths' && (
          <>
            <code>*</code> matches within a path segment, <code>**</code> matches across segments.
            Writes outside these patterns are reverted after the phase and the phase fails.
          </>
        )}
      </p>
    </div>
  );
}
