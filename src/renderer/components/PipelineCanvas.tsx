import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Layers,
  Minus,
  Plus,
  RotateCcw,
  Settings2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  PhaseDef,
  PhaseKind,
  PipelineCanvas as PipelineCanvasState,
  ValidationIssue,
} from '@shared/types.js';
import { KIND_LABEL, phaseKindColor } from '../derive.js';
import {
  commandText,
  defaultCanvasPosition,
  formatTimeout,
  gateNames,
  issuePhaseIndex,
  phaseEnvelopeChip,
} from '../pipeline-view.js';
import { EnvelopeGlyph, PhaseGlyph } from './PhaseGlyphs.js';
import styles from './PipelineCanvas.module.css';

const NODE_WIDTH = 300;
const WORK_NODE_HEIGHT = 210;
const CHECKPOINT_NODE_HEIGHT = 236;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };

type Viewport = typeof DEFAULT_VIEWPORT;

interface CanvasState {
  nodes: NonNullable<PipelineCanvasState['nodes']>;
  viewport: Viewport;
}

type Interaction =
  | {
      kind: 'pan';
      pointerId: number;
      startX: number;
      startY: number;
      viewport: Viewport;
      moved: boolean;
    }
  | {
      kind: 'node';
      pointerId: number;
      startX: number;
      startY: number;
      name: string;
      point: { x: number; y: number };
      viewport: Viewport;
      moved: boolean;
    };

function canvasState(canvas: PipelineCanvasState | undefined): CanvasState {
  return {
    nodes: { ...canvas?.nodes },
    viewport: { ...DEFAULT_VIEWPORT, ...canvas?.viewport },
  };
}

function nodeHeight(phase: PhaseDef): number {
  return phase.kind === 'engineer' ? CHECKPOINT_NODE_HEIGHT : WORK_NODE_HEIGHT;
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

function Chip({
  children,
  color,
  title,
}: {
  children: React.ReactNode;
  color?: string;
  title?: string;
}): React.JSX.Element {
  return (
    <span title={title} className={styles.chip}>
      {color && (
        <span className={styles.chipDot} style={{ background: color }} aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

function IconButton({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-canvas-control
      aria-label={label}
      title={label}
      disabled={disabled}
      className={styles.iconButton}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function NodeCard({
  phase,
  index,
  position,
  selected,
  onOpen,
  onMove,
  canMoveLater,
  onRemove,
  shouldIgnoreClick,
  agentColor,
  agentEnvelope,
  issues,
}: {
  phase: PhaseDef;
  index: number;
  position: { x: number; y: number };
  selected: boolean;
  onOpen: () => void;
  onMove: (delta: number) => void;
  canMoveLater: boolean;
  onRemove: () => void;
  shouldIgnoreClick: () => boolean;
  agentColor: (name: string | null) => string;
  agentEnvelope: (name: string | null) => string | undefined;
  issues: ValidationIssue[];
}): React.JSX.Element {
  const phaseIssues = issues.filter((issue) => issuePhaseIndex(issue.where) === index);
  const hasError = phaseIssues.some((issue) => issue.level === 'error');
  const hasWarning = phaseIssues.some((issue) => issue.level === 'warning');
  const color = phaseKindColor(phase.kind, agentColor(phase.agent ?? null));
  const envelopeChip = phaseEnvelopeChip(phase, agentEnvelope(phase.agent ?? null));
  const checkpoint = phase.kind === 'engineer';

  return (
    <article
      data-pipeline-node={phase.name}
      className={[
        styles.node,
        checkpoint ? styles.checkpointNode : '',
        selected ? styles.nodeSelected : '',
        hasError ? styles.nodeError : '',
        hasWarning && !hasError ? styles.nodeWarning : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
    >
      <span className={styles.inputPort} aria-hidden="true" />
      <span className={styles.outputPort} aria-hidden="true" />

      <button
        type="button"
        className={styles.nodeBody}
        onClick={() => {
          if (!shouldIgnoreClick()) onOpen();
        }}
      >
        <div className={styles.nodeHeading}>
          <span style={{ color }} className={styles.kindGlyph} aria-hidden="true">
            <PhaseGlyph kind={phase.kind} />
          </span>
          <span className={styles.kindLabel} style={{ color }}>
            {checkpoint ? 'Checkpoint' : KIND_LABEL[phase.kind]}
          </span>
          <span className={styles.stepNumber}>Step {String(index + 1).padStart(2, '0')}</span>
        </div>

        <p className={styles.nodeName}>{phase.name}</p>
        <p className={styles.nodeDescription}>
          {phase.description || (
            <span className={styles.missingDescription}>Description required</span>
          )}
        </p>

        {checkpoint ? (
          <div className={styles.checkpointQuestion}>
            <span>Review question</span>
            <p>{phase.question?.trim() ? `“${phase.question}”` : 'No question set yet.'}</p>
          </div>
        ) : (
          <div className={styles.nodeChips}>
            {phase.kind === 'agent' && (
              <>
                <Chip color={agentColor(phase.agent ?? null)}>{phase.agent ?? 'no agent'}</Chip>
                <Chip title={envelopeChip.title}>
                  <EnvelopeGlyph />
                  {envelopeChip.label}
                  {envelopeChip.overridden && <span className={styles.overrideMark}>ovr</span>}
                </Chip>
                {gateNames(phase).length > 0 && <Chip>{gateNames(phase).length} gates</Chip>}
              </>
            )}
            {phase.kind === 'code' && (
              <Chip color="var(--blue)">{commandText(phase) || 'no command'}</Chip>
            )}
          </div>
        )}

        {checkpoint && (
          <div className={styles.nodeChips}>
            <Chip color="var(--green)">approve</Chip>
            <Chip color="var(--red)">reject</Chip>
            <Chip>{formatTimeout(phase.timeoutMs)}</Chip>
          </div>
        )}
      </button>

      <div className={styles.nodeActions} data-canvas-control>
        <IconButton
          label={`Move ${phase.name} earlier in the run`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ChevronLeft size={13} strokeWidth={1.8} aria-hidden="true" />
        </IconButton>
        <IconButton
          label={`Move ${phase.name} later in the run`}
          disabled={!canMoveLater}
          onClick={() => onMove(1)}
        >
          <ChevronRight size={13} strokeWidth={1.8} aria-hidden="true" />
        </IconButton>
        <span className={styles.actionHint}>Execution order</span>
        {phaseIssues.length > 0 && (
          <span className={styles.issueLabel}>
            {phaseIssues.length} issue{phaseIssues.length === 1 ? '' : 's'}
          </span>
        )}
        <button
          type="button"
          data-canvas-control
          className={styles.removeButton}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
    </article>
  );
}

export default function PipelineCanvas({
  pipelineId,
  pipelines,
  selectedPipelineId,
  onSelectPipeline,
  onCreatePipeline,
  phases,
  canvas,
  selectedPhase,
  onSelectPhase,
  onAddPhase,
  onMovePhase,
  onRemovePhase,
  onCanvasChange,
  agentColor,
  agentEnvelope,
  issues,
}: {
  pipelineId: string;
  pipelines?: Array<{ id: string; name: string; phases: PhaseDef[] }>;
  selectedPipelineId?: string;
  onSelectPipeline?: (id: string) => void;
  onCreatePipeline?: () => void;
  phases: PhaseDef[];
  canvas: PipelineCanvasState | undefined;
  selectedPhase: number | null;
  onSelectPhase: (index: number) => void;
  onAddPhase: (kind: PhaseKind) => void;
  onMovePhase: (index: number, delta: number) => void;
  onRemovePhase: (index: number) => void;
  onCanvasChange: (canvas: PipelineCanvasState) => void;
  agentColor: (name: string | null) => string;
  agentEnvelope: (name: string | null) => string | undefined;
  issues: ValidationIssue[];
}): React.JSX.Element {
  const boardRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const interaction = useRef<Interaction | null>(null);
  const ignoredClick = useRef<string | null>(null);
  const [state, setState] = useState<CanvasState>(() => canvasState(canvas));
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    interaction.current = null;
    setState(canvasState(canvas));
  }, [pipelineId, canvas]);

  useEffect(() => {
    if (!pickerOpen) return;
    const handleClickOutside = (e: PointerEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    window.addEventListener('pointerdown', handleClickOutside);
    return () => window.removeEventListener('pointerdown', handleClickOutside);
  }, [pickerOpen]);

  const currentPipeline = pipelines?.find((p) => p.id === selectedPipelineId);

  const positions = useMemo(
    () =>
      phases.map((phase, index) => ({
        ...defaultCanvasPosition(index),
        ...state.nodes[phase.name],
      })),
    [phases, state.nodes],
  );

  const commit = useCallback(
    (next: CanvasState): void => {
      setState(next);
      onCanvasChange({ nodes: next.nodes, viewport: next.viewport });
    },
    [onCanvasChange],
  );

  const nextNodeState = useCallback(
    (active: Extract<Interaction, { kind: 'node' }>, event: React.PointerEvent<HTMLDivElement>) => {
      const deltaX = (event.clientX - active.startX) / active.viewport.zoom;
      const deltaY = (event.clientY - active.startY) / active.viewport.zoom;
      return {
        nodes: {
          ...state.nodes,
          [active.name]: { x: active.point.x + deltaX, y: active.point.y + deltaY },
        },
        viewport: state.viewport,
      };
    },
    [state.nodes, state.viewport],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || !boardRef.current) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('[data-canvas-control]')) return;
      const node = target?.closest<HTMLElement>('[data-pipeline-node]');
      boardRef.current.setPointerCapture(event.pointerId);

      if (node?.dataset.pipelineNode) {
        const index = phases.findIndex((phase) => phase.name === node.dataset.pipelineNode);
        if (index < 0) return;
        interaction.current = {
          kind: 'node',
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          name: node.dataset.pipelineNode,
          point: positions[index]!,
          viewport: state.viewport,
          moved: false,
        };
        return;
      }

      interaction.current = {
        kind: 'pan',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewport: state.viewport,
        moved: false,
      };
    },
    [phases, positions, state.viewport],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const active = interaction.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const moved = Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 3;
      active.moved ||= moved;
      if (active.kind === 'node') {
        setState(nextNodeState(active, event));
        return;
      }
      setState((current) => ({
        ...current,
        viewport: {
          ...active.viewport,
          x: active.viewport.x + event.clientX - active.startX,
          y: active.viewport.y + event.clientY - active.startY,
        },
      }));
    },
    [nextNodeState],
  );

  const finishInteraction = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const active = interaction.current;
      if (!active || active.pointerId !== event.pointerId) return;
      interaction.current = null;
      if (!active.moved) return;

      if (active.kind === 'node') {
        ignoredClick.current = active.name;
        commit(nextNodeState(active, event));
        return;
      }
      commit({
        nodes: state.nodes,
        viewport: {
          ...active.viewport,
          x: active.viewport.x + event.clientX - active.startX,
          y: active.viewport.y + event.clientY - active.startY,
        },
      });
    },
    [commit, nextNodeState, state.nodes],
  );

  const zoomAt = useCallback(
    (nextZoom: number, clientX?: number, clientY?: number): void => {
      const rect = boardRef.current?.getBoundingClientRect();
      if (!rect) return;
      const zoom = clampZoom(nextZoom);
      const x = clientX == null ? rect.width / 2 : clientX - rect.left;
      const y = clientY == null ? rect.height / 2 : clientY - rect.top;
      const worldX = (x - state.viewport.x) / state.viewport.zoom;
      const worldY = (y - state.viewport.y) / state.viewport.zoom;
      commit({
        nodes: state.nodes,
        viewport: { x: x - worldX * zoom, y: y - worldY * zoom, zoom },
      });
    },
    [commit, state.nodes, state.viewport],
  );

  const latestRef = useRef({ state, commit, zoomAt });
  useEffect(() => {
    latestRef.current = { state, commit, zoomAt };
  });

  const isEmpty = phases.length === 0;

  useEffect(() => {
    const element = boardRef.current;
    if (!element) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { state: current, commit: doCommit, zoomAt: doZoom } = latestRef.current;
      if (event.ctrlKey || event.metaKey) {
        doZoom(
          current.viewport.zoom * Math.exp(-event.deltaY * 0.002),
          event.clientX,
          event.clientY,
        );
        return;
      }
      doCommit({
        nodes: current.nodes,
        viewport: {
          ...current.viewport,
          x: current.viewport.x - event.deltaX,
          y: current.viewport.y - event.deltaY,
        },
      });
    };

    const handleGesture = (event: Event) => {
      event.preventDefault();
    };

    element.addEventListener('wheel', handleWheel, { passive: false });
    element.addEventListener('gesturestart', handleGesture, { passive: false });
    element.addEventListener('gesturechange', handleGesture, { passive: false });

    return () => {
      element.removeEventListener('wheel', handleWheel);
      element.removeEventListener('gesturestart', handleGesture);
      element.removeEventListener('gesturechange', handleGesture);
    };
  }, [isEmpty]);

  const shouldIgnoreClick = useCallback((name: string): boolean => {
    if (ignoredClick.current !== name) return false;
    ignoredClick.current = null;
    return true;
  }, []);

  if (phases.length === 0) {
    return (
      <div className={styles.emptyCanvas}>
        <div className={styles.emptyCard}>
          <span className={styles.emptyEyebrow}>Blank pipeline</span>
          <h2>Put the first action on the board.</h2>
          <p>Actions connect in their execution order. Move any card wherever it makes sense.</p>
          <div className={styles.emptyActions}>
            <button type="button" onClick={() => onAddPhase('agent')}>
              <PhaseGlyph kind="agent" /> Add action
            </button>
            <button type="button" onClick={() => onAddPhase('code')}>
              <PhaseGlyph kind="code" /> Add command
            </button>
            <button type="button" onClick={() => onAddPhase('engineer')}>
              <PhaseGlyph kind="engineer" /> Add checkpoint
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={boardRef}
      className={styles.canvas}
      aria-label="Pipeline canvas. Drag cards to position them. Drag empty space to pan."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finishInteraction}
      onPointerCancel={finishInteraction}
    >
      <div
        className={styles.grid}
        aria-hidden="true"
        style={{
          backgroundPosition: `${state.viewport.x}px ${state.viewport.y}px`,
          backgroundSize: `${24 * state.viewport.zoom}px ${24 * state.viewport.zoom}px`,
        }}
      />
      <div
        className={styles.world}
        style={{
          transform: `translate(${state.viewport.x}px, ${state.viewport.y}px) scale(${state.viewport.zoom})`,
        }}
      >
        <svg className={styles.edgeLayer} aria-hidden="true">
          <defs>
            <marker
              id="pipeline-arrow"
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
            const source = positions[index]!;
            const target = positions[index + 1]!;
            const sourceX = source.x + NODE_WIDTH;
            const sourceY = source.y + nodeHeight(phase) / 2;
            const targetX = target.x;
            const targetY = target.y + nodeHeight(phases[index + 1]!) / 2;
            const bend = Math.max(76, Math.min(180, Math.abs(targetX - sourceX) * 0.42));
            return (
              <path
                key={`${phase.name}-${phases[index + 1]!.name}`}
                d={`M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY}, ${targetX - bend} ${targetY}, ${targetX} ${targetY}`}
                className={styles.edge}
                markerEnd="url(#pipeline-arrow)"
              />
            );
          })}
        </svg>

        {phases.map((phase, index) => (
          <NodeCard
            key={phase.name}
            phase={phase}
            index={index}
            position={positions[index]!}
            selected={selectedPhase === index}
            onOpen={() => onSelectPhase(index)}
            onMove={(delta) => onMovePhase(index, delta)}
            canMoveLater={index < phases.length - 1}
            onRemove={() => onRemovePhase(index)}
            shouldIgnoreClick={() => shouldIgnoreClick(phase.name)}
            agentColor={agentColor}
            agentEnvelope={agentEnvelope}
            issues={issues}
          />
        ))}
      </div>

      <div className={styles.canvasHint} aria-hidden="true">
        <span>Drag cards to place</span>
        <span>·</span>
        <span>Drag canvas to pan</span>
        <span>·</span>
        <span>⌘/Ctrl + scroll to zoom</span>
      </div>

      <div className={styles.viewportControls} data-canvas-control>
        <IconButton label="Zoom out" onClick={() => zoomAt(state.viewport.zoom / 1.2)}>
          <ZoomOut size={14} strokeWidth={1.7} aria-hidden="true" />
        </IconButton>
        <button
          type="button"
          data-canvas-control
          className={styles.zoomReadout}
          title="Reset pan and zoom"
          onClick={() => commit({ nodes: state.nodes, viewport: DEFAULT_VIEWPORT })}
        >
          {Math.round(state.viewport.zoom * 100)}%
        </button>
        <IconButton label="Zoom in" onClick={() => zoomAt(state.viewport.zoom * 1.2)}>
          <ZoomIn size={14} strokeWidth={1.7} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Reset pan and zoom"
          onClick={() => commit({ nodes: state.nodes, viewport: DEFAULT_VIEWPORT })}
        >
          <RotateCcw size={13} strokeWidth={1.7} aria-hidden="true" />
        </IconButton>
      </div>

      <div className={styles.topControls} data-canvas-control>
        {pipelines && pipelines.length > 0 && onSelectPipeline && (
          <div ref={pickerRef} className={styles.pipelinePicker}>
            <button
              type="button"
              className={styles.pipelinePickerTrigger}
              onClick={() => setPickerOpen(!pickerOpen)}
              aria-expanded={pickerOpen}
              aria-haspopup="listbox"
              aria-label="Select pipeline"
            >
              <Layers size={13} strokeWidth={1.7} aria-hidden="true" />
              <span className={styles.pipelinePickerName}>
                {currentPipeline?.name ?? 'Pipeline'}
              </span>
              <span className={styles.pipelinePickerCount}>
                {currentPipeline?.phases.length ?? 0}
              </span>
              <ChevronDown size={12} strokeWidth={1.7} aria-hidden="true" />
            </button>

            {pickerOpen && (
              <div className={styles.pipelinePickerDropdown} role="listbox" aria-label="Pipelines">
                <div className={styles.pipelinePickerList}>
                  {pipelines.map((p) => {
                    const active = p.id === selectedPipelineId;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className={`${styles.pipelineOption} ${active ? styles.pipelineOptionActive : ''}`}
                        onClick={() => {
                          setPickerOpen(false);
                          onSelectPipeline(p.id);
                        }}
                      >
                        <span className={styles.pipelineOptionName}>{p.name}</span>
                        <span className={styles.pipelineOptionCount}>{p.phases.length} phases</span>
                        {active && <Check size={12} strokeWidth={2} className={styles.checkIcon} />}
                      </button>
                    );
                  })}
                </div>
                {onCreatePipeline && (
                  <button
                    type="button"
                    className={styles.pipelinePickerNew}
                    onClick={() => {
                      setPickerOpen(false);
                      onCreatePipeline();
                    }}
                  >
                    <Plus size={13} strokeWidth={1.7} aria-hidden="true" />
                    <span>New pipeline</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className={styles.addMenu}>
          <span className={styles.addMenuLabel}>Add</span>
          <button type="button" onClick={() => onAddPhase('agent')}>
            <Plus size={13} strokeWidth={1.8} aria-hidden="true" /> Action
          </button>
          <button type="button" onClick={() => onAddPhase('code')}>
            <Settings2 size={13} strokeWidth={1.8} aria-hidden="true" /> Command
          </button>
          <button type="button" onClick={() => onAddPhase('engineer')}>
            <Minus size={13} strokeWidth={1.8} aria-hidden="true" /> Checkpoint
          </button>
        </div>
      </div>
    </div>
  );
}
