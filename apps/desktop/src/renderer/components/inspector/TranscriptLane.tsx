/**
 * One lane of the Inspector: a phase's full transcript, headered with who is
 * doing the work (agent, transport, model) and how it is going (status, elapsed,
 * context used). The lane follows the tail of the transcript while
 * the user is at the bottom and stops following the moment they scroll up,
 * because yanking the scroll position away from a reader is worse than a
 * stale view.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentSessionRow, EnvelopeRow, EventRow, PhaseRow } from '@shared/types.js';
import { modelLabel } from '@shared/model-label.js';
import AgentAvatar from '../media/AgentAvatar.js';
import StatusBadge from '../common/StatusBadge.js';
import { duration, tokens } from '../../utils/format.js';
import { isAutoAllowPolicy, phaseDuration } from '../../utils/derive.js';
import { TranscriptEntry, transcriptStyles } from './entries.js';
import styles from './TranscriptLane.module.css';

function ContextMeter({
  session,
}: {
  session: AgentSessionRow | undefined;
}): React.JSX.Element | null {
  if (!session || !session.contextWindow) return null;
  const used = session.contextTokens ?? 0;
  const pct = Math.min(100, Math.round((used / session.contextWindow) * 100));
  const exactUsage = `${used.toLocaleString()} tokens in context of ${session.contextWindow.toLocaleString()}`;
  return (
    <span
      className={styles.laneContext}
      role="meter"
      aria-label="Context occupancy"
      aria-valuemin={0}
      aria-valuemax={session.contextWindow}
      aria-valuenow={used}
      aria-valuetext={`${exactUsage}, ${pct}% used`}
      title={`${exactUsage} (${pct}% used). This is the conversation retained for the next turn.`}
    >
      <span className={styles.laneContextName}>Context</span>
      <span className={styles.laneContextBar} aria-hidden>
        <span className={styles.laneContextFill} style={{ width: `${pct}%` }} />
      </span>
      <span className={styles.laneContextLabel}>
        {tokens(used)} / {tokens(session.contextWindow)}
      </span>
    </span>
  );
}

function EnvelopeCard({ envelope }: { envelope: EnvelopeRow }): React.JSX.Element {
  const summary = typeof envelope.payload.summary === 'string' ? envelope.payload.summary : '';
  return (
    <div className={`${styles.laneEnvelope} ${envelope.valid ? 'ok' : 'fail'}`}>
      <div className={styles.laneEnvelopeHead}>
        <span className="te-tag">report</span>
        <span className={styles.laneEnvelopeStatus}>{envelope.valid ? 'accepted' : 'invalid'}</span>
        {envelope.attempt > 1 && (
          <span className={styles.laneEnvelopeAttempt}>attempt {envelope.attempt}</span>
        )}
      </div>
      {summary && <div className={styles.laneEnvelopeSummary}>{summary}</div>}
    </div>
  );
}

export default function TranscriptLane({
  phase,
  events,
  envelope,
  sessions,
  now,
  focused,
  onToggleFocus,
}: {
  phase: PhaseRow;
  events: EventRow[];
  envelope: EnvelopeRow | undefined;
  sessions: AgentSessionRow[];
  now: number;
  focused: boolean;
  onToggleFocus: () => void;
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const visibleEvents = events.filter((event) => !isAutoAllowPolicy(event));
  const lastEventKey = visibleEvents.length
    ? `${visibleEvents[visibleEvents.length - 1]!.eventId}:${visibleEvents.length}`
    : '';

  const session = sessions.find((s) => s.agent === phase.owner);
  const transport = session?.mode ?? 'pi';
  const model = modelLabel(session?.model);
  const elapsed = phaseDuration(phase, now);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  const jumpToLatest = useCallback((): void => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  }, []);

  // Follow the tail only while the reader is already there.
  useLayoutEffect(() => {
    if (atBottomRef.current) jumpToLatest();
    else setShowJump(true);
  }, [lastEventKey, jumpToLatest]);

  useEffect(() => {
    jumpToLatest();
  }, [jumpToLatest]);

  return (
    <section className={`${styles.lane} ${phase.status} ${focused ? 'focused' : ''}`}>
      <header className={styles.laneHead}>
        <span className={styles.laneAvatar}>
          <AgentAvatar name={phase.owner} size={26} />
        </span>
        <div className={styles.laneTitle}>
          <span className={styles.lanePhase} title={phase.name}>
            {phase.name}
          </span>
          <span className={styles.laneAgent}>
            <span className={styles.laneOwner}>{phase.owner ?? 'code'}</span>
            <span className={styles.laneCli}>{transport}</span>
            <span className={styles.laneModel} title={model}>
              {model}
            </span>
          </span>
        </div>
        <div className={styles.laneStats}>
          <ContextMeter session={session} />
          {elapsed != null && <span className={styles.laneElapsed}>{duration(elapsed)}</span>}
          <span className={styles.laneStatus}>
            <StatusBadge status={phase.status} />
            <button
              className={styles.laneFocus}
              onClick={onToggleFocus}
              title={focused ? 'Back to all lanes' : 'Focus this lane'}
            >
              {focused ? '✕' : '⤢'}
            </button>
          </span>
        </div>
      </header>
      <div className={styles.laneScroll} ref={scrollRef} onScroll={onScroll}>
        {visibleEvents.length === 0 && <div className={styles.laneEmpty}>nothing recorded yet</div>}
        {visibleEvents.map((event) => (
          <TranscriptEntry key={event.eventId} event={event} />
        ))}
        {envelope && <EnvelopeCard envelope={envelope} />}
      </div>
      {showJump && (
        <button className={styles.laneJump} onClick={jumpToLatest}>
          ↓ latest
        </button>
      )}
      <style>{transcriptStyles()}</style>
    </section>
  );
}
