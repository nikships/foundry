import React from 'react';
import type { PhaseDef, PhaseKind, ValidationIssue } from '@shared/types.js';
import { KIND_LABEL, phaseKindColor } from '../derive.js';
import {
  commandText,
  formatTimeout,
  gateNames,
  issuePhaseIndex,
  stageLabel,
  stageMoveTarget,
  stagesOf,
  type Stage,
} from '../pipeline-view.js';
import { PhaseGlyph } from './PhaseGlyphs.js';
import { Button } from './ui/Button.js';
import styles from './StageBoard.module.css';

export default function StageBoard({
  phases,
  selectedPhase,
  onSelectPhase,
  onAddPhase,
  onMovePhase,
  onReorderPhase,
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
  onRemovePhase: (index: number) => void;
  agentColor: (name: string | null) => string;
  issues: ValidationIssue[];
}): React.JSX.Element {
  const stages = stagesOf(phases);

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

  return (
    <div className={styles.boardContainer}>
      <div className={styles.boardTrack}>
        {stages.map((stage, stageIdx) => (
          <React.Fragment key={`stage-${stage.index}`}>
            <StageColumn
              stage={stage}
              totalStages={stages.length}
              phases={phases}
              selectedPhase={selectedPhase}
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
              onSelectPhase={onSelectPhase}
              onAddPhase={onAddPhase}
              onMovePhase={onMovePhase}
              onRemovePhase={onRemovePhase}
              isLast={stageIdx === stages.length - 1}
              issues={issues}
            />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function StageColumn({
  stage,
  totalStages,
  phases,
  selectedPhase,
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
  onSelectPhase: (index: number) => void;
  onAddPhase: (kind: PhaseKind, at?: number) => void;
  onMovePhase: (index: number, delta: number) => void;
  onReorderPhase: (from: number, to: number) => void;
  onRemovePhase: (index: number) => void;
  agentColor: (name: string | null) => string;
  issues: ValidationIssue[];
}): React.JSX.Element {
  const insertIndex = stage.gate !== null ? stage.gate : stage.end;

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
        {stage.members.length > 0 ? (
          stage.members.map((phaseIdx) => {
            const phase = phases[phaseIdx];
            if (!phase) return null;
            return (
              <PhaseCard
                key={`${phase.name}-${phaseIdx}`}
                phase={phase}
                index={phaseIdx}
                phases={phases}
                selected={selectedPhase === phaseIdx}
                onSelect={() => onSelectPhase(phaseIdx)}
                onMovePhase={onMovePhase}
                onReorderPhase={onReorderPhase}
                onRemove={() => onRemovePhase(phaseIdx)}
                agentColor={agentColor}
                issues={issues}
              />
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

  return (
    <article
      className={`${styles.phaseCard} ${selected ? styles.cardSelected : ''} ${
        hasError ? styles.cardError : ''
      }`}
    >
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
              <span
                className={styles.chip}
                style={{ borderLeftColor: agentColor(phase.agent ?? null) }}
              >
                {phase.agent ?? 'no agent'}
              </span>
              <span className={styles.chip}>{phase.envelope ?? 'inherit'}</span>
              {gates.length > 0 && <span className={styles.chip}>{gates.length} gates</span>}
            </>
          )}

          {phase.kind === 'code' && (
            <>
              <span className={`${styles.chip} ${styles.blueChip}`}>
                {commandText(phase) || 'no command'}
              </span>
              {phase.feedbackTo && (
                <span className={styles.chip}>
                  feedback → {phase.feedbackTo} ×{phase.feedbackRetries ?? 1}
                </span>
              )}
            </>
          )}
        </div>
      </button>

      <div className={styles.cardToolbar}>
        <button
          type="button"
          aria-label={`Move ${phase.name} earlier`}
          title="Move earlier"
          disabled={!canUp}
          className={styles.toolBtn}
          onClick={() => onMovePhase(index, -1)}
        >
          ↑
        </button>
        <button
          type="button"
          aria-label={`Move ${phase.name} later`}
          title="Move later"
          disabled={!canDown}
          className={styles.toolBtn}
          onClick={() => onMovePhase(index, 1)}
        >
          ↓
        </button>
        <span className={styles.toolSeparator} aria-hidden="true" />
        <button
          type="button"
          aria-label={`Move ${phase.name} before previous checkpoint`}
          title="Move before previous checkpoint"
          disabled={leftTarget === null}
          className={styles.toolBtn}
          onClick={() => leftTarget !== null && onReorderPhase(index, leftTarget)}
        >
          ←
        </button>
        <button
          type="button"
          aria-label={`Move ${phase.name} past next checkpoint`}
          title="Move past next checkpoint"
          disabled={rightTarget === null}
          className={styles.toolBtn}
          onClick={() => rightTarget !== null && onReorderPhase(index, rightTarget)}
        >
          →
        </button>
        <button
          type="button"
          aria-label={`Remove ${phase.name}`}
          title="Remove phase"
          className={`${styles.toolBtn} ${styles.removeToolBtn}`}
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
    </article>
  );
}

function GateSlot({
  stage,
  phases,
  selectedPhase,
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

  const gateIdx = stage.gate;
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
        className={`${styles.checkpointCard} ${selected ? styles.cardSelected : ''} ${
          missingQuestion ? styles.cardAmberBorder : ''
        }`}
      >
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
              <p className={styles.warningText}>No question set — sheet opens empty.</p>
            ) : (
              <p className={styles.asksQuestion}>“{phase.question}”</p>
            )}
          </div>

          <div className={styles.chipsRow}>
            <span className={`${styles.chip} ${styles.greenChip}`}>approve</span>
            <span className={`${styles.chip} ${styles.redChip}`}>reject</span>
            <span className={styles.chip}>{formatTimeout(phase.timeoutMs)}</span>
          </div>

          <p className={styles.closesStageSubtext}>
            Closes stage {String(stage.index + 1).padStart(2, '0')}
          </p>
        </button>

        <div className={styles.cardToolbar}>
          <button
            type="button"
            aria-label={`Move ${phase.name} earlier`}
            title="Move earlier"
            disabled={gateIdx === 0}
            className={styles.toolBtn}
            onClick={() => onMovePhase(gateIdx, -1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label={`Move ${phase.name} later`}
            title="Move later"
            disabled={gateIdx === phases.length - 1}
            className={styles.toolBtn}
            onClick={() => onMovePhase(gateIdx, 1)}
          >
            ↓
          </button>
          {gateIssues.length > 0 && (
            <span className={styles.issueCountLabel}>{gateIssues.length} issue</span>
          )}
          <button
            type="button"
            aria-label={`Remove ${phase.name}`}
            title="Remove checkpoint"
            className={`${styles.toolBtn} ${styles.removeToolBtn} ${
              gateIssues.length === 0 ? styles.toolBtnAutoLeft : ''
            }`}
            onClick={() => onRemovePhase(gateIdx)}
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
