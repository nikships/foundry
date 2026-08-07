import { useMemo } from 'react';
import type { EventRow, PhaseRow, RunRow } from '@shared/types.js';
import { useApp } from '../stores/app.js';
import { duration } from '../format.js';
import { phaseDuration } from '../derive.js';
import AgentAvatar from './AgentAvatar.js';

const KIND_COLOR: Record<string, string> = { code: 'var(--blue)', engineer: 'var(--amber)' };
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
    phase.kind === 'agent' ? agentColor(phase.owner) : (KIND_COLOR[phase.kind] ?? 'var(--cyan)');
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
      .filter((event) => MARKED.has(event.type))
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

  return (
    <>
      <div className="waterfall">
        <div className="axis">
          {ticks.map((tick) => (
            <span key={tick.left} className="tick" style={{ left: `${tick.left}%` }}>
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
              className={`lane ${phase.phaseId === selectedPhaseId ? 'selected' : ''} ${phase.status === 'queued' ? 'queued' : ''}`}
              onClick={() => onSelect(phase.phaseId)}
            >
              <div className="lane-label">
                {phase.kind === 'agent' ? (
                  <AgentAvatar name={phase.owner} size={26} />
                ) : (
                  <span className="kind-dot" style={{ background: laneColor(phase) }} />
                )}
                <span className="lane-name">{phase.name}</span>
                {phase.attempt > 1 && (
                  <span className="attempt mono" title={`attempt ${phase.attempt}`}>
                    ×{phase.attempt}
                  </span>
                )}
              </div>
              <div className="track">
                {bar && label ? (
                  <>
                    <div
                      className={`bar ${phase.status} ${bar.running ? 'running' : ''}`}
                      style={{
                        left: `${bar.left}%`,
                        width: `${bar.width}%`,
                        ['--lane-color' as string]: laneColor(phase) as string,
                      }}
                    >
                      {label.inside && <span className="bar-time mono">{elapsed}</span>}
                    </div>
                    {!label.inside && (
                      <span className="bar-time outside mono" style={label.style}>
                        {elapsed}
                      </span>
                    )}
                    {marksFor(phase).map((mark, i) => (
                      <span
                        key={i}
                        className={`mark ${mark.kind}`}
                        style={{ left: `${mark.left}%`, width: `${mark.width}%` }}
                        title={mark.label}
                      />
                    ))}
                  </>
                ) : (
                  <span className="not-started faint">queued</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <style>{`
        .waterfall { position: relative; display: flex; flex-direction: column; gap: var(--lane-gap); padding: var(--s5) var(--s6) var(--s4); }
        .axis { position: absolute; inset: var(--s5) var(--s6) var(--s4); left: calc(var(--s6) + 168px); pointer-events: none; }
        .tick { position: absolute; top: 0; bottom: 0; }
        .tick i { position: absolute; top: 14px; bottom: 0; width: 1px; background: var(--line-faint); }
        .tick em { position: absolute; top: 0; left: 4px; font-size: 10px; font-style: normal; color: var(--text-ghost); }
        .lane { display: flex; align-items: center; gap: var(--s3); height: var(--lane-h); padding: 0 var(--s2); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: inherit; font: inherit; cursor: default; text-align: left; transition: background var(--fast) var(--ease); }
        .lane:hover { background: var(--bg-hover); }
        .lane.selected { background: var(--bg-active); border-color: var(--cyan-dim); }
        .lane.queued { opacity: 0.5; }
        .lane-label { display: flex; align-items: center; gap: var(--s2); width: 160px; flex: none; min-width: 0; }
        .kind-dot { width: 10px; height: 10px; border-radius: var(--r-full); flex: none; }
        .lane-name { font-size: var(--text-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
        .attempt { font-size: 10px; color: var(--amber); }
        /* Not overflow:hidden — a short phase renders its duration label
           outside the bar, which must stay legible. */
        .track { flex: 1; position: relative; height: 28px; background: var(--bg-input); border-radius: var(--r-sm); }
        .bar { position: absolute; top: 4px; bottom: 4px; border-radius: 4px; background: var(--lane-color); opacity: 0.9; display: flex; align-items: center; padding: 0 6px; }
        .bar.running { animation: pulse 1.4s var(--ease) infinite; }
        .bar.success { background: var(--green); }
        .bar.fail { background: var(--red); }
        .bar.queued { background: transparent; }
        .bar-time { font-size: 10px; color: white; white-space: nowrap; }
        .bar-time.outside { position: absolute; top: 50%; transform: translateY(-50%); color: var(--text-dim); pointer-events: none; }
        .mark { position: absolute; top: 0; bottom: 0; width: 3px; border-radius: 1px; }
        .mark.tool { background: var(--blue); opacity: 0.7; }
        .mark.correction { background: var(--amber); }
        .mark.gate { background: var(--green); }
        .mark.gate-fail { background: var(--red); }
        .mark.interrupt { background: var(--purple); }
        .not-started { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); font-size: var(--text-xs); }
      `}</style>
    </>
  );
}
