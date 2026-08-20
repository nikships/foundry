import { useMemo } from 'react';
import type { EventRow, PhaseRow, RunRow } from '@shared/types.js';
import { useApp } from '../../stores/app.js';
import { duration } from '../../utils/format.js';
import { isAutoAllowPolicy, phaseDuration, phaseKindColor } from '../../utils/derive.js';
import AgentAvatar from '../media/AgentAvatar.js';
import styles from './Waterfall.module.css';

const MARK_CLASS: Partial<Record<EventRow['type'], string>> = {
  tool_call: 'tool',
  correction: 'correction',
  gate_pass: 'gate',
  gate_fail: 'gate-fail',
  interrupt: 'interrupt',
};
const MARKED = new Set(Object.keys(MARK_CLASS));

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
  const laneColor = (phase: PhaseRow): string =>
    phaseKindColor(phase.kind, agentColor(phase.owner));
  const t0 = useMemo(() => new Date(run.startedAt).getTime(), [run.startedAt]);
  const span = useMemo(() => {
    const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
    return Math.max(end - t0, 1000);
  }, [run.endedAt, now, t0]);

  const pct = (ms: number): number => Math.min(100, Math.max(0, ((ms - t0) / span) * 100));

  const barFor = (phase: PhaseRow): { left: number; width: number; running: boolean } | null => {
    if (!phase.startedAt) return null;
    const start = new Date(phase.startedAt).getTime();
    const end = phase.endedAt ? new Date(phase.endedAt).getTime() : now;
    const left = pct(start);
    return { left, width: Math.max(0.6, pct(end) - left), running: !phase.endedAt };
  };

  /** Place duration inside wide bars; beside short bars, flipping left near the right edge. */
  const labelFor = (bar: {
    left: number;
    width: number;
  }): { inside: boolean; style: React.CSSProperties } => {
    if (bar.width > 6) return { inside: true, style: {} };
    const end = bar.left + bar.width;
    if (end > 88) return { inside: false, style: { right: `calc(${100 - bar.left}% + 6px)` } };
    return { inside: false, style: { left: `calc(${end}% + 6px)` } };
  };

  const marksFor = (
    phase: PhaseRow,
  ): { left: number; width: number; kind: string; label: string }[] => {
    const events = eventsByPhase.get(phase.phaseId) ?? [];
    return events
      .filter((event) => MARKED.has(event.type) && !isAutoAllowPolicy(event))
      .map((event) => {
        const start = new Date(event.startedAt).getTime();
        const end = event.endedAt ? new Date(event.endedAt).getTime() : start + 400;
        const left = pct(start);
        return {
          left,
          width: Math.max(0.35, pct(end) - left),
          kind: MARK_CLASS[event.type]!,
          label: event.name,
        };
      });
  };

  const ticks = useMemo(() => {
    let step = 300_000;
    if (span <= 60_000) step = 10_000;
    else if (span <= 600_000) step = 60_000;
    const out: { left: number; label: string }[] = [];
    for (let ms = step; ms < span; ms += step) {
      out.push({ left: (ms / span) * 100, label: duration(ms) });
    }
    return out;
  }, [span]);

  const markStyleFor = (kind: string): string => {
    const map: Record<string, string> = {
      tool: styles.tool,
      correction: styles.correction,
      gate: styles.gate,
      'gate-fail': styles.gateFail,
      interrupt: styles.interrupt,
    };
    return map[kind] ?? '';
  };

  const barStatusStyle = (status: string): string => {
    const map: Record<string, string> = {
      queued: styles.queued,
      running: styles.running,
      success: styles.success,
      fail: styles.fail,
      skipped: styles.skipped,
    };
    return map[status] ?? '';
  };

  return (
    <div className={styles.waterfall}>
      <p className={`eyebrow ${styles.eyebrow}`}>
        <span className="index">01</span>Timeline
      </p>
      <div className={styles.axis}>
        {ticks.map((tick) => (
          <span key={tick.left} className={styles.tick} style={{ left: `${tick.left}%` }}>
            <i />
            <em className="mono">{tick.label}</em>
          </span>
        ))}
      </div>
      {phases.map((phase) => {
        const bar = barFor(phase);
        const label = bar ? labelFor(bar) : null;
        const elapsed = duration(phaseDuration(phase, now));
        return (
          <button
            key={phase.phaseId}
            className={`${styles.lane} ${phase.phaseId === selectedPhaseId ? styles.selected : ''} ${phase.status === 'queued' ? styles.queued : ''}`}
            onClick={() => onSelect(phase.phaseId)}
          >
            <div className={styles.laneLabel}>
              {phase.kind === 'agent' ? (
                <AgentAvatar name={phase.owner} size={26} />
              ) : (
                <span className={styles.kindDot} style={{ background: laneColor(phase) }} />
              )}
              <span className={styles.laneName}>{phase.name}</span>
              {phase.attempt > 1 && (
                <span className={`${styles.attempt} mono`} title={`attempt ${phase.attempt}`}>
                  ×{phase.attempt}
                </span>
              )}
            </div>
            <div className={styles.track}>
              {bar && label ? (
                <>
                  <div
                    className={`${styles.bar} ${barStatusStyle(phase.status)} ${bar.running ? styles.running : ''}`}
                    style={{
                      left: `${bar.left}%`,
                      width: `${bar.width}%`,
                      ['--lane-color' as string]: laneColor(phase) as string,
                    }}
                  >
                    {label.inside && <span className={`${styles.barTime} mono`}>{elapsed}</span>}
                  </div>
                  {!label.inside && (
                    <span
                      className={`${styles.barTime} ${styles.outside} mono`}
                      style={label.style}
                    >
                      {elapsed}
                    </span>
                  )}
                  {marksFor(phase).map((mark, i) => (
                    <span
                      key={i}
                      className={`${styles.mark} ${markStyleFor(mark.kind)}`}
                      style={{ left: `${mark.left}%`, width: `${mark.width}%` }}
                      title={mark.label}
                    />
                  ))}
                </>
              ) : (
                <span className={`${styles.notStarted} faint`}>queued</span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
