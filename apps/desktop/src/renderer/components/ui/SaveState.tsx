import { cx } from './cx.js';
import styles from './SaveState.module.css';

/** Autosave read-out: a dot and the clock time of the last committed save. */
export function SaveState({
  saving,
  savedAt,
}: {
  saving: boolean;
  savedAt: string;
}): React.JSX.Element {
  return (
    <span className={styles.saveState} aria-live="polite">
      <span className={cx(styles.dot, saving && styles.dotSaving)} aria-hidden="true" />
      <span className={styles.clock}>{saving ? 'Saving' : `Saved ${savedAt}`}</span>
    </span>
  );
}
