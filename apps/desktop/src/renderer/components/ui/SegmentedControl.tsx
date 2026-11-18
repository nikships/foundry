import type { ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './SegmentedControl.module.css';

interface SegmentOption {
  label: ReactNode;
  on: boolean;
  onClick: () => void;
}

interface SegmentedControlProps {
  options: SegmentOption[];
  /** Appended to the container (e.g. a margin-bottom hook). */
  className?: string;
  /** Accessible label for the tablist container. */
  'aria-label'?: string;
}

/**
 * A compact toggle group: the shared `.modes` / `.mode` / `.mode.on` primitive.
 * The active segment is marked with `on`; a `className` lets a caller add site
 * spacing.
 */
export function SegmentedControl({
  options,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps): React.JSX.Element {
  return (
    <div className={cx(styles.modes, className)} role="tablist" aria-label={ariaLabel}>
      {options.map((opt, i) => (
        <button
          key={i}
          type="button"
          role="tab"
          aria-selected={opt.on}
          className={cx(styles.mode, opt.on && styles.on)}
          onClick={opt.onClick}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
