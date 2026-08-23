import { useEffect, useRef } from 'react';
import type { PanelEntry } from '@shared/types.js';
import { cx } from '../ui/cx.js';
import styles from './DetectionPanel.module.css';

/** Same vocabulary as the Smith transcript so the two cannot drift apart visually. */
const TOOL_ICON: Record<string, string> = {
  command: '⚙',
  read: '◇',
  edit: '✎',
  search: '⌕',
  other: '·',
};

/**
 * The scrolling body of a one-shot panel: what the agent is doing, line by
 * line. Follows the tail while the agent is working, then stops once it is
 * done so a reader who scrolled up to inspect a tool call is not yanked down.
 */
export default function PanelTranscript({
  entries,
  live,
}: {
  entries: PanelEntry[];
  live: boolean;
}): React.JSX.Element {
  const tailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!live) return;
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [entries, live]);

  return (
    <div className={`${styles.transcript} scroll`} ref={tailRef}>
      {entries.map((entry) => (
        <div key={entry.id} className={cx(styles.line, styles[entry.kind])}>
          {entry.kind === 'tool' && (
            <span
              className={cx(
                styles.transcriptIcon,
                entry.done ? (entry.failed ? styles.failed : styles.ok) : styles.wait,
              )}
            >
              {TOOL_ICON[entry.toolKind ?? 'other'] ?? '·'}
            </span>
          )}
          <span className={styles.transcriptText}>{entry.text}</span>
        </div>
      ))}
      {live && <div className={cx(styles.line, styles.note, styles.pulse)}>…</div>}
      {!entries.length && !live && (
        <div className={cx(styles.line, styles.note)}>Nothing was reported.</div>
      )}
    </div>
  );
}
