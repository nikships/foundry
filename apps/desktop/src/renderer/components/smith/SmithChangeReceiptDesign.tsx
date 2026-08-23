/**
 * Read-only change / command receipt design body for Smith's chat.
 *
 * Records the outcome of direct checkout edits or command runs with
 * target (direct checkout vs isolated worktree), files changed, diffstat,
 * command status/exit code, and bounded output excerpt.
 */

import { useMemo } from 'react';
import type { ChangeReceiptDef } from '@shared/types.js';
import {
  changeReceiptStatusLabel,
  changeReceiptSummary,
  changeReceiptTargetLabel,
} from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithChangeReceiptDesign.module.css';

export function ReceiptStatusIcon({
  status,
}: {
  status: ChangeReceiptDef['status'];
}): React.JSX.Element {
  if (status === 'success') {
    return (
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
        <polyline
          points="3.2 8.2 6.4 11.4 12.8 4.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
      <path
        d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ReceiptTargetIcon({
  target,
}: {
  target: ChangeReceiptDef['target'];
}): React.JSX.Element {
  if (target === 'isolated_worktree') {
    return (
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
        <rect
          x="3"
          y="6.5"
          width="10"
          height="7"
          rx="1.5"
          stroke="currentColor"
          strokeWidth="1.4"
        />
        <path
          d="M5.5 6.5 V4.5 C5.5 3.1 6.6 2 8 2 C9.4 2 10.5 3.1 10.5 4.5 V6.5"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
      <circle cx="5" cy="5" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5" cy="11" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="5" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 7 V9 M7 5 H9" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function ChangeReceiptDesign({
  receipt,
  compact,
}: {
  receipt: ChangeReceiptDef;
  compact?: boolean;
}): React.JSX.Element {
  const summary = useMemo(() => changeReceiptSummary(receipt), [receipt]);
  const targetLabel = changeReceiptTargetLabel(receipt.target);
  const statusLabel = changeReceiptStatusLabel(receipt.status);

  return (
    <div
      className={cx(styles.receipt, compact && styles.compact)}
      data-testid="change-receipt-design"
    >
      <div className={styles.headerBar}>
        <span className={styles.summaryText} data-testid="change-receipt-summary">
          {summary}
        </span>
        <div className={styles.badges}>
          <span
            className={cx(styles.targetBadge, styles[`targetBadge_${receipt.target}`])}
            aria-label={`Target: ${targetLabel}`}
            data-testid="change-receipt-target"
          >
            <ReceiptTargetIcon target={receipt.target} />
            {targetLabel}
          </span>
          <span
            className={cx(styles.statusBadge, styles[`statusBadge_${receipt.status}`])}
            aria-label={`Status: ${statusLabel}`}
            data-testid="change-receipt-status"
          >
            <ReceiptStatusIcon status={receipt.status} />
            {statusLabel}
          </span>
        </div>
      </div>

      {receipt.command && (
        <div className={styles.commandBox} data-testid="change-receipt-command">
          <div className={styles.commandHeader}>
            <code className={styles.commandCode}>{receipt.command.command}</code>
            <div className={styles.commandMeta}>
              {receipt.command.durationMs !== undefined && (
                <span>{receipt.command.durationMs}ms</span>
              )}
              {receipt.command.timedOut && <span>(timed out)</span>}
              <span
                className={cx(
                  styles.exitBadge,
                  receipt.command.passed ? styles.exitBadge_ok : styles.exitBadge_bad,
                )}
              >
                {receipt.command.exitCode !== null ? `exit ${receipt.command.exitCode}` : 'running'}
              </span>
            </div>
          </div>
        </div>
      )}

      {receipt.filesChanged && receipt.filesChanged.length > 0 && (
        <div className={styles.section} data-testid="change-receipt-files">
          <span className={styles.sectionTitle}>Files changed ({receipt.filesChanged.length})</span>
          <ul className={styles.filesList}>
            {receipt.filesChanged.map((file) => (
              <li key={file} className={styles.fileItem}>
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}

      {receipt.diffstat && (
        <div className={styles.section} data-testid="change-receipt-diffstat">
          <span className={styles.sectionTitle}>Diffstat</span>
          <pre className={cx(styles.diffstatPre, 'selectable')}>{receipt.diffstat}</pre>
        </div>
      )}

      {receipt.outputExcerpt && (
        <details className={styles.outputDisclosure} data-testid="change-receipt-output">
          <summary className={styles.outputSummary}>Output excerpt</summary>
          <pre className={cx(styles.outputPre, 'selectable')}>{receipt.outputExcerpt}</pre>
        </details>
      )}
    </div>
  );
}

export default ChangeReceiptDesign;
