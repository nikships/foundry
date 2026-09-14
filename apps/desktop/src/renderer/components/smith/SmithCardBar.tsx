import type { ReactNode } from 'react';
import { cx } from '../ui/cx.js';
import styles from './SmithCardBar.module.css';

/**
 * Summary / header strip shared by Smith artifact cards. Compact mode
 * tightens padding for the titlebar bubble.
 */
export function SmithCardBar({
  children,
  compact,
  testId,
}: {
  children: ReactNode;
  compact?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <div className={cx(styles.bar, compact && styles.compact)} data-testid={testId}>
      {children}
    </div>
  );
}

export function SmithCardSummary({
  children,
  compact,
  testId,
}: {
  children: ReactNode;
  compact?: boolean;
  testId?: string;
}): React.JSX.Element {
  return (
    <span className={cx(styles.summary, compact && styles.summaryCompact)} data-testid={testId}>
      {children}
    </span>
  );
}
