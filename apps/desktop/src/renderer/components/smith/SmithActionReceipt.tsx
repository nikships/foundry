/**
 * A settled action's receipt body: what ran, against what, with what
 * consequences, and whether it worked.
 *
 * Read-only by construction. The receipt is a snapshot main recorded when the
 * action settled, so this body offers no retry and no re-run — only a link to
 * where the affected object now lives, and only when this build knows how to
 * follow it. Approval is not success: a failed receipt says so first, in its
 * own color, before any argument is read.
 */

import type { SmithActionReceipt, SmithReceiptLink } from '@shared/types.js';
import {
  isActionableLink,
  receiptOutcomeView,
  receiptRows,
} from '../../view-models/smith-artifact-view.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import styles from './SmithActionReceipt.module.css';

export default function SmithActionReceiptBody({
  receipt,
  compact,
  onOpenLink,
}: {
  receipt: SmithActionReceipt;
  /** Tighter layout for the titlebar bubble; same rows, no overflow. */
  compact?: boolean;
  /** Follows the receipt's link. Absent means the card shows it as plain text. */
  onOpenLink?: (link: SmithReceiptLink) => void;
}): React.JSX.Element {
  const outcome = receiptOutcomeView(receipt);
  const link = receipt.link;
  const follow = onOpenLink && isActionableLink(link) ? onOpenLink : null;

  return (
    <div className={cx(styles.receipt, compact && styles.compact)}>
      <div className={styles.outcome} style={{ color: outcome.color }}>
        <span className={styles.outcomeDot} aria-hidden />
        <span className={styles.outcomeLabel} data-testid="smith-receipt-outcome">
          {outcome.label}
        </span>
        <span className={styles.outcomeTarget}>{receipt.target}</span>
      </div>

      <dl className={styles.rows}>
        {receiptRows(receipt).map((row) => (
          <div key={row.label} className={styles.row}>
            <dt className={styles.rowLabel}>{row.label}</dt>
            <dd className={cx(styles.rowValue, row.label === 'Failure' && styles.failureValue)}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      {link && (
        <div className={styles.linkRow}>
          {follow ? (
            <Button size="sm" onClick={() => follow(link)} data-testid="smith-receipt-link">
              {link.label}
            </Button>
          ) : (
            <span className={styles.linkText} data-testid="smith-receipt-link-inert">
              {link.label}: {linkText(link)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The link's own coordinates, shown when this build cannot follow it. A
 * persisted receipt can name a link kind a newer Foundry introduced, so the
 * fallback is the kind itself rather than an undefined field.
 */
function linkText(link: SmithReceiptLink): string {
  switch (link.kind) {
    case 'url':
      return link.url;
    case 'run':
      return link.runId;
    case 'entity':
      return link.name;
    default:
      return (link as { kind: string }).kind;
  }
}
