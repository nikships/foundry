/**
 * The freeform pipeline canvas.
 *
 * Phase cards over a dot grid, wired in execution order with bezier curves that
 * re-route live as you drag. The dashed amber curve is the real feedback edge:
 * a failing command hands its evidence back to an earlier agent phase
 * (PhaseDef.feedbackTo in src/shared/types.ts).
 *
 * Mirrors src/renderer/components/PipelineCanvas.tsx.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { CANVAS_PHASES, KIND_LABEL, agentColor } from '../../data/foundry';
import type { CanvasPhase, PhaseKind } from '../../data/foundry';
import { Chip, Dot } from '../ui';

const NODE_W = 214;

const kindColor = (p: CanvasPhase): string =>
  p.kind === 'code' ? 'var(--blue)' : p.kind === 'engineer' ? 'var(--amber)' : agentColor(p.agent);

interface Point {
  x: number;
  y: number;
}

let added = 0;

export function PipelineCanvasDemo() {
  const [phases, setPhases] = useState<CanvasPhase[]>(() => CANVAS_PHASES.map((p) => ({ ...p })));
  const [selected, setSelected] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });

  const stageRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef<Array<HTMLElement | null>>([]);
  const [flow, setFlow] = useState('');
  const [feedback, setFeedback] = useState('');

  /* ── wires ─────────────────────────────────────────────────────────── */
  const route = useCallback(() => {
    let d = '';
    for (let i = 0; i < phases.length - 1; i++) {
      const a = phases[i];
      const b = phases[i + 1];
      const an = nodeRefs.current[i];
      const bn = nodeRefs.current[i + 1];
      if (!an || !bn) continue;
      const x1 = a.x + NODE_W;
      const y1 = a.y + an.offsetHeight / 2;
      const x2 = b.x;
      const y2 = b.y + bn.offsetHeight / 2;
      const dx = Math.max(46, Math.abs(x2 - x1) * 0.55);
      d += `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2} `;
    }
    setFlow(d.trim());

    const ti = phases.findIndex((p) => p.feedbackTo);
    const bi = ti >= 0 ? phases.findIndex((p) => p.name === phases[ti].feedbackTo) : -1;
    if (ti >= 0 && bi >= 0 && nodeRefs.current[ti] && nodeRefs.current[bi]) {
      const t = phases[ti];
      const b = phases[bi];
      const x1 = t.x + NODE_W / 2;
      const y1 = t.y;
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y;
      const lift = 44 + Math.abs(x2 - x1) * 0.12;
      setFeedback(`M${x1},${y1} C${x1},${y1 - lift} ${x2},${y2 - lift} ${x2},${y2}`);
    } else {
      setFeedback('');
    }
  }, [phases]);

  useLayoutEffect(() => {
    route();
  }, [route]);

  useLayoutEffect(() => {
    window.addEventListener('resize', route, { passive: true });
    return () => window.removeEventListener('resize', route);
  }, [route]);

  /* ── dragging a card ───────────────────────────────────────────────── */
  const onNodePointerDown = (index: number) => (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const node = e.currentTarget;
    node.setPointerCapture(e.pointerId);
    setSelected(index);
    setDragging(index);

    const sx = e.clientX;
    const sy = e.clientY;
    const origin = { x: phases[index].x, y: phases[index].y };

    const move = (ev: PointerEvent) => {
      setPhases((prev) =>
        prev.map((p, i) =>
          i === index
            ? { ...p, x: Math.round(origin.x + (ev.clientX - sx)), y: Math.round(origin.y + (ev.clientY - sy)) }
            : p,
        ),
      );
    };
    const up = () => {
      setDragging(null);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  };

  /* ── panning the board ─────────────────────────────────────────────── */
  const onStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-node]')) return;
    const stage = e.currentTarget;
    stage.setPointerCapture(e.pointerId);
    const sx = e.clientX;
    const sy = e.clientY;
    const origin = { ...pan };

    const move = (ev: PointerEvent) => {
      setPan({ x: origin.x + (ev.clientX - sx), y: origin.y + (ev.clientY - sy) });
    };
    const up = () => {
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
  };

  /* ── toolbar ───────────────────────────────────────────────────────── */
  const addPhase = (kind: PhaseKind) => {
    added += 1;
    setPhases((prev) => {
      const last = prev[prev.length - 1] ?? { x: 40, y: 40 };
      const base = { x: last.x + 64, y: last.y + 168, gates: 0 };
      if (kind === 'agent') {
        return [
          ...prev,
          {
            ...base,
            kind,
            name: `new_phase_${added}`,
            agent: 'reviewer',
            envelope: 'review',
            gates: 1,
            desc: 'Describe what this phase is for — a phase without a description will not save.',
          },
        ];
      }
      if (kind === 'code') {
        return [
          ...prev,
          {
            ...base,
            kind,
            name: `command_${added}`,
            command: 'lint',
            desc: 'Run a project command and record its exit status as evidence.',
          },
        ];
      }
      return [
        ...prev,
        {
          ...base,
          kind,
          name: `checkpoint_${added}`,
          desc: 'Hold the run here until a human approves, edits, or rejects.',
        },
      ];
    });
  };

  const reset = () => {
    added = 0;
    setPhases(CANVAS_PHASES.map((p) => ({ ...p })));
    setPan({ x: 0, y: 0 });
    setSelected(null);
  };

  const PILL =
    'h-7 flex-none rounded-sm border border-line px-[11px] font-mono text-[10.5px] tracking-[0.05em] text-text-dim transition-colors duration-fast ease-mech hover:bg-bg-hover hover:text-text';

  return (
    <>
      <div className="flex items-center gap-2 overflow-x-auto border-b border-line bg-bg-base px-3 py-[10px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <span className="label-sm flex-none pr-1 text-text-faint">Add</span>
        <button type="button" className={PILL} onClick={() => addPhase('agent')}>
          + Agent
        </button>
        <button type="button" className={PILL} onClick={() => addPhase('code')}>
          + Command
        </button>
        <button type="button" className={PILL} onClick={() => addPhase('engineer')}>
          + Checkpoint
        </button>
        <span className="mx-1 h-[18px] w-px flex-none bg-line" />
        <button type="button" className={PILL} onClick={reset}>
          Reset
        </button>
        <span className="ml-auto flex flex-none items-center gap-[7px] font-mono text-[10px] uppercase tracking-label text-green">
          <Dot color="currentColor" />
          {phases.length} phases
        </span>
      </div>

      <div
        ref={stageRef}
        onPointerDown={onStagePointerDown}
        className="relative h-[520px] touch-none overflow-hidden bg-bg-void active:cursor-grabbing"
        style={{
          cursor: 'grab',
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.055) 1px, transparent 0)',
          backgroundSize: '26px 26px',
          backgroundPosition: `${pan.x}px ${pan.y}px`,
        }}
      >
        <div className="absolute inset-0" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
          <svg className="pointer-events-none absolute inset-0 overflow-visible" aria-hidden="true">
            <path d={flow} fill="none" stroke="color-mix(in srgb, var(--accent) 52%, transparent)" strokeWidth={1.25} />
            <path
              d={feedback}
              fill="none"
              stroke="color-mix(in srgb, var(--amber) 45%, transparent)"
              strokeWidth={1.25}
              strokeDasharray="3 4"
            />
          </svg>

          {phases.map((p, i) => (
            <article
              key={`${p.name}-${i}`}
              data-node
              ref={(n) => {
                nodeRefs.current[i] = n;
              }}
              onPointerDown={onNodePointerDown(i)}
              className={`absolute w-[214px] select-none rounded border bg-bg-raised transition-colors duration-fast ease-mech ${
                dragging === i
                  ? 'z-[5] cursor-grabbing border-accent'
                  : selected === i
                    ? 'cursor-grab border-accent'
                    : 'cursor-grab border-line hover:border-line-strong'
              }`}
              style={{ left: p.x, top: p.y }}
            >
              <div className="flex items-center gap-[7px] px-[10px] pt-[9px]">
                <Glyph kind={p.kind} color={kindColor(p)} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">{p.name}</span>
                <span className="font-mono text-[9.5px] tracking-[0.1em] text-text-ghost">
                  STEP {String(i + 1).padStart(2, '0')}
                </span>
              </div>

              <div
                className="px-[10px] pt-[5px] font-mono text-[9.5px] font-semibold uppercase tracking-label"
                style={{ color: kindColor(p) }}
              >
                {KIND_LABEL[p.kind]}
              </div>

              <p className="line-clamp-2 px-[10px] pt-[7px] text-[11.5px] leading-[1.45] text-text-dim">
                {p.desc}
              </p>

              <div className="flex flex-wrap gap-1 px-[10px] pb-[10px] pt-[9px]">
                {p.kind === 'agent' ? (
                  <>
                    <Chip color={agentColor(p.agent)}>{p.agent}</Chip>
                    <Chip title="Envelope">{p.envelope}</Chip>
                    {p.gates ? <Chip>{p.gates === 1 ? '1 gate' : `${p.gates} gates`}</Chip> : null}
                    {p.retries ? <Chip>retries {p.retries}</Chip> : null}
                  </>
                ) : p.kind === 'code' ? (
                  <>
                    <Chip color="var(--blue)">{p.command}</Chip>
                    {p.feedbackTo ? <Chip title="Repair loop">feedback → {p.feedbackTo}</Chip> : null}
                  </>
                ) : (
                  <>
                    <Chip color="var(--amber)">human</Chip>
                    <Chip>blocks the run</Chip>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>

        <div className="pointer-events-none absolute bottom-[14px] left-[14px] z-[3] rounded-sm border border-line bg-[rgba(2,2,2,0.86)] px-[10px] py-[7px] font-mono text-[10px] uppercase tracking-label text-text-faint backdrop-blur-sm">
          Drag a card to move it · drag the grid to pan
        </div>
      </div>
    </>
  );
}

/** agent = circle, command = square, checkpoint = diamond — same as the app. */
function Glyph({ kind, color }: { kind: PhaseKind; color: string }) {
  return (
    <span
      aria-hidden="true"
      className="h-[9px] w-[9px] flex-none border"
      style={{
        color,
        borderColor: 'currentColor',
        borderRadius: kind === 'agent' ? '999px' : '1px',
        transform: kind === 'engineer' ? 'rotate(45deg)' : undefined,
      }}
    />
  );
}
