import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, RotateCcw, ZoomIn, ZoomOut } from 'lucide-react';
import { modelLabel } from '@shared/model-label.js';
import { KIND_LABEL, phaseKindColor } from '../../utils/derive.js';
import { planPreviewPositions, type PlanPhaseView } from '../../view-models/plan-view.js';
import { PhaseGlyph } from '../pipeline/PhaseGlyphs.js';
import { cx } from '../ui/cx.js';
import styles from './PlanCanvas.module.css';

const NODE_WIDTH = 300;
const NODE_HEIGHT = 190;
const FRAME_PAD = 28;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
/** How far below the rail a feedback arc dips, matching the edge geometry. */
const RETURN_EDGE_DIP = 72;
/** Operator-resized board bounds; the default clamp stays in the CSS. */
const MIN_BOARD_HEIGHT = 200;
const MAX_BOARD_HEIGHT = 900;

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Pan/zoom that shows the whole rail, centered, never magnified past 1:1. */
function fitViewport(
  rect: { width: number; height: number },
  count: number,
  hasReturns: boolean,
): Viewport {
  const positions = planPreviewPositions(count);
  const contentW = (positions[count - 1]?.x ?? 0) + NODE_WIDTH;
  // Return arcs swing below the rail, so a plan with feedback frames them in.
  const contentH = NODE_HEIGHT + (hasReturns ? RETURN_EDGE_DIP : 0);
  const zoom = clampZoom(
    Math.min(1, (rect.width - FRAME_PAD * 2) / contentW, (rect.height - FRAME_PAD * 2) / contentH),
  );
  return {
    x: (rect.width - contentW * zoom) / 2,
    y: (rect.height - (NODE_HEIGHT + (hasReturns ? RETURN_EDGE_DIP : 0)) * zoom) / 2,
    zoom,
  };
}

function Chip({
  children,
  color,
  tone,
  title,
}: {
  children: React.ReactNode;
  color?: string;
  tone?: 'override' | 'decides';
  title?: string;
}): React.JSX.Element {
  return (
    <span
      title={title}
      className={cx(
        styles.chip,
        tone === 'override' && styles.chipOverride,
        tone === 'decides' && styles.chipDecides,
      )}
    >
      {color && (
        <span className={styles.chipDot} style={{ background: color }} aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

function PlanNode({
  phase,
  position,
  selected,
  overridden,
  color,
  onOpen,
  onFocusSibling,
}: {
  phase: PlanPhaseView;
  position: { x: number; y: number };
  selected: boolean;
  overridden: boolean;
  color: string;
  onOpen: () => void;
  onFocusSibling: (delta: number) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-plan-node={phase.name}
      data-testid={`plan-canvas-node-${phase.name}`}
      aria-haspopup="dialog"
      aria-label={`Inspect phase ${phase.name}`}
      className={cx(styles.node, selected && styles.nodeSelected)}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          onFocusSibling(event.key === 'ArrowRight' ? 1 : -1);
        }
      }}
    >
      <span className={styles.inputPort} aria-hidden="true" />
      <span className={styles.outputPort} aria-hidden="true" />
      <span className={styles.nodeHeading}>
        <span style={{ color }} className={styles.kindGlyph} aria-hidden="true">
          <PhaseGlyph kind={phase.kind} />
        </span>
        <span className={styles.kindLabel} style={{ color }}>
          {KIND_LABEL[phase.kind]}
        </span>
        <span className={styles.stepNumber}>Step {String(phase.index + 1).padStart(2, '0')}</span>
      </span>
      <span className={styles.nodeName}>{phase.name}</span>
      <span className={styles.nodeDescription}>{phase.description}</span>
      <span className={styles.nodeChips}>
        {phase.agent && (
          <Chip color={color} title={phase.synthesized ? 'Synthesized for this run' : undefined}>
            {phase.agent}
          </Chip>
        )}
        {phase.model !== null && (
          <Chip tone={overridden ? 'override' : undefined} title="Model · reasoning">
            {modelLabel(phase.model)} · {phase.reasoningEffort}
            {overridden && <span className={styles.overrideMark}>ovr</span>}
          </Chip>
        )}
        {phase.command !== null && <Chip color="var(--blue)">{phase.command}</Chip>}
        {phase.gates.length > 0 && (
          <Chip title={phase.gates.join(', ')}>
            {phase.gates.length} {phase.gates.length === 1 ? 'check' : 'checks'}
          </Chip>
        )}
        {phase.decides && (
          <Chip tone="decides" title="The acceptance rule reads this phase's outcome">
            decides
          </Chip>
        )}
      </span>
    </button>
  );
}

/**
 * The proposal's pipeline as an inspectable board: the same node-and-edge
 * vocabulary as the Pipelines canvas, stripped of every editing affordance.
 * Positions are deterministic and throwaway — nothing here reads or writes
 * the saved canvas layout, because the plan is not a stored pipeline yet.
 */
export default function PlanCanvas({
  phases,
  overridden,
  selectedPhase,
  onInspect,
  agentColor,
  expanded = false,
  onToggleExpand,
}: {
  phases: PlanPhaseView[];
  /** Names of phases the operator re-cast, marked on their nodes. */
  overridden: ReadonlySet<string>;
  /** The phase open in the inspector, or null. */
  selectedPhase: string | null;
  onInspect: (name: string) => void;
  agentColor: (name: string | null) => string;
  /** Filling a full-screen surface: no drag-to-resize, exit control instead. */
  expanded?: boolean;
  /** Enters or leaves the full-screen view; absent hides the control. */
  onToggleExpand?: () => void;
}): React.JSX.Element {
  const boardRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  /** Operator-chosen board height; null keeps the default CSS clamp. */
  const [boardHeight, setBoardHeight] = useState<number | null>(null);
  const resize = useRef<{ pointerId: number; startY: number; fromHeight: number } | null>(null);
  /** Once the operator pans or zooms, resizes stop re-framing under them. */
  const userMoved = useRef(false);
  const pan = useRef<{ pointerId: number; startX: number; startY: number; from: Viewport } | null>(
    null,
  );
  const positions = planPreviewPositions(phases.length);
  const returns = phases.flatMap((phase) => {
    if (!phase.feedbackTo) return [];
    const target = phases.findIndex((candidate) => candidate.name === phase.feedbackTo);
    return target >= 0 ? [{ from: phase.index, to: target }] : [];
  });
  const hasReturns = returns.length > 0;

  const frame = useCallback((): void => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect || phases.length === 0) return;
    setViewport(fitViewport(rect, phases.length, hasReturns));
  }, [phases.length, hasReturns]);

  useLayoutEffect(() => {
    // A structurally different plan reclaims the framing. Overrides keep the
    // operator's pan/zoom: they change casting, not the board's shape.
    userMoved.current = false;
    frame();
  }, [frame]);

  useEffect(() => {
    const element = boardRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (!userMoved.current) frame();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame]);

  const zoomAt = useCallback((nextZoom: number, clientX?: number, clientY?: number): void => {
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    userMoved.current = true;
    setViewport((current) => {
      const zoom = clampZoom(nextZoom);
      const x = clientX == null ? rect.width / 2 : clientX - rect.left;
      const y = clientY == null ? rect.height / 2 : clientY - rect.top;
      const worldX = (x - current.x) / current.zoom;
      const worldY = (y - current.y) / current.zoom;
      return { x: x - worldX * zoom, y: y - worldY * zoom, zoom };
    });
  }, []);

  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  });

  useEffect(() => {
    const element = boardRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent): void => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-canvas-control]')) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(
          viewportRef.current.zoom * Math.exp(-event.deltaY * 0.002),
          event.clientX,
          event.clientY,
        );
        return;
      }
      userMoved.current = true;
      setViewport((current) => ({
        ...current,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      }));
    };
    const swallowGesture = (event: Event): void => event.preventDefault();
    element.addEventListener('wheel', handleWheel, { passive: false });
    element.addEventListener('gesturestart', swallowGesture, { passive: false });
    element.addEventListener('gesturechange', swallowGesture, { passive: false });
    return () => {
      element.removeEventListener('wheel', handleWheel);
      element.removeEventListener('gesturestart', swallowGesture);
      element.removeEventListener('gesturechange', swallowGesture);
    };
  }, [zoomAt]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || !boardRef.current) return;
    // Element, not HTMLElement: a press on a control's SVG icon must not fall
    // through to the pan capture, which would swallow the button's click.
    const target = event.target instanceof Element ? event.target : null;
    // Nodes are plain buttons here — no drag-to-place on a read-only board —
    // so a gesture that starts on one is a click, not a pan.
    if (target?.closest('[data-canvas-control]') || target?.closest('[data-plan-node]')) return;
    boardRef.current.setPointerCapture(event.pointerId);
    pan.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: viewport,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = pan.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - active.startX;
    const deltaY = event.clientY - active.startY;
    if (Math.hypot(deltaX, deltaY) > 3) userMoved.current = true;
    setViewport({ ...active.from, x: active.from.x + deltaX, y: active.from.y + deltaY });
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (pan.current?.pointerId === event.pointerId) pan.current = null;
  };

  const focusSibling = (index: number, delta: number): void => {
    const next = phases[index + delta];
    if (!next) return;
    boardRef.current
      ?.querySelector<HTMLElement>(`[data-plan-node="${CSS.escape(next.name)}"]`)
      ?.focus();
  };

  const resetView = (): void => {
    userMoved.current = false;
    frame();
  };

  const onResizeStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    resize.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      fromHeight: boardRef.current?.getBoundingClientRect().height ?? MIN_BOARD_HEIGHT,
    };
  };

  const onResizeMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const active = resize.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const next = active.fromHeight + (event.clientY - active.startY);
    setBoardHeight(Math.min(MAX_BOARD_HEIGHT, Math.max(MIN_BOARD_HEIGHT, next)));
  };

  const onResizeEnd = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (resize.current?.pointerId === event.pointerId) resize.current = null;
  };

  return (
    <div
      ref={boardRef}
      className={cx(styles.canvas, expanded && styles.canvasExpanded)}
      style={boardHeight !== null && !expanded ? { height: boardHeight } : undefined}
      data-testid="plan-canvas"
      role="group"
      aria-label="Proposed pipeline. Click a phase to inspect it. Drag empty space to pan."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div
        className={styles.grid}
        aria-hidden="true"
        style={{
          backgroundPosition: `${viewport.x}px ${viewport.y}px`,
          backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
        }}
      />
      <div
        className={styles.world}
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        }}
      >
        <svg className={styles.edgeLayer} aria-hidden="true">
          <defs>
            <marker
              id="plan-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrowHead} />
            </marker>
          </defs>
          {phases.slice(0, -1).map((phase, index) => {
            const sourceX = positions[index]!.x + NODE_WIDTH;
            const targetX = positions[index + 1]!.x;
            const y = NODE_HEIGHT / 2;
            const bend = Math.max(60, Math.min(150, (targetX - sourceX) * 0.5));
            return (
              <path
                key={`edge-${phase.name}`}
                d={`M ${sourceX} ${y} C ${sourceX + bend} ${y}, ${targetX - bend} ${y}, ${targetX} ${y}`}
                className={styles.edge}
                markerEnd="url(#plan-arrow)"
              />
            );
          })}
          {returns.map(({ from, to }) => {
            const sourceX = positions[from]!.x + NODE_WIDTH / 2;
            const targetX = positions[to]!.x + NODE_WIDTH / 2;
            const y = NODE_HEIGHT;
            // Longer loops dip deeper, capped inside the framed band below the rail.
            const dip = y + Math.min(RETURN_EDGE_DIP - 8, 48 + (from - to) * 8);
            return (
              <path
                key={`return-${from}-${to}`}
                d={`M ${sourceX} ${y} C ${sourceX} ${dip}, ${targetX} ${dip}, ${targetX} ${y + 4}`}
                className={styles.returnEdge}
                markerEnd="url(#plan-arrow)"
              />
            );
          })}
        </svg>

        {phases.map((phase) => (
          <PlanNode
            key={phase.name}
            phase={phase}
            position={positions[phase.index]!}
            selected={selectedPhase === phase.name}
            overridden={overridden.has(phase.name)}
            color={phaseKindColor(phase.kind, agentColor(phase.agent))}
            onOpen={() => onInspect(phase.name)}
            onFocusSibling={(delta) => focusSibling(phase.index, delta)}
          />
        ))}
      </div>

      <div className={styles.canvasHint} aria-hidden="true">
        <span>Click a phase to inspect</span>
        <span>·</span>
        <span>Drag to pan</span>
        <span>·</span>
        <span>⌘/Ctrl + scroll to zoom</span>
      </div>

      <div className={styles.viewportControls} data-canvas-control>
        <button
          type="button"
          aria-label="Zoom out"
          title="Zoom out"
          className={styles.iconButton}
          onClick={() => zoomAt(viewport.zoom / 1.2)}
        >
          <ZoomOut size={14} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={styles.zoomReadout}
          title="Fit the pipeline in view"
          onClick={resetView}
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          title="Zoom in"
          className={styles.iconButton}
          onClick={() => zoomAt(viewport.zoom * 1.2)}
        >
          <ZoomIn size={14} strokeWidth={1.7} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Fit the pipeline in view"
          title="Fit the pipeline in view"
          className={styles.iconButton}
          onClick={resetView}
        >
          <RotateCcw size={13} strokeWidth={1.7} aria-hidden="true" />
        </button>
        {onToggleExpand && (
          <button
            type="button"
            aria-label={expanded ? 'Exit full screen' : 'View full screen'}
            title={expanded ? 'Exit full screen (Esc)' : 'View full screen'}
            className={styles.iconButton}
            onClick={onToggleExpand}
            data-testid="plan-canvas-expand"
          >
            {expanded ? (
              <Minimize2 size={13} strokeWidth={1.7} aria-hidden="true" />
            ) : (
              <Maximize2 size={13} strokeWidth={1.7} aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      {!expanded && (
        <div
          className={styles.resizeHandle}
          data-canvas-control
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the pipeline board"
          title="Drag to resize"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          onPointerCancel={onResizeEnd}
        />
      )}
    </div>
  );
}
