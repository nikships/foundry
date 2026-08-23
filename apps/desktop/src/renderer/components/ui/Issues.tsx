import type { ValidationIssue } from '@shared/types.js';
import { cx } from './cx.js';
import styles from './Issues.module.css';

function Tally({ tone, children }: { tone?: string; children: string }): React.JSX.Element {
  return (
    <span className={cx(styles.countItem, tone)}>
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </span>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * Live validation tally. Warnings never read as failure: a pipeline with
 * warnings still saves and still runs.
 */
export function IssueCount({
  errors,
  warnings,
}: {
  errors: number;
  warnings: number;
}): React.JSX.Element {
  if (!errors && !warnings) {
    return (
      <span className={cx(styles.count, styles.valid)}>
        <Tally>Valid</Tally>
      </span>
    );
  }
  return (
    <span className={styles.count}>
      {errors > 0 && <Tally tone={styles.errors}>{plural(errors, 'error')}</Tally>}
      {warnings > 0 && <Tally tone={styles.warnings}>{plural(warnings, 'warning')}</Tally>}
    </span>
  );
}

/** One validation issue, colored by level. */
export function IssueLine({
  issue,
  showWhere = false,
}: {
  issue: ValidationIssue;
  showWhere?: boolean;
}): React.JSX.Element {
  const warn = issue.level !== 'error';
  return (
    <p className={cx(styles.line, warn && styles.lineWarn)}>
      <span className={cx(styles.level, warn && styles.levelWarn)}>{warn ? 'Warn' : 'Err'}</span>
      <span className={styles.message}>
        {showWhere && issue.where && <span className={styles.where}>{issue.where} — </span>}
        {issue.message}
      </span>
    </p>
  );
}
