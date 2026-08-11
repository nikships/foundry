import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  defaultDropAnimationSideEffects,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from '@dnd-kit/core';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  GripVertical,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { PhaseDef, PhaseKind, ValidationIssue } from '@shared/types.js';
import { KIND_LABEL, phaseKindColor } from '../derive.js';
import { useSettleLayout } from '../hooks/useSettleLayout.js';
import {
  commandText,
  dropRailId,
  dropSlotId,
  formatTimeout,
  gateNames,
  issuePhaseIndex,
  newStagePlan,
  parseDropId,
  phaseDragIds,
  reorderTarget,
  stageLabel,
  stageMoveTarget,
  stageSlots,
  stagesOf,
  type Stage,
} from '../pipeline-view.js';
import { EnvelopeGlyph, PhaseGlyph } from './PhaseGlyphs.js';
import { Button } from './ui/Button.js';
import styles from './StageBoard.module.css';

/**
 * A rail is a deliberate target: it only wins when the pointer is inside it, so
 * a drag that drifts through the gap between columns still reorders instead of
 * silently splitting the run into a new stage. Insertion slots are hairlines,
 * so they get the generous rule and claim the nearest one to the dragged card.
 */
const boardCollision: CollisionDetection = (args) => {
  const rail = pointerWithin(args).find((c) => String(c.id).startsWith('rail:'));
  if (rail) return [rail];
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((c) => !String(c.id).startsWith('rail:')),
  });
};

/**
 * The card falls to the place it was dropped rather than vanishing from under
 * the pointer.
 *
 * The reorder is committed before this runs, so the node behind the overlay is
 * already at its new position and dnd-kit animates towards it. The real card
 * stays invisible until the overlay arrives, so only one card is ever visible.
 */
const DROP_MS = 260;
const dropAnimation: DropAnimation = {
  duration: DROP_MS,
  // A slight overshoot on landing; nothing in the run reads as weightless.
  easing: 'cubic-bezier(0.2, 1.2, 0.3, 1)',
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: '0' } } }),
};

/** A square icon button in a card toolbar. */
function ToolBtn({
  label,
  Icon,
  disabled,
  danger,
  className,
  onClick,
}: {
  label: string;
  Icon: LucideIcon;
  disabled?: boolean;
  danger?: boolean;
  className?: string;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={[styles.toolBtn, danger ? styles.removeToolBtn : '', className]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
    >
      <Icon size={12} strokeWidth={1.6} aria-hidden="true" />
    </button>
  );
}

/** A small metadata chip, optionally led by a colour swatch. */
function Chip({
  children,
  color,
  title,
  className,
}: {
  children: React.ReactNode;
  color?: string;
  title?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span title={title} className={[styles.chip, className].filter(Boolean).join(' ')}>
      {color && (
        <span className={styles.chipDot} style={{ background: color }} aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

/**
 * A hairline between two cards: where a dropped phase lands in the run order.
 *
 * Slots that would not move the dragged phase are disabled rather than hidden,
 * so the column keeps the same geometry through the whole drag.
 */
function DropSlot({
  at,
  disabled,
  active,
}: {
  at: number;
  disabled: boolean;
  active: boolean;
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: dropSlotId(at), disabled });
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className={[
        styles.dropSlot,
        active ? styles.dropSlotArmed : '',
        isOver ? styles.dropSlotOver : '',
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

/** The gutter between two stages: a drop here gives the phase its own stage. */
function NewStageRail({
  boundary,
  dragging,
  enabled,
}: {
  boundary: number;
  dragging: boolean;
  enabled: boolean;
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: dropRailId(boundary), disabled: !enabled });
  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className={[
        styles.newStageRail,
        dragging ? styles.newStageRailArmed : '',
        enabled && isOver ? styles.newStageRailOver : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {dragging && enabled && <span className={styles.newStageRailLabel}>New stage</span>}
    </div>
  );
}

export default function StageBoard({
  phases,
  selectedPhase,
  onSelectPhase,
  onAddPhase,
  onMovePhase,
  onReorderPhase,
  onNewStagePhase,
  onRemovePhase,
  agentColor,
  issues,
}: {
  phases: PhaseDef[];
  selectedPhase: number | null;
  onSelectPhase: (index: number) => void;
  onAddPhase: (kind: PhaseKind, at?: number) => void;
  onMovePhase: (index: number, delta: number) => void;
  onReorderPhase: (from: number, to: number) => void;
  onNewStagePhase: (from: number, boundary: number) => void;
  onRemovePhase: (index: number) => void;
  agentColor: (name: string | null) => string;
  issues: ValidationIssue[];
}): React.JSX.Element {
  const stages = stagesOf(phases);
  const dragIds = useMemo(() => phaseDragIds(phases), [phases]);
  const [dragging, setDragging] = useState<number | null>(null);
  // The id of the card the overlay is currently falling onto. It has to be
  // exempt from the settle pass, or it would be animated from its old position
  // at the same time as the overlay flies to its new one.
  const [landing, setLanding] = useState<string | null>(null);
  const landingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // A drag ends with a pointerup over the card, which the browser also reports
  // as a click; without this the phase sheet opens on top of every drop.
  const dragged = useRef(false);

  useSettleLayout(trackRef, dragIds.join('\u0000'), landing);

  const sensors = useSensors(
    // A card is a button first: a drag only begins once the pointer travels far
    // enough that the press was not a click meant to open the phase sheet.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      dragged.current = true;
      if (landingTimer.current) clearTimeout(landingTimer.current);
      setLanding(null);
      setDragging(dragIds.indexOf(String(event.active.id)));
    },
    [dragIds],
  );

  const onDragCancel = useCallback(() => setDragging(null), []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const from = dragIds.indexOf(String(event.active.id));
      const target = event.over ? parseDropId(event.over.id) : null;
      setDragging(null);
      if (from < 0 || !target) return;

      // Commit before the overlay animates: the drop animation reads where the
      // card ended up, so the edit has to already be in the tree.
      if (target.kind === 'rail') {
        onNewStagePhase(from, target.boundary);
      } else {
        const to = reorderTarget(from, target.at);
        if (to === null) return;
        onReorderPhase(from, to);
      }

      setLanding(String(event.active.id));
      landingTimer.current = setTimeout(() => setLanding(null), DROP_MS);
    },
    [dragIds, onNewStagePhase, onReorderPhase],
  );

  // A checkpoint is a stage boundary, so it has no stage of its own to be given.
  const railsEnabled = dragging !== null && phases[dragging]?.kind !== 'engineer';

  const onCardSelect = useCallback(
    (index: number) => {
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      onSelectPhase(index);
    },
    [onSelectPhase],
  );

  if (phases.length === 0) {
    return (
      <div className={styles.emptyBoard}>
        <div className={styles.emptyCard}>
          <h3 className={styles.emptyTitle}>No stages yet</h3>
          <p className={styles.emptyDetail}>
            A stage is whatever runs unattended between two checkpoints. Add the work first; the
            board groups it as soon as a checkpoint closes it.
          </p>
          <div className={styles.emptyActions}>
            <Button size="sm" onClick={() => onAddPhase('agent')}>
              <PhaseGlyph kind="agent" /> Agent
            </Button>
            <Button size="sm" onClick={() => onAddPhase('code')}>
              <PhaseGlyph kind="code" /> Command
            </Button>
            <Button size="sm" onClick={() => onAddPhase('engineer')}>
              <PhaseGlyph kind="engineer" /> Checkpoint
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const carried = dragging !== null ? phases[dragging] : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollision}
      // Rails and slots appear and resize when a drag starts, so a rect
      // measured once at drag start would be the wrong one.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className={styles.boardContainer}>
        <div ref={trackRef} className={styles.boardTrack}>
          <NewStageRail
            boundary={0}
            dragging={dragging !== null}
            enabled={railsEnabled && newStagePlan(phases, dragging ?? -1, 0) !== null}
          />
          {stages.map((stage, stageIdx) => {
            const boundary = stage.gate ?? phases.length;
            return (
              <Fragment key={`stage-${stage.index}`}>
                <StageColumn
                  stage={stage}
                  totalStages={stages.length}
                  phases={phases}
                  dragIds={dragIds}
                  selectedPhase={selectedPhase}
                  dragging={dragging}
                  onSelectPhase={onCardSelect}
                  onAddPhase={onAddPhase}
                  onMovePhase={onMovePhase}
                  onReorderPhase={onReorderPhase}
                  onRemovePhase={onRemovePhase}
                  agentColor={agentColor}
                  issues={issues}
                />
                <GateSlot
                  stage={stage}
                  phases={phases}
                  dragIds={dragIds}
                  selectedPhase={selectedPhase}
                  dragging={dragging}
                  onSelectPhase={onCardSelect}
                  onAddPhase={onAddPhase}
                  onMovePhase={onMovePhase}
                  onRemovePhase={onRemovePhase}
                  isLast={stageIdx === stages.length - 1}
                  issues={issues}
                />
                <NewStageRail
                  boundary={boundary}
                  dragging={dragging !== null}
                  enabled={railsEnabled && newStagePlan(phases, dragging ?? -1, boundary) !== null}
                />
              </Fragment>
            );
          })}
        </div>
      </div>

      {/* The carried card is the card, at full size: a drag lifts a phase off
          the board, it does not swap it for a token. */}
      <DragOverlay dropAnimation={dropAnimation} className={styles.dragLayer}>
        {carried && dragging !== null && (
          <div
            className={
              carried.kind === 'engineer'
                ? `${styles.checkpointCard} ${styles.cardCarried}`
                : `${styles.phaseCard} ${styles.cardCarried}`
            }
          >
            <GripRow />
            {carried.kind === 'engineer' ? (
              <CheckpointBody phase={carried} index={dragging} />
            ) : (
              <PhaseBody phase={carried} index={dragging} agentColor={agentColor} issues={issues} />
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

function StageColumn({
  stage,
  totalStages,
  phases,
  dragIds,
  selectedPhase,
  dragging,
  onSelectPhase,
  onAddPhase,
  onMovePhase,
  onReorderPhase,
  onRemovePhase,
  agentColor,
  issues,
}: {
  stage: Stage;
  totalStages: number;
  phases: PhaseDef[];
  dragIds: string[];
  selectedPhase: number | null;
  dragging: number | null;
  onSelectPhase: (index: number) => void;
  onAddPhase: (kind: PhaseKind, at?: number) => void;
  onMovePhase: (index: number, delta: number) => void;
  onReorderPhase: (from: number, to: number) => void;
  onRemovePhase: (index: number) => void;
  agentColor: (name: string | null) => string;
  issues: ValidationIssue[];
}): React.JSX.Element {
  const insertIndex = stage.gate !== null ? stage.gate : stage.end;
  const slots = stageSlots(stage);

  const slotAt = (at: number): React.JSX.Element => (
    <DropSlot
      key={`slot-${at}`}
      at={at}
      active={dragging !== null}
      disabled={dragging === null || reorderTarget(dragging, at) === null}
    />
  );

  return (
    <section className={styles.stageColumn} aria-label={stageLabel(stage, totalStages)}>
      <header className={styles.columnHeader}>
        <span className={styles.columnEyebrow}>
          Stage <span className={styles.accentNum}>{String(stage.index + 1).padStart(2, '0')}</span>
        </span>
        <span className={styles.columnCount}>
          {stage.members.length ? `${stage.members.length} unattended` : 'empty'}
        </span>
      </header>

      <div className={styles.cardList}>
        {slotAt(slots[0]!)}
        {stage.members.length > 0 ? (
          stage.members.map((phaseIdx, i) => {
            const phase = phases[phaseIdx];
            if (!phase) return null;
            return (
              <Fragment key={dragIds[phaseIdx]}>
                <PhaseCard
                  phase={phase}
                  index={phaseIdx}
                  dragId={dragIds[phaseIdx]!}
                  phases={phases}
                  selected={selectedPhase === phaseIdx}
                  dragging={dragging === phaseIdx}
                  onSelect={() => onSelectPhase(phaseIdx)}
                  onMovePhase={onMovePhase}
                  onReorderPhase={onReorderPhase}
                  onRemove={() => onRemovePhase(phaseIdx)}
                  agentColor={agentColor}
                  issues={issues}
                />
                {slotAt(slots[i + 1]!)}
              </Fragment>
            );
          })
        ) : (
          <div className={styles.emptyStagePlaceholder}>Nothing runs unattended here yet.</div>
        )}
      </div>

      <footer className={styles.columnFooter}>
        <span className={styles.footerAddLabel}>Add</span>
        <button
          type="button"
          className={styles.addGhostBtn}
          onClick={() => onAddPhase('agent', insertIndex)}
        >
          <PhaseGlyph kind="agent" /> Agent
        </button>
        <button
          type="button"
          className={styles.addGhostBtn}
          onClick={() => onAddPhase('code', insertIndex)}
        >
          <PhaseGlyph kind="code" /> Command
        </button>
      </footer>
    </section>
  );
}

/**
 * The grip: a hint that the card moves, not the only place it moves from.
 *
 * The whole card is the drag handle, so this carries no listeners of its own.
 */
function GripRow(): React.JSX.Element {
  return (
    <div className={styles.cardGripRow} aria-hidden="true">
      <GripVertical size={12} strokeWidth={1.6} />
    </div>
  );
}

/** The visible contents of a work card, identical on the board and in hand. */
function PhaseBody({
  phase,
  index,
  agentColor,
  issues,
}: {
  phase: PhaseDef;
  index: number;
  agentColor: (name: string | null) => string;
  issues: ValidationIssue[];
}): React.JSX.Element {
  const color = phaseKindColor(phase.kind, agentColor(phase.agent ?? null));
  const gates = gateNames(phase);
  const phaseIssues = issues.filter((i) => issuePhaseIndex(i.where) === index);
  const hasError = phaseIssues.some((i) => i.level === 'error');
  const hasWarning = phaseIssues.some((i) => i.level === 'warning');

  return (
    <>
      <div className={styles.cardHeaderRow}>
        <span style={{ color }} className={styles.kindGlyphWrap} aria-hidden="true">
          <PhaseGlyph kind={phase.kind} />
        </span>
        <span className={styles.phaseName}>{phase.name}</span>
        <span className={styles.phaseIndex}>{String(index + 1).padStart(2, '0')}</span>
      </div>

      <div className={styles.cardSubRow}>
        <span className={styles.kindLabel} style={{ color }}>
          {KIND_LABEL[phase.kind]}
        </span>
        {phase.optional && <span className={styles.badgeAmber}>optional</span>}
        {hasError && <span className={styles.badgeRed}>error</span>}
        {hasWarning && !hasError && <span className={styles.badgeAmber}>warning</span>}
      </div>

      <p className={styles.cardDescription}>
        {phase.description || (
          <span className={styles.missingDesc}>description missing — will not save</span>
        )}
      </p>

      <div className={styles.chipsRow}>
        {phase.kind === 'agent' && (
          <>
            <Chip color={agentColor(phase.agent ?? null)}>{phase.agent ?? 'no agent'}</Chip>
            <Chip title="Envelope">
              <EnvelopeGlyph />
              {phase.envelope ?? 'inherit'}
            </Chip>
            {gates.length > 0 && (
              <Chip title={gates.join(' · ')}>
                {gates.length} gate{gates.length === 1 ? '' : 's'}
              </Chip>
            )}
            {phase.retries ? <Chip>retries {phase.retries}</Chip> : null}
          </>
        )}

        {phase.kind === 'code' && (
          <>
            <Chip color="var(--blue)" className={styles.blueChip}>
              {commandText(phase) || 'no command'}
            </Chip>
            {phase.feedbackTo && (
              <Chip title="Repair loop">
                feedback → {phase.feedbackTo} ×{phase.feedbackRetries ?? 1}
              </Chip>
            )}
          </>
        )}
      </div>
    </>
  );
}

function PhaseCard({
  phase,
  index,
  dragId,
  phases,
  selected,
  dragging,
  onSelect,
  onMovePhase,
  onReorderPhase,
  onRemove,
  agentColor,
  issues,
}: {
  phase: PhaseDef;
  index: number;
  dragId: string;
  phases: PhaseDef[];
  selected: boolean;
  dragging: boolean;
  onSelect: () => void;
  onMovePhase: (index: number, delta: number) => void;
  onReorderPhase: (from: number, to: number) => void;
  onRemove: () => void;
  agentColor: (name: string | null) => string;
  issues: ValidationIssue[];
}): React.JSX.Element {
  const hasError = issues.some((i) => issuePhaseIndex(i.where) === index && i.level === 'error');
  const drag = useDraggable({ id: dragId });

  return (
    <article
      ref={drag.setNodeRef}
      data-settle={dragId}
      className={[
        styles.phaseCard,
        selected ? styles.cardSelected : '',
        hasError ? styles.cardError : '',
        dragging ? styles.cardLifted : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <DragSurface listeners={drag.listeners}>
        <GripRow />
        <button type="button" className={styles.cardContentBtn} onClick={onSelect}>
          <PhaseBody phase={phase} index={index} agentColor={agentColor} issues={issues} />
        </button>
      </DragSurface>

      <div className={styles.cardToolbar}>
        <ToolBtn
          label={`Move ${phase.name} earlier`}
          Icon={ArrowUp}
          disabled={!(index > 0 && phases[index - 1]?.kind !== 'engineer')}
          onClick={() => onMovePhase(index, -1)}
        />
        <ToolBtn
          label={`Move ${phase.name} later`}
          Icon={ArrowDown}
          disabled={!(index < phases.length - 1 && phases[index + 1]?.kind !== 'engineer')}
          onClick={() => onMovePhase(index, 1)}
        />
        <span className={styles.toolSeparator} aria-hidden="true" />
        <StageMoveBtns
          phase={phase}
          index={index}
          phases={phases}
          onReorderPhase={onReorderPhase}
        />
        <ToolBtn
          label={`Remove ${phase.name}`}
          Icon={X}
          danger
          className={styles.toolBtnAutoLeft}
          onClick={onRemove}
        />
      </div>
    </article>
  );
}

/** The two buttons that push a phase across a checkpoint into the next stage. */
function StageMoveBtns({
  phase,
  index,
  phases,
  onReorderPhase,
}: {
  phase: PhaseDef;
  index: number;
  phases: PhaseDef[];
  onReorderPhase: (from: number, to: number) => void;
}): React.JSX.Element {
  const leftTarget = stageMoveTarget(phases, index, -1);
  const rightTarget = stageMoveTarget(phases, index, 1);
  return (
    <>
      <ToolBtn
        label={`Move ${phase.name} before the previous checkpoint`}
        Icon={ArrowLeft}
        disabled={leftTarget === null}
        onClick={() => leftTarget !== null && onReorderPhase(index, leftTarget)}
      />
      <ToolBtn
        label={`Move ${phase.name} past the next checkpoint`}
        Icon={ArrowRight}
        disabled={rightTarget === null}
        onClick={() => rightTarget !== null && onReorderPhase(index, rightTarget)}
      />
    </>
  );
}

/**
 * Everything above a card's toolbar is the drag handle.
 *
 * The toolbar is left out on purpose: its buttons are small targets whose whole
 * job is a single click, and a 5px wobble on one of them should press it rather
 * than pick the card up.
 */
function DragSurface({
  listeners,
  children,
}: {
  listeners: DraggableSyntheticListeners;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div {...listeners} className={styles.dragSurface}>
      {children}
    </div>
  );
}

function GateSlot({
  stage,
  phases,
  dragIds,
  selectedPhase,
  dragging,
  onSelectPhase,
  onAddPhase,
  onMovePhase,
  onRemovePhase,
  isLast,
  issues,
}: {
  stage: Stage;
  phases: PhaseDef[];
  dragIds: string[];
  selectedPhase: number | null;
  dragging: number | null;
  onSelectPhase: (index: number) => void;
  onAddPhase: (kind: PhaseKind, at?: number) => void;
  onMovePhase: (index: number, delta: number) => void;
  onRemovePhase: (index: number) => void;
  isLast: boolean;
  issues: ValidationIssue[];
}): React.JSX.Element | null {
  if (stage.gate === null && !isLast) return null;

  if (stage.gate === null) {
    return (
      <div className={styles.gateSlot}>
        <button
          type="button"
          className={styles.addCheckpointBtn}
          onClick={() => onAddPhase('engineer', stage.end)}
        >
          <span className={styles.addCheckpointTitle}>+ Checkpoint</span>
          <span className={styles.addCheckpointHint}>
            Nothing stops this run. Close stage {String(stage.index + 1).padStart(2, '0')} with a
            human.
          </span>
        </button>
      </div>
    );
  }

  return (
    <CheckpointGate
      gateIdx={stage.gate}
      dragId={dragIds[stage.gate]!}
      stage={stage}
      phases={phases}
      selectedPhase={selectedPhase}
      dragging={dragging}
      onSelectPhase={onSelectPhase}
      onMovePhase={onMovePhase}
      onRemovePhase={onRemovePhase}
      issues={issues}
    />
  );
}

/** The visible contents of a checkpoint card, identical on the board and in hand. */
function CheckpointBody({
  phase,
  index,
  stageIndex,
}: {
  phase: PhaseDef;
  index: number;
  stageIndex?: number;
}): React.JSX.Element {
  const missingQuestion = !phase.question?.trim();
  return (
    <>
      <div className={styles.cardHeaderRow}>
        <span className={styles.checkpointGlyph} aria-hidden="true">
          <PhaseGlyph kind="engineer" />
        </span>
        <span className={styles.checkpointLabel}>Checkpoint</span>
        <span className={styles.phaseIndex}>{String(index + 1).padStart(2, '0')}</span>
      </div>

      <p className={styles.phaseName}>{phase.name}</p>
      <p className={styles.checkpointDesc}>{phase.description}</p>

      <div className={styles.asksSection}>
        <span className={styles.asksLabel}>Asks</span>
        {missingQuestion ? (
          <p className={styles.warningText}>No question set — the sheet opens empty.</p>
        ) : (
          <p className={styles.asksQuestion}>“{phase.question}”</p>
        )}
      </div>

      <div className={styles.chipsRow}>
        <Chip color="var(--green)" className={styles.greenChip}>
          approve
        </Chip>
        <Chip color="var(--red)" className={styles.redChip}>
          reject
        </Chip>
        <Chip>{formatTimeout(phase.timeoutMs)}</Chip>
      </div>

      {stageIndex !== undefined && (
        <p className={styles.closesStageSubtext}>
          Closes stage {String(stageIndex + 1).padStart(2, '0')}
        </p>
      )}
    </>
  );
}

function CheckpointGate({
  gateIdx,
  dragId,
  stage,
  phases,
  selectedPhase,
  dragging,
  onSelectPhase,
  onMovePhase,
  onRemovePhase,
  issues,
}: {
  gateIdx: number;
  dragId: string;
  stage: Stage;
  phases: PhaseDef[];
  selectedPhase: number | null;
  dragging: number | null;
  onSelectPhase: (index: number) => void;
  onMovePhase: (index: number, delta: number) => void;
  onRemovePhase: (index: number) => void;
  issues: ValidationIssue[];
}): React.JSX.Element | null {
  const drag = useDraggable({ id: dragId });
  const phase = phases[gateIdx];
  if (!phase) return null;

  const gateIssues = issues.filter((i) => issuePhaseIndex(i.where) === gateIdx);

  return (
    <div className={styles.gateSlotActive}>
      <span className={styles.gateDividerLeft} aria-hidden="true" />
      <span className={styles.gateDividerRight} aria-hidden="true" />

      <div
        ref={drag.setNodeRef}
        data-settle={dragId}
        className={[
          styles.checkpointCard,
          selectedPhase === gateIdx ? styles.cardSelected : '',
          !phase.question?.trim() ? styles.cardAmberBorder : '',
          dragging === gateIdx ? styles.cardLifted : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <DragSurface listeners={drag.listeners}>
          <GripRow />
          <button
            type="button"
            className={styles.checkpointContentBtn}
            onClick={() => onSelectPhase(gateIdx)}
          >
            <CheckpointBody phase={phase} index={gateIdx} stageIndex={stage.index} />
          </button>
        </DragSurface>

        <div className={styles.cardToolbar}>
          <ToolBtn
            label={`Move ${phase.name} earlier`}
            Icon={ArrowUp}
            disabled={gateIdx === 0}
            onClick={() => onMovePhase(gateIdx, -1)}
          />
          <ToolBtn
            label={`Move ${phase.name} later`}
            Icon={ArrowDown}
            disabled={gateIdx === phases.length - 1}
            onClick={() => onMovePhase(gateIdx, 1)}
          />
          {gateIssues.length > 0 && (
            <span className={styles.issueCountLabel}>
              {gateIssues.length} issue{gateIssues.length === 1 ? '' : 's'}
            </span>
          )}
          <ToolBtn
            label={`Remove ${phase.name}`}
            Icon={X}
            danger
            className={gateIssues.length === 0 ? styles.toolBtnAutoLeft : ''}
            onClick={() => onRemovePhase(gateIdx)}
          />
        </div>
      </div>
    </div>
  );
}
