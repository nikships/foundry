/**
 * One lane of the Inspector: a phase's full transcript, headered with who is
 * doing the work (agent, CLI, model) and how it is going (status, elapsed,
 * tokens, context used). The lane follows the tail of the transcript while
 * the user is at the bottom and stops following the moment they scroll up,
 * because yanking the scroll position away from a reader is worse than a
 * stale view.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentSessionRow, EnvelopeRow, EventRow, PhaseRow } from '@shared/types.js';
import AgentAvatar from '../AgentAvatar.js';
import StatusBadge from '../StatusBadge.js';
import { duration, modelLabel, tokens } from '../../format.js';
import { usageFor } from '../../derive.js';
import { TranscriptEntry, transcriptStyles } from './entries.js';

function ContextBar({
  session,
}: {
  session: AgentSessionRow | undefined;
}): React.JSX.Element | null {
  if (!session || !session.contextWindow) return null;
  const used = session.contextTokens ?? 0;
  const pct = Math.min(100, Math.round((used / session.contextWindow) * 100));
  return (
    <span
      className="lane-context"
      title={`${used.toLocaleString()} of ${session.contextWindow.toLocaleString()} context tokens`}
    >
      <span className="lane-context-bar">
        <span className="lane-context-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="lane-context-label">{pct}%</span>
    </span>
  );
}

function EnvelopeCard({ envelope }: { envelope: EnvelopeRow }): React.JSX.Element {
  const summary = typeof envelope.payload.summary === 'string' ? envelope.payload.summary : '';
  return (
    <div className={`lane-envelope ${envelope.valid ? 'ok' : 'fail'}`}>
      <div className="lane-envelope-head">
        <span className="te-tag">envelope</span>
        <span className="lane-envelope-status">{envelope.valid ? 'accepted' : 'invalid'}</span>
        {envelope.attempt > 1 && (
          <span className="lane-envelope-attempt">attempt {envelope.attempt}</span>
        )}
      </div>
      {summary && <div className="lane-envelope-summary">{summary}</div>}
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
  const lastEventKey = events.length
    ? `${events[events.length - 1]!.eventId}:${events.length}`
    : '';

  const session = sessions.find((s) => s.agent === phase.owner);
  const cli = session?.cli ?? 'droid';
  const model = modelLabel(session?.model);
  const elapsed = phase.startedAt
    ? new Date(phase.endedAt ?? now).getTime() - new Date(phase.startedAt).getTime()
    : null;
  const usage = usageFor(events);
  const tokenCount = usage.reported ? usage.totalTokens : null;

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
    <section className={`lane ${phase.status} ${focused ? 'focused' : ''}`}>
      <header className="lane-head">
        <AgentAvatar name={phase.owner} size={26} />
        <div className="lane-title">
          <span className="lane-phase">{phase.name}</span>
          <span className="lane-agent">
            {phase.owner ?? 'code'}
            <span className="lane-cli">{cli}</span>
            <span className="lane-model">{model}</span>
          </span>
        </div>
        <div className="lane-stats">
          {tokenCount != null && tokenCount > 0 && (
            <span className="lane-tokens">{tokens(tokenCount)} tok</span>
          )}
          <ContextBar session={session} />
          {elapsed != null && <span className="lane-elapsed">{duration(elapsed)}</span>}
          <StatusBadge status={phase.status} />
          <button
            className="lane-focus"
            onClick={onToggleFocus}
            title={focused ? 'Back to all lanes' : 'Focus this lane'}
          >
            {focused ? '✕' : '⤢'}
          </button>
        </div>
      </header>
      <div className="lane-scroll" ref={scrollRef} onScroll={onScroll}>
        {events.length === 0 && <div className="lane-empty">nothing recorded yet</div>}
        {events.map((event) => (
          <TranscriptEntry key={event.eventId} event={event} />
        ))}
        {envelope && <EnvelopeCard envelope={envelope} />}
      </div>
      {showJump && (
        <button className="lane-jump" onClick={jumpToLatest}>
          ↓ latest
        </button>
      )}
      <style>{`
        .lane { position: relative; display: flex; flex-direction: column; min-height: 0; background: var(--bg-panel); border: 1px solid var(--line-faint); border-radius: var(--r-md, 10px); overflow: hidden; }
        .lane.running { border-color: color-mix(in srgb, var(--cyan) 28%, transparent); }
        .lane.fail { border-color: color-mix(in srgb, var(--red) 30%, transparent); }
        .lane-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--line-faint); background: var(--bg-raised); flex: none; }
        .lane-title { display: flex; flex-direction: column; min-width: 0; }
        .lane-phase { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .lane-agent { display: flex; gap: 6px; align-items: baseline; font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; }
        .lane-cli { padding: 0 5px; border: 1px solid var(--line); border-radius: var(--r-full); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; }
        .lane-model { overflow: hidden; text-overflow: ellipsis; }
        .lane-stats { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
        .lane-tokens, .lane-elapsed { font-size: 11px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
        .lane-context { display: flex; align-items: center; gap: 5px; }
        .lane-context-bar { width: 44px; height: 4px; border-radius: 2px; background: var(--line); overflow: hidden; }
        .lane-context-fill { display: block; height: 100%; background: var(--cyan); }
        .lane-context-label { font-size: 10px; color: var(--text-faint); }
        .lane-focus { border: none; background: none; color: var(--text-faint); font-size: 13px; padding: 2px 6px; border-radius: var(--r-sm); cursor: pointer; }
        .lane-focus:hover { background: var(--bg-hover, var(--line-faint)); color: var(--text); }
        .lane-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 12px 14px; }
        .lane-empty { padding: 18px 0; text-align: center; font-size: 12px; color: var(--text-faint); }
        .lane-jump { position: absolute; right: 14px; bottom: 12px; border: 1px solid var(--line-strong); background: var(--bg-raised); color: var(--text-dim); font-size: 11px; padding: 3px 10px; border-radius: var(--r-full); cursor: pointer; box-shadow: var(--shadow-sm, 0 2px 8px rgba(0,0,0,0.4)); }
        .lane-jump:hover { color: var(--text); }
        .lane-envelope { margin-top: 10px; padding: 8px 10px; border-radius: var(--r-sm); border: 1px solid var(--line); }
        .lane-envelope.ok { border-color: color-mix(in srgb, var(--green) 35%, transparent); }
        .lane-envelope.fail { border-color: color-mix(in srgb, var(--red) 35%, transparent); }
        .lane-envelope-head { display: flex; gap: 8px; align-items: baseline; }
        .lane-envelope-status { font-size: 11px; font-weight: 600; }
        .lane-envelope-attempt { font-size: 10px; color: var(--text-faint); }
        .lane-envelope.ok .lane-envelope-status { color: var(--green); }
        .lane-envelope.fail .lane-envelope-status { color: var(--red); }
        .lane-envelope-summary { margin-top: 4px; font-size: 12px; color: var(--text-dim); white-space: pre-wrap; }
      `}</style>
      <style>{transcriptStyles()}</style>
    </section>
  );
}
