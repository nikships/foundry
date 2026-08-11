import { Fragment, useCallback, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DraggableSyntheticListeners,
  type DragEndEvent,
  type DragStartEvent,
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
import {
  commandText,
  dragPhaseId,
  dropRailId,
  dropSlotId,
  formatTimeout,
  gateNames,
  issuePhaseIndex,
  newStagePlan,
  parseDragPhaseId,
  parseDropId,
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
 * The handle that starts a drag.
 *
 * dnd-kit's `attributes` are deliberately dropped: they describe a focusable
 * draggable role, and the card toolbar already moves a phase in all four
 * directions from the keyboard. Announcing a second, pointer-only path to the
 * same edit to a screen reader would be noise, not an affordance.
 */
function DragGrip({
  listeners,
  setActivatorNodeRef,
  label,
}: {
  listeners: DraggableSyntheticListeners;
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  label: string;
}): React.JSX.Element {
  return (
    <span
      {...listeners}
      ref={setActivatorNodeRef}
      aria-hidden="true"
      title={label}
      className={styles.dragGrip}
    >
      <GripVertical size={12} strokeWidth={1.6} />
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
  const [dragging, setDragging] = useState<number | null>(null);

  const sensors = useSensors(
    // A card is a button first: a drag only begins once the pointer travels far
    // enough that the press was not a click meant to open the phase sheet.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    setDragging(parseDragPhaseId(event.active.id));
  }, []);

  const onDragCancel = useCallback(() => setDragging(null), []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragging(null);
      const from = parseDragPhaseId(event.active.id);
      const target = event.over ? parseDropId(event.over.id) : null;
      if (from === null || !target) return;
      if (target.kind === 'rail') {
        onNewStagePhase(from, target.boundary);
        return;
      }
      const to = reorderTarget(from, target.at);
      if (to !== null) onReorderPhase(from, to);
    },
    [onNewStagePhase, onReorderPhase],
  );

  // A checkpoint is a stage boundary, so it has no stage of its own to be given.
  const railsEnabled = useMemo(
    () => dragging !== null && phases[dragging]?.kind !== 'engineer',
    [dragging, phases],
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

  const dragged = dragging !== null ? phases[dragging] : null;

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
        <div className={styles.boardTrack}>
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
                  selectedPhase={selectedPhase}
                  dragging={dragging}
                  onSelectPhase={onSelectPhase}
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
                  selectedPhase={selectedPhase}
                  dragging={dragging}
                  onSelectPhase={onSelectPhase}
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

      <DragOverlay dropAnimation={null}>
        {dragged && dragging !== null && (
          <div className={styles.dragPreview}>
            <span
              style={{ color: phaseKindColor(dragged.kind, agentColor(dragged.agent ?? null)) }}
              className={styles.kindGlyphWrap}
              aria-hidden="true"
            >
              <PhaseGlyph kind={dragged.kind} />
            </span>
            <span className={styles.phaseName}>{dragged.name}</span>
            <span className={styles.phaseIndex}>{String(dragging + 1).padStart(2, '0')}</span>
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
              <Fragment key={`${phase.name}-${phaseIdx}`}>
                <PhaseCard
                  phase={phase}
                  index={phaseIdx}
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

function PhaseCard({
  phase,
  index,
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
  const color = phaseKindColor(phase.kind, agentColor(phase.agent ?? null));
  const gates = gateNames(phase);
  const phaseIssues = issues.filter((i) => issuePhaseIndex(i.where) === index);
  const hasError = phaseIssues.some((i) => i.level === 'error');
  const hasWarning = phaseIssues.some((i) => i.level === 'warning');

  const canUp = index > 0 && phases[index - 1]?.kind !== 'engineer';
  const canDown = index < phases.length - 1 && phases[index + 1]?.kind !== 'engineer';
  const leftTarget = stageMoveTarget(phases, index, -1);
  const rightTarget = stageMoveTarget(phases, index, 1);

  const drag = useDraggable({ id: dragPhaseId(index) });

  return (
    <article
      ref={drag.setNodeRef}
      className={[
        styles.phaseCard,
        selected ? styles.cardSelected : '',
        hasError ? styles.cardError : '',
        dragging ? styles.cardDragging : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.cardGripRow}>
        <DragGrip
          listeners={drag.listeners}
          setActivatorNodeRef={drag.setActivatorNodeRef}
          label={`Drag ${phase.name}`}
        />
      </div>

      <button type="button" className={styles.cardContentBtn} onClick={onSelect}>
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
      </button>

      <div className={styles.cardToolbar}>
        <ToolBtn
          label={`Move ${phase.name} earlier`}
          Icon={ArrowUp}
          disabled={!canUp}
          onClick={() => onMovePhase(index, -1)}
        />
        <ToolBtn
          label={`Move ${phase.name} later`}
          Icon={ArrowDown}
          disabled={!canDown}
          onClick={() => onMovePhase(index, 1)}
        />
        <span className={styles.toolSeparator} aria-hidden="true" />
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

function GateSlot({
  stage,
  phases,
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

function CheckpointGate({
  gateIdx,
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
  stage: Stage;
  phases: PhaseDef[];
  selectedPhase: number | null;
  dragging: number | null;
  onSelectPhase: (index: number) => void;
  onMovePhase: (index: number, delta: number) => void;
  onRemovePhase: (index: number) => void;
  issues: ValidationIssue[];
}): React.JSX.Element | null {
  const drag = useDraggable({ id: dragPhaseId(gateIdx) });
  const phase = phases[gateIdx];
  if (!phase) return null;

  const gateIssues = issues.filter((i) => issuePhaseIndex(i.where) === gateIdx);
  const missingQuestion = !phase.question?.trim();
  const selected = selectedPhase === gateIdx;

  return (
    <div className={styles.gateSlotActive}>
      <span className={styles.gateDividerLeft} aria-hidden="true" />
      <span className={styles.gateDividerRight} aria-hidden="true" />

      <div
        ref={drag.setNodeRef}
        className={[
          styles.checkpointCard,
          selected ? styles.cardSelected : '',
          missingQuestion ? styles.cardAmberBorder : '',
          dragging === gateIdx ? styles.cardDragging : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className={styles.cardGripRow}>
          <DragGrip
            listeners={drag.listeners}
            setActivatorNodeRef={drag.setActivatorNodeRef}
            label={`Drag ${phase.name}`}
          />
        </div>

        <button
          type="button"
          className={styles.checkpointContentBtn}
          onClick={() => onSelectPhase(gateIdx)}
        >
          <div className={styles.cardHeaderRow}>
            <span className={styles.checkpointGlyph} aria-hidden="true">
              <PhaseGlyph kind="engineer" />
            </span>
            <span className={styles.checkpointLabel}>Checkpoint</span>
            <span className={styles.phaseIndex}>{String(gateIdx + 1).padStart(2, '0')}</span>
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

          <p className={styles.closesStageSubtext}>
            Closes stage {String(stage.index + 1).padStart(2, '0')}
          </p>
        </button>

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
