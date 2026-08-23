/**
 * Read-only checklist design body for Smith's chat: readiness findings,
 * doctor results, validation reports, and project health.
 *
 * Grouped by pass/warn/fail/info with a top summary line, expandable evidence
 * disclosures, non-color-only status indicators, and fix guidance.
 */

import { useMemo } from 'react';
import type { ChecklistDef, ChecklistItem, ChecklistItemStatus } from '@shared/types.js';
import {
  checklistStatusGlyph,
  checklistStatusLabel,
  checklistSummary,
  groupChecklistItems,
} from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithChecklistDesign.module.css';

export function ChecklistStatusIcon({
  status,
}: {
  status: ChecklistItemStatus;
}): React.JSX.Element {
  if (status === 'pass') {
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
  if (status === 'warn') {
    return (
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
        <path
          d="M8 2.5 L14 13.5 L2 13.5 Z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M8 6.5 L8 9.5 M8 11.5 L8 11.8"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (status === 'fail') {
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
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 6.5 L8 11 M8 4.8 L8 5.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckItemRow({ item }: { item: ChecklistItem }): React.JSX.Element {
  const statusLabel = checklistStatusLabel(item.status);
  const statusGlyph = checklistStatusGlyph(item.status);

  return (
    <li
      className={styles.checkItem}
      data-testid={`checklist-item-${item.status}`}
      aria-label={`${item.label} (${statusLabel})`}
    >
      <div className={styles.itemHeader}>
        <span
          className={cx(styles.statusIndicator, styles[`statusIndicator_${item.status}`])}
          title={`${statusGlyph} ${statusLabel}`}
          aria-hidden="true"
        >
          <ChecklistStatusIcon status={item.status} />
        </span>
        <div className={styles.itemMain}>
          <span className={styles.itemLabel}>{item.label}</span>
          {item.detail && <span className={styles.itemDetail}>{item.detail}</span>}
        </div>
        <span
          className={cx(styles.statusTag, styles[`statusTag_${item.status}`])}
          aria-label={`Status: ${statusLabel}`}
        >
          {statusLabel}
        </span>
      </div>
      {item.evidence && (
        <details className={styles.evidenceDisclosure} data-testid="checklist-evidence">
          <summary className={styles.evidenceSummary}>Evidence</summary>
          <pre className={cx(styles.evidencePre, 'selectable')}>{item.evidence}</pre>
        </details>
      )}
      {item.fix && (
        <div className={styles.fixBox} data-testid="checklist-fix">
          <span className={styles.fixLabel}>Suggested fix</span>
          <span className={styles.fixText}>{item.fix}</span>
        </div>
      )}
    </li>
  );
}

function ChecklistGroupSection({
  status,
  title,
  items,
}: {
  status: ChecklistItemStatus;
  title: string;
  items: ChecklistItem[];
}): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <div
      className={styles.group}
      data-testid={`checklist-group-${status}`}
      aria-label={`${title} checks (${items.length})`}
    >
      <div className={styles.groupHeader}>
        <span className={cx(styles.groupDot, styles[`groupDot_${status}`])} aria-hidden="true" />
        <h4 className={styles.groupTitle}>
          {title} ({items.length})
        </h4>
      </div>
      <ul className={styles.itemsList}>
        {items.map((item, index) => (
          <CheckItemRow key={item.id ?? `${item.label}-${index}`} item={item} />
        ))}
      </ul>
    </div>
  );
}

export function ChecklistDesign({
  checklist,
  compact,
}: {
  checklist: ChecklistDef;
  compact?: boolean;
}): React.JSX.Element {
  const groups = useMemo(() => groupChecklistItems(checklist.items), [checklist.items]);
  const summary = useMemo(() => checklistSummary(checklist), [checklist]);

  return (
    <div className={cx(styles.checklist, compact && styles.compact)} data-testid="checklist-design">
      <div className={styles.summaryBar} data-testid="checklist-summary">
        <span className={styles.summaryText}>{summary}</span>
        <div className={styles.summaryBadges} aria-label="Status counts">
          {groups.fail.length > 0 && (
            <span
              className={cx(styles.summaryBadge, styles.summaryBadgeFail)}
              aria-label={`${groups.fail.length} failed`}
            >
              <ChecklistStatusIcon status="fail" />
              {groups.fail.length} failed
            </span>
          )}
          {groups.warn.length > 0 && (
            <span
              className={cx(styles.summaryBadge, styles.summaryBadgeWarn)}
              aria-label={`${groups.warn.length} ${groups.warn.length === 1 ? 'warning' : 'warnings'}`}
            >
              <ChecklistStatusIcon status="warn" />
              {groups.warn.length} {groups.warn.length === 1 ? 'warning' : 'warnings'}
            </span>
          )}
          {groups.pass.length > 0 && (
            <span
              className={cx(styles.summaryBadge, styles.summaryBadgePass)}
              aria-label={`${groups.pass.length} passed`}
            >
              <ChecklistStatusIcon status="pass" />
              {groups.pass.length} passed
            </span>
          )}
          {groups.info.length > 0 && (
            <span
              className={cx(styles.summaryBadge, styles.summaryBadgeInfo)}
              aria-label={`${groups.info.length} info`}
            >
              <ChecklistStatusIcon status="info" />
              {groups.info.length} info
            </span>
          )}
        </div>
      </div>

      <div className={styles.groups}>
        <ChecklistGroupSection status="fail" title="Failed" items={groups.fail} />
        <ChecklistGroupSection status="warn" title="Warnings" items={groups.warn} />
        <ChecklistGroupSection status="pass" title="Passed" items={groups.pass} />
        <ChecklistGroupSection status="info" title="Info" items={groups.info} />
      </div>
    </div>
  );
}

export default ChecklistDesign;
