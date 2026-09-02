/**
 * Read-only PR preview/card design body for Smith's chat.
 *
 * Communicates PR number, title, branches, checks status, mergeability,
 * diffstats, action outcomes, and external link.
 */

import type { PrCardDef } from '@shared/types.js';
import {
  prChecksGlyph,
  prChecksLabel,
  prMergeableLabel,
} from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithPrCardDesign.module.css';

export function PrExternalLinkIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
      <path
        d="M6 3.5 H3.5 C2.7 3.5 2 4.2 2 5 V12.5 C2 13.3 2.7 14 3.5 14 H11 C11.8 14 12.5 13.3 12.5 12.5 V10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M9.5 2 H14 V6.5 M6.5 9.5 L13.5 2.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PrChecksIcon({ checks }: { checks: PrCardDef['checks'] }): React.JSX.Element {
  if (checks === 'passing') {
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
  if (checks === 'failing') {
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
  if (checks === 'pending') {
    return (
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.4" strokeDasharray="3 2" />
      </svg>
    );
  }
  return <span aria-hidden="true">{prChecksGlyph(checks)}</span>;
}

export function PrMergeableIcon({
  mergeable,
}: {
  mergeable: PrCardDef['mergeable'];
}): React.JSX.Element {
  if (mergeable === 'mergeable') {
    return (
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
        <circle cx="5" cy="5" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="5" cy="11" r="2" stroke="currentColor" strokeWidth="1.4" />
        <circle cx="11" cy="5" r="2" stroke="currentColor" strokeWidth="1.4" />
        <path d="M5 7 V9 M7 5 H9" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (mergeable === 'conflicting') {
    return (
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
        <path
          d="M8 2.5 L14.5 13.5 H1.5 Z M8 6.5 V9.5 M8 11.5 V12"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function PrCardDesign({
  pr,
  compact,
}: {
  pr: PrCardDef;
  compact?: boolean;
}): React.JSX.Element {
  const checksLabel = prChecksLabel(pr.checks);
  const mergeableLabel = prMergeableLabel(pr.mergeable);
  const checksKind = pr.checks ?? 'none';
  const mergeKind = pr.mergeable ?? 'unknown';

  return (
    <div className={cx(styles.prCard, compact && styles.compact)} data-testid="pr-card-design">
      <div className={styles.headerBar} data-testid="pr-card-header">
        <div className={styles.titleGroup}>
          <span className={styles.prNumber} data-testid="pr-card-number">
            #{pr.number}
          </span>
          <span className={styles.prTitle} data-testid="pr-card-title">
            {pr.title}
          </span>
        </div>
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className={styles.linkBtn}
          aria-label={`Open PR #${pr.number} on GitHub`}
          data-testid="pr-card-url"
        >
          <span>GitHub</span>
          <PrExternalLinkIcon />
        </a>
      </div>

      <div className={styles.metaRow}>
        <span
          className={styles.branchBadge}
          aria-label={`Branch: ${pr.headRefName} to ${pr.baseRefName ?? 'base'}`}
          data-testid="pr-card-branch"
        >
          {pr.headRefName} → {pr.baseRefName ?? 'base'}
        </span>

        <span
          className={cx(styles.checksBadge, styles[`checksBadge_${checksKind}`])}
          aria-label={`Checks: ${checksLabel}`}
          data-testid="pr-card-checks"
        >
          <PrChecksIcon checks={pr.checks} />
          {checksLabel}
        </span>

        {pr.mergeable && (
          <span
            className={cx(styles.mergeBadge, styles[`mergeBadge_${mergeKind}`])}
            aria-label={`Mergeable: ${mergeableLabel}`}
            data-testid="pr-card-mergeable"
          >
            <PrMergeableIcon mergeable={pr.mergeable} />
            {mergeableLabel}
          </span>
        )}

        {pr.isDraft && (
          <span className={styles.draftBadge} data-testid="pr-card-draft">
            Draft
          </span>
        )}

        {(pr.additions !== undefined || pr.deletions !== undefined) && (
          <div className={styles.diffGroup} data-testid="pr-card-diff">
            {pr.additions !== undefined && <span className={styles.diffAdd}>+{pr.additions}</span>}
            {pr.deletions !== undefined && <span className={styles.diffDel}>-{pr.deletions}</span>}
          </div>
        )}
      </div>

      {pr.action && (
        <div
          className={cx(
            styles.actionBanner,
            pr.action.status === 'success'
              ? styles.actionBanner_success
              : styles.actionBanner_failure,
          )}
          data-testid="pr-card-action"
        >
          <span className={styles.actionLabel}>
            {pr.action.operation.replaceAll('_', ' ')}: {pr.action.status}
          </span>
          {pr.action.detail && <span>{pr.action.detail}</span>}
        </div>
      )}

      {pr.body && !compact && (
        <details className={styles.disclosure} data-testid="pr-card-body">
          <summary className={styles.disclosureSummary}>PR description</summary>
          <pre className={cx(styles.disclosurePre, 'selectable')}>{pr.body}</pre>
        </details>
      )}
    </div>
  );
}
