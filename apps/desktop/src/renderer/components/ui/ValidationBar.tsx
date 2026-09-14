import type { ReactNode } from 'react';
import type { ValidationIssue } from '@shared/types.js';
import styles from './ValidationBar.module.css';

/**
 * Autosave + validation footer shared by the Agents and Reports editors.
 * Warnings and errors list in place; a checkmark reads as clear when empty.
 */
export function ValidationBar({
  issues,
  actionError,
  autosave,
}: {
  issues: ValidationIssue[];
  actionError?: ReactNode;
  autosave: string;
}): React.JSX.Element {
  return (
    <div className={styles.bar}>
      {issues.length > 0 ? (
        <ul className={styles.issues}>
          {issues.map((issue, i) => (
            <li key={i} className={issue.level}>
              <strong>{issue.where}</strong> {issue.message}
            </li>
          ))}
        </ul>
      ) : (
        <span className={styles.ok}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
          </svg>
          No validation issues
        </span>
      )}
      {actionError ? <p className={styles.error}>{actionError}</p> : null}
      <span className={styles.autosave}>{autosave}</span>
    </div>
  );
}
