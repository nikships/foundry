import type { ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './SegmentedControl.module.css';

interface SegmentOption {
  label: ReactNode;
  on: boolean;
  onClick: () => void;
  /** Accessible label when option content/label is an icon or abbreviated. */
  ariaLabel?: string;
  /** Disabled state for the segment button. */
  disabled?: boolean;
}

interface SegmentedControlProps {
  options: SegmentOption[];
  /** Optional accessible label for the segmented control group. */
  ariaLabel?: string;
  /** Appended to the container (e.g. a margin-bottom hook). */
  className?: string;
}

/**
 * A compact toggle group: the shared `.modes` / `.mode` / `.mode.on` primitive.
 * The active segment is marked with `on`; a `className` lets a caller add site
 * spacing.
 */
export function SegmentedControl({
  options,
  ariaLabel,
  className,
}: SegmentedControlProps): React.JSX.Element {
  return (
    <div className={cx(styles.modes, className)} role="group" aria-label={ariaLabel}>
      {options.map((opt, i) => (
        <button
          key={i}
          type="button"
          aria-pressed={opt.on}
          aria-label={opt.ariaLabel}
          disabled={opt.disabled}
          className={cx(styles.mode, opt.on && styles.on)}
          onClick={opt.onClick}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
