import { Check, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import type { SmithChatEntry } from '@shared/ipc-contract.js';
import { smithActivityStatus, smithToolSummary } from '../../view-models/smith-activity-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithActivity.module.css';

export default function SmithActivity({
  entries,
  running,
}: {
  entries: SmithChatEntry[];
  running: boolean;
}): React.JSX.Element {
  const { active, failed, label } = smithActivityStatus(entries, running);
  return (
    <details
      key={String(active)}
      open={active}
      className={cx(styles.activity, failed && styles.failed)}
      data-testid="smith-activity"
    >
      <summary className={styles.summary}>
        <ChevronRight className={styles.chevron} size={14} />
        {active ? (
          <LoaderCircle className={styles.spinner} size={14} />
        ) : failed ? (
          <CircleAlert size={14} />
        ) : (
          <Check size={14} />
        )}
        <span>{label}</span>
      </summary>
      <div className={styles.steps}>
        {entries.map((entry) => (
          <details key={entry.id} className={styles.step}>
            <summary className={styles.summary}>
              <ChevronRight className={styles.chevron} size={12} />
              {entry.failed ? (
                <CircleAlert size={13} className={styles.failed} />
              ) : running && entry.kind === 'tool' && !entry.done ? (
                <LoaderCircle size={13} className={styles.spinner} />
              ) : null}
              <span className={styles.toolTitle}>{smithToolSummary(entry)}</span>
              {entry.failed && <span className={styles.failed}>Failed</span>}
            </summary>
            <pre className={cx(styles.output, 'selectable')} tabIndex={0}>
              {entry.text}
            </pre>
          </details>
        ))}
      </div>
    </details>
  );
}
