import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventRow, PhaseRow, RunRow } from '@shared/types.js';
import { useApp } from '../../stores/app.js';
import { duration } from '../../utils/format.js';
import { isAutoAllowPolicy, phaseDuration, phaseKindColor } from '../../utils/derive.js';
import {
  axisLabel,
  axisTicks,
  buildTimeScale,
  densityBins,
  type Span,
  type TimeScale,
} from '../../utils/time-scale.js';
import AgentAvatar from '../media/AgentAvatar.js';
import { cx } from '../ui/cx.js';
import styles from './Waterfall.module.css';

/**
 * Events that earn a full-height flag on the bar. Tool calls are deliberately
 * absent: they are the high-volume type and render as a density strip instead,
 * so a phase with hundreds of them stays readable.
 */
const FLAG_STYLE: Partial<Record<EventRow['type'], string>> = {
  correction: styles.correction,
  gate_fail: styles.gateFail,
  interrupt: styles.interrupt,
};

/** Status colour for the bar's end cap and the duration gutter. */
const STATUS_COLOR: Record<string, string> = {
  success: 'var(--green)',
  fail: 'var(--red)',
  running: 'var(--accent-bright)',
  skipped: 'var(--text-faint)',
  queued: 'var(--text-ghost)',
};

interface LaneBar {
  left: number;
  width: number;
  span: Span;
}

/** Track width the scale is measured against before the first layout pass. */
const FALLBACK_TRACK_PX = 640;

export default function Waterfall({
  run,
  phases,
  eventsByPhase,
  selectedPhaseId,
  now,
  onSelect,
}: {
  run: RunRow;
  phases: PhaseRow[];
  eventsByPhase: Map<string, EventRow[]>;
  selectedPhaseId: string;
  now: number;
  onSelect: (phaseId: string) => void;
}): React.JSX.Element {
  const { agentColor } = useApp();
  const rulerRef = useRef<HTMLDivElement>(null);
  const [trackPx, setTrackPx] = useState(FALLBACK_TRACK_PX);

  // Tick density depends on real pixels, so measure rather than guess.
  useEffect(() => {
    const node = rulerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width > 0) setTrackPx(width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const laneColor = useCallback(
    (phase: PhaseRow): string => phaseKindColor(phase.kind, agentColor(phase.owner)),
    [agentColor],
  );

  const t0 = useMemo(() => new Date(run.startedAt).getTime(), [run.startedAt]);
  const total = useMemo(() => {
    const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
    return Math.max(end - t0, 1000);
  }, [run.endedAt, now, t0]);

  /** Phase spans as ms offsets from run start; the scale's active stretches. */
  const spans = useMemo(() => {
    const out = new Map<string, Span>();
    for (const phase of phases) {
      if (!phase.startedAt) continue;
      const start = new Date(phase.startedAt).getTime() - t0;
      const end = (phase.endedAt ? new Date(phase.endedAt).getTime() : now) - t0;
      out.set(phase.phaseId, { start: Math.max(0, start), end: Math.max(start, end) });
    }
    return out;
  }, [phases, t0, now]);

  const scale: TimeScale = useMemo(
    () => buildTimeScale([...spans.values()], total),
    [spans, total],
  );
  const ticks = useMemo(() => axisTicks(scale, trackPx), [scale, trackPx]);
  const breaks = useMemo(() => scale.segments.filter((s) => s.kind === 'break'), [scale]);

  const barFor = (phase: PhaseRow): LaneBar | null => {
    const span = spans.get(phase.phaseId);
    if (!span) return null;
    const left = scale.toPercent(span.start);
    return { left, width: Math.max(0, scale.toPercent(span.end) - left), span };
  };

  /** Tool-call offsets for the density strip, plus the flagged one-off events. */
  const activityFor = (
    phase: PhaseRow,
  ): { tools: number[]; flags: { at: number; style: string; label: string }[] } => {
    const events = eventsByPhase.get(phase.phaseId) ?? [];
    const tools: number[] = [];
    const flags: { at: number; style: string; label: string }[] = [];
    for (const event of events) {
      if (isAutoAllowPolicy(event)) continue;
      const at = new Date(event.startedAt).getTime() - t0;
      const flagStyle = FLAG_STYLE[event.type];
      if (event.type === 'tool_call') tools.push(at);
      else if (flagStyle) flags.push({ at, style: flagStyle, label: event.name });
    }
    return { tools, flags };
  };

  return (
    <div className={styles.waterfall}>
      <div className={styles.header}>
        <p className="eyebrow">
          <span className="index">01</span>Timeline
        </p>
        {scale.compressed && (
          <span className={`${styles.scaleNote} mono`}>elapsed &middot; idle compressed</span>
        )}
      </div>

      <div className={styles.row}>
        <span className={styles.gridLabel} />
        <div className={styles.ruler} ref={rulerRef}>
          {ticks.map((tick) => (
            <span key={tick.t} className={`${styles.tick} mono`} style={{ left: `${tick.x}%` }}>
              {axisLabel(tick.t)}
            </span>
          ))}
          {breaks.map((seg) => (
            <span
              key={seg.t0}
              className={`${styles.breakLabel} mono`}
              style={{ left: `${seg.x0}%`, width: `${seg.x1 - seg.x0}%` }}
              title={`${duration(seg.t1 - seg.t0)} with no phase running`}
            >
              {duration(seg.t1 - seg.t0)} idle
            </span>
          ))}
        </div>
        <span className={styles.gridTime} />
      </div>

      {phases.map((phase) => {
        const bar = barFor(phase);
        const hue = laneColor(phase);
        const elapsed = phaseDuration(phase, now);
        const { tools, flags } = bar ? activityFor(phase) : { tools: [], flags: [] };
        const barPx = bar ? Math.max(2, (bar.width / 100) * trackPx) : 0;
        const bins = bar ? densityBins(tools, bar.span, barPx) : [];

        return (
          <button
            key={phase.phaseId}
            className={cx(
              styles.row,
              styles.lane,
              phase.phaseId === selectedPhaseId && styles.selected,
              !bar && styles.inactive,
            )}
            onClick={() => onSelect(phase.phaseId)}
            data-testid={`phase-lane-${phase.phaseId}`}
            data-phase-name={phase.name}
          >
            <span className={styles.laneLabel}>
              {phase.kind === 'agent' ? (
                <AgentAvatar name={phase.owner} size={24} />
              ) : (
                <span className={styles.kindSlot}>
                  <span className={styles.kindDot} style={{ background: hue }} />
                </span>
              )}
              <span className={styles.laneName}>{phase.name}</span>
              {phase.attempt > 1 && (
                <span className={`${styles.attempt} mono`} title={`attempt ${phase.attempt}`}>
                  &times;{phase.attempt}
                </span>
              )}
            </span>

            <span className={styles.track}>
              {ticks.map((tick) => (
                <span key={tick.t} className={styles.gridLine} style={{ left: `${tick.x}%` }} />
              ))}
              {breaks.map((seg) => (
                <span
                  key={seg.t0}
                  className={styles.breakFill}
                  style={{ left: `${seg.x0}%`, width: `${seg.x1 - seg.x0}%` }}
                />
              ))}

              {bar ? (
                <>
                  {/* The bar keeps the agent/kind hue; status reads from the
                      end cap and the gutter, so identity survives completion. */}
                  <span
                    className={cx(styles.bar, phase.status === 'running' && styles.running)}
                    style={{
                      left: `${bar.left}%`,
                      width: `max(2px, ${bar.width}%)`,
                      background: hue,
                    }}
                  />
                  {(phase.status === 'success' || phase.status === 'fail') && (
                    <span
                      className={styles.endCap}
                      style={{
                        left: `calc(${bar.left + bar.width}% - 2px)`,
                        background: STATUS_COLOR[phase.status],
                      }}
                    />
                  )}
                  {bins.map((bin) => (
                    <span
                      key={bin.index}
                      className={styles.density}
                      style={{
                        left: `calc(${bar.left}% + ${((bin.index / bin.total) * bar.width * trackPx) / 100}px)`,
                        height: `${2 + Math.round((bin.count / bin.peak) * 3)}px`,
                        opacity: 0.35 + 0.55 * (bin.count / bin.peak),
                      }}
                    />
                  ))}
                  {flags.map((flag, i) => (
                    <span
                      key={`${flag.label}-${i}`}
                      className={cx(styles.flag, flag.style)}
                      style={{ left: `calc(${scale.toPercent(flag.at)}% - 1px)` }}
                      title={flag.label}
                    />
                  ))}
                </>
              ) : (
                <span className={styles.notStarted} />
              )}
            </span>

            <span
              className={`${styles.laneTime} mono`}
              style={{ color: STATUS_COLOR[phase.status] ?? 'var(--text)' }}
            >
              {bar ? duration(elapsed) : phase.status === 'skipped' ? 'skipped' : 'queued'}
            </span>
          </button>
        );
      })}
    </div>
  );
}
