/**
 * The Smith conversation, rendered. Shared by the dedicated screen and the
 * mini chat bubble so the two views of the one session cannot drift apart:
 * operator turns as chat bubbles, Smith's work as inspector-style folded tool
 * rows, and readiness sub-agent turns as a visually distinct bordered block —
 * the same seam the Inspector draws around run phases.
 *
 * Owns the scroll container and the tail-follow behaviour: it follows the tail
 * while Smith is working, but stops once the turn settles so a reader who
 * scrolled up to inspect a tool call is not yanked back down.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { SmithTranscriptEntry } from '@shared/ipc-contract.js';
import {
  SMITH_TOOL_ICON,
  groupTranscript,
  type SmithTranscriptGroup,
} from '../../view-models/smith-chat-view.js';
import MarkdownText from '../common/MarkdownText.js';
import SmithArtifactCard from './SmithArtifactCard.js';
import { cx } from '../ui/cx.js';
import styles from './SmithTranscript.module.css';

function TranscriptRows({
  group,
  compact,
}: {
  group: SmithTranscriptGroup;
  compact?: boolean;
}): React.JSX.Element {
  return (
    <>
      {group.entries.map((entry) =>
        entry.kind === 'artifact' ? (
          <SmithArtifactCard key={entry.id} artifact={entry.artifact} compact={compact} />
        ) : (
          <div key={entry.id} className={cx(styles.line, styles[entry.kind])}>
            {entry.kind === 'tool' && (
              <span
                className={cx(
                  styles.lineIcon,
                  entry.done ? (entry.failed ? styles.iconFailed : styles.iconOk) : styles.iconWait,
                )}
              >
                {SMITH_TOOL_ICON[entry.toolKind ?? 'other'] ?? '·'}
              </span>
            )}
            {entry.kind === 'text' ? (
              <MarkdownText text={entry.text} />
            ) : (
              <span className={styles.lineText}>{entry.text}</span>
            )}
          </div>
        ),
      )}
    </>
  );
}

export default function SmithTranscript({
  entries,
  running,
  compact,
  emptyState,
  tail,
}: {
  entries: SmithTranscriptEntry[];
  running: boolean;
  /** Tighter spacing and full-width bubbles, for the popover. */
  compact?: boolean;
  /** Shown centred when the transcript is empty and nothing is running. */
  emptyState?: React.ReactNode;
  /** Rendered after the last group — the inline proposal card lives here. */
  tail?: React.ReactNode;
}): React.JSX.Element {
  const tailRef = useRef<HTMLDivElement | null>(null);
  const groups = useMemo(() => groupTranscript(entries), [entries]);

  useEffect(() => {
    if (!running) return;
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [entries, running]);

  return (
    <div
      className={cx(styles.transcript, compact && styles.compact, 'scroll')}
      ref={tailRef}
      data-testid="smith-transcript"
    >
      {entries.length === 0 && !running && emptyState}
      {groups.map((group) =>
        group.source === 'operator' ? (
          <div key={group.id} className={styles.operatorTurn}>
            {group.entries.map((entry) =>
              entry.kind === 'artifact' ? null : (
                <div key={entry.id} className={styles.operatorBubble}>
                  {entry.text}
                </div>
              ),
            )}
          </div>
        ) : group.source === 'readiness' ? (
          <section key={group.id} className={styles.readinessBlock}>
            <header className={styles.readinessHead}>
              <span className={styles.readinessTag}>Readiness agent</span>
            </header>
            <TranscriptRows group={group} compact={compact} />
          </section>
        ) : (
          <div key={group.id} className={styles.smithTurn}>
            <TranscriptRows group={group} compact={compact} />
          </div>
        ),
      )}
      {running && <div className={cx(styles.line, styles.note, styles.pulse)}>…</div>}
      {tail}
    </div>
  );
}
