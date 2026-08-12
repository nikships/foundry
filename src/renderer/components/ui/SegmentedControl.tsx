import type { ReactNode } from 'react';
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
 * A compact toggle group: the shared `.modes` / `.mode` / `.mode.on` primitive
 * that was duplicated byte-for-byte in PhaseEditor and BoundaryEditor. The
 * active segment is marked with `on`; a `className` lets a caller add site
 * spacing.
 */
export function SegmentedControl({ options, className }: SegmentedControlProps): React.JSX.Element {
  return (
    <div className={className ? `${styles.modes} ${className}` : styles.modes}>
      {options.map((opt, i) => (
        <button
          key={i}
          className={`${styles.mode} ${opt.on ? styles.on : ''}`}
          onClick={opt.onClick}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
