import type { ValidationIssue } from '@shared/types.js';
import styles from './Issues.module.css';

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
      <span className={`${styles.count} ${styles.valid}`}>
        <span className={styles.countItem}>
          <span className={styles.dot} aria-hidden="true" />
          Valid
        </span>
      </span>
    );
  }
  return (
    <span className={styles.count}>
      {errors > 0 && (
        <span className={`${styles.countItem} ${styles.errors}`}>
          <span className={styles.dot} aria-hidden="true" />
          {errors} error{errors === 1 ? '' : 's'}
        </span>
      )}
      {warnings > 0 && (
        <span className={`${styles.countItem} ${styles.warnings}`}>
          <span className={styles.dot} aria-hidden="true" />
          {warnings} warning{warnings === 1 ? '' : 's'}
        </span>
      )}
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
  const isError = issue.level === 'error';
  return (
    <p className={`${styles.line} ${isError ? '' : styles.lineWarn}`}>
      <span className={`${styles.level} ${isError ? '' : styles.levelWarn}`}>
        {isError ? 'Err' : 'Warn'}
      </span>
      <span className={styles.message}>
        {showWhere && issue.where && <span className={styles.where}>{issue.where} — </span>}
        {issue.message}
      </span>
    </p>
  );
}
