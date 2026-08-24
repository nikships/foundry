import { cx } from './cx.js';
import styles from './Toggle.module.css';

/** A labelled on/off switch. The whole row is the control. */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  /** For a switch another setting has already decided. The hint says why. */
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx(styles.toggle, disabled && styles.toggleDisabled)}
      onClick={() => onChange(!checked)}
    >
      <span className={cx(styles.track, checked && styles.trackOn)} aria-hidden="true">
        <span className={cx(styles.knob, checked && styles.knobOn)} />
      </span>
      <span className={styles.text}>
        <span className={styles.label}>{label}</span>
        {hint && <span className={styles.hint}>{hint}</span>}
      </span>
    </button>
  );
}
