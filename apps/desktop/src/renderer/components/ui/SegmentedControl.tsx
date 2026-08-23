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
}

/**
 * A compact toggle group: the shared `.modes` / `.mode` / `.mode.on` primitive.
 * The active segment is marked with `on`; a `className` lets a caller add site
 * spacing.
 */
export function SegmentedControl({ options, className }: SegmentedControlProps): React.JSX.Element {
  return (
    <div className={cx(styles.modes, className)}>
      {options.map((opt, i) => (
        <button key={i} className={cx(styles.mode, opt.on && styles.on)} onClick={opt.onClick}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}
