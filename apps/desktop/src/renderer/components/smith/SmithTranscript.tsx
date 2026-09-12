/**
 * The Smith conversation, rendered. Shared by the dedicated screen and the
 * mini chat bubble so the two views of the one session cannot drift apart:
 * operator turns as chat bubbles, Smith's work as inspector-style folded tool
 * rows, and readiness sub-agent turns as a visually distinct bordered block —
 * the same seam the Inspector draws around run phases.
 *
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, LoaderCircle } from 'lucide-react';
import type { SmithTranscriptEntry } from '@shared/ipc-contract.js';
import type { SmithReceiptLink } from '@shared/types.js';
import { groupTranscript, type SmithTranscriptGroup } from '../../view-models/smith-chat-view.js';
import MarkdownText from '../common/MarkdownText.js';
import SmithArtifactCard from './SmithArtifactCard.js';
import SmithActivity from './SmithActivity.js';
import { smithActivityItems } from '../../view-models/smith-activity-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithTranscript.module.css';

function TranscriptRows({
  group,
  running,
  compact,
  onOpenReceiptLink,
  onOpenInspector,
}: {
  group: SmithTranscriptGroup;
  running: boolean;
  compact?: boolean;
  onOpenReceiptLink?: (link: SmithReceiptLink) => void;
  onOpenInspector?: (runId: string) => void;
}): React.JSX.Element {
  return (
    <>
      {smithActivityItems(group.entries).map((item) => {
        if (item.kind === 'activity')
          return <SmithActivity key={item.id} entries={item.entries} running={running} />;
        const entry = item.entry;
        return entry.kind === 'artifact' ? (
          <SmithArtifactCard
            key={entry.id}
            artifact={entry.artifact}
            compact={compact}
            onOpenInspector={onOpenInspector}
            {...(onOpenReceiptLink ? { onOpenReceiptLink } : {})}
          />
        ) : (
          <div key={entry.id} className={cx(styles.line, styles[entry.kind])}>
            {entry.kind === 'text' ? (
              <div className="selectable">
                <MarkdownText text={entry.text} />
              </div>
            ) : (
              <span className={cx(styles.lineText, 'selectable')}>{entry.text}</span>
            )}
          </div>
        );
      })}
    </>
  );
}

function TranscriptTurn({
  group,
  running,
  compact,
  onOpenReceiptLink,
  onOpenInspector,
}: {
  group: SmithTranscriptGroup;
  running: boolean;
  compact?: boolean;
  onOpenReceiptLink?: (link: SmithReceiptLink) => void;
  onOpenInspector?: (runId: string) => void;
}): React.JSX.Element {
  if (group.source === 'operator') {
    return (
      <div className={styles.operatorTurn}>
        {group.entries.map((entry) =>
          entry.kind === 'artifact' ? null : (
            <div key={entry.id} className={cx(styles.operatorBubble, 'selectable')}>
              {entry.text}
            </div>
          ),
        )}
      </div>
    );
  }

  const rows = (
    <TranscriptRows
      group={group}
      running={running}
      compact={compact}
      onOpenInspector={onOpenInspector}
      onOpenReceiptLink={onOpenReceiptLink}
    />
  );

  if (group.source === 'readiness') {
    return (
      <section className={styles.readinessBlock}>
        <header className={styles.readinessHead}>
          <span className={styles.readinessTag}>Readiness agent</span>
        </header>
        {rows}
      </section>
    );
  }

  return <div className={styles.smithTurn}>{rows}</div>;
}

export default function SmithTranscript({
  entries,
  running,
  compact,
  emptyState,
  tail,
  onOpenReceiptLink,
  onOpenInspector,
}: {
  entries: SmithTranscriptEntry[];
  running: boolean;
  /** Tighter spacing and full-width bubbles, for the popover. */
  compact?: boolean;
  /** Shown centred when the transcript is empty and nothing is running. */
  emptyState?: React.ReactNode;
  /** Rendered after the last group — the inline proposal card lives here. */
  tail?: React.ReactNode;
  /** Follows an action receipt's link to what the action affected. */
  onOpenReceiptLink?: (link: SmithReceiptLink) => void;
  onOpenInspector?: (runId: string) => void;
}): React.JSX.Element {
  const tailRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const operatorRef = useRef<string | undefined>(undefined);
  const [showLatest, setShowLatest] = useState(false);
  const groups = useMemo(() => groupTranscript(entries), [entries]);
  const operatorId = entries.findLast((entry) => entry.source === 'operator')?.id;
  const operatorGroup = groups.findLastIndex((group) => group.source === 'operator');

  const scrollToLatest = (): void => {
    followRef.current = true;
    setShowLatest(false);
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  };

  useLayoutEffect(() => {
    if (operatorId !== operatorRef.current) {
      followRef.current = true;
      operatorRef.current = operatorId;
      setShowLatest(false);
    }
    if (followRef.current) tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [entries, running, operatorId]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (followRef.current) tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
    });
    if (contentRef.current) observer.observe(contentRef.current);
    if (tailRef.current) observer.observe(tailRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div className={styles.thread}>
      <div
        className={cx(styles.transcript, compact && styles.compact, 'scroll')}
        ref={tailRef}
        data-testid="smith-transcript"
        onScroll={(event) => {
          const element = event.currentTarget;
          const following = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          followRef.current = following;
          setShowLatest(!following);
        }}
      >
        <div ref={contentRef} className={styles.content}>
          {entries.length === 0 && !running && emptyState}
          {groups.map((group, index) => (
            <TranscriptTurn
              key={group.id}
              group={group}
              running={running && index > operatorGroup}
              compact={compact}
              onOpenReceiptLink={onOpenReceiptLink}
              onOpenInspector={onOpenInspector}
            />
          ))}
          {running && (
            <div className={styles.working} role="status">
              <LoaderCircle size={14} className={styles.spinner} />
              <span>
                Smith is working
                <span className={styles.dots} aria-hidden>
                  ...
                </span>
              </span>
            </div>
          )}
          {tail}
        </div>
      </div>
      {showLatest && (
        <button type="button" className={styles.latest} onClick={scrollToLatest}>
          <ArrowDown size={14} /> Latest message
        </button>
      )}
    </div>
  );
}
