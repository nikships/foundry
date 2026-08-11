/**
 * StageBoard — the pipeline as a board of gated stages (redesign Option B).
 *
 * Columns are stages: the run of phases that execute unattended, and the
 * checkpoint that closes each one. That grouping is derived from the phase
 * list (see `stagesOf`), never stored, so the board edits the same ordered
 * array every other surface reads — moving a card across a gate really does
 * move the phase past the checkpoint.
 *
 * Where the ladder in Option A makes repair loops the story, the board makes
 * approval structure the story: where the run stops, and who has to answer.
 */
import type { AgentDef, Acceptance, PhaseDef, ValidationIssue } from '@shared/types.js';
import { KIND_LABEL, phaseKindColor } from '../derive.js';
import {
  commandText,
  issuePhaseIndex,
  outcomeMarks,
  stageGateSummary,
  stageLabel,
  stageMoveTarget,
  stagesOf,
} from '../pipeline-view.js';
import { CliIcon } from './BrandIcon.js';
import AgentAvatar from './AgentAvatar.js';
import {
  ChevronDownGlyph,
  EnvelopeGlyph,
  OutcomeGlyph,
  PhaseGlyph,
  PlusGlyph,
} from './PhaseGlyphs.js';
import { Dropdown, type DropdownOption } from './ui/Dropdown.js';
import styles from './StageBoard.module.css';

const ADD_PHASE_OPTIONS: DropdownOption[] = [
  {
    value: 'agent',
    label: 'Agent',
    description: 'Prompt an agent and require a typed envelope back',
    icon: <PhaseGlyph kind="agent" />,
  },
  {
    value: 'code',
    label: 'Command',
    description: 'Run a project command; a non-zero exit fails the phase',
    icon: <PhaseGlyph kind="code" />,
  },
];

function MoveGlyph({ dir }: { dir: 'up' | 'down' | 'left' | 'right' }): React.JSX.Element {
  const rotation = { up: 0, right: 90, down: 180, left: 270 }[dir];
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={rotation ? { transform: `rotate(${rotation}deg)` } : undefined}
    >
      <path d="M7 11.5v-9M3.2 6.3 7 2.5l3.8 3.8" />
    </svg>
  );
}

function RemoveGlyph(): React.JSX.Element {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2" />
    </svg>
  );
}

function CardMeta({
  phase,
  owner,
}: {
  phase: PhaseDef;
  owner: AgentDef | null;
}): React.JSX.Element {
  if (phase.kind === 'agent') {
    return (
      <>
        {owner && <CliIcon vendor={owner.cli ?? 'droid'} size={11} />}
        <span className={styles.cardWho}>{phase.agent || 'no agent'}</span>
        <span className={styles.envelopeChip} title="Envelope">
          <EnvelopeGlyph size={10} />
          <span>{phase.envelope ?? owner?.envelope ?? 'build'}</span>
        </span>
      </>
    );
  }
  const text = commandText(phase);
  return (
    <span className={styles.cardCommand}>
      <span className={styles.cardPrompt}>$</span> {text || 'no command'}
    </span>
  );
}

export default function StageBoard({
  phases,
  agents,
  agentColor,
  acceptance,
  issues,
  selected,
  onSelect,
  onMove,
  onMoveStage,
  onRemove,
  onAdd,
  onAddGate,
}: {
  phases: PhaseDef[];
  agents: AgentDef[];
  agentColor: (name: string | null) => string;
  acceptance: Acceptance;
  issues: ValidationIssue[];
  /** Index of the phase the slide-over is editing, or -1 for none. */
  selected: number;
  onSelect: (index: number) => void;
  /** Reorder within a stage. */
  onMove: (index: number, delta: number) => void;
  /** Move to an absolute index, for crossing a gate. */
  onMoveStage: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  /** Add a phase of `kind` at an absolute index. */
  onAdd: (kind: PhaseDef['kind'], at: number) => void;
  /** Close a stage with a new checkpoint at an absolute index. */
  onAddGate: (at: number) => void;
}): React.JSX.Element {
  const stages = stagesOf(phases);
  const marked = new Set(outcomeMarks(acceptance, phases));

  const levelByPhase = new Map<number, 'error' | 'warning'>();
  for (const issue of issues) {
    const index = issuePhaseIndex(issue.where);
    if (index == null) continue;
    if (issue.level === 'error' || !levelByPhase.has(index)) levelByPhase.set(index, issue.level);
  }

  const hueOf = (phase: PhaseDef): string =>
    phaseKindColor(phase.kind, agentColor(phase.agent ?? null));
  const ownerOf = (phase: PhaseDef): AgentDef | null =>
    phase.kind === 'agent' ? (agents.find((a) => a.name === phase.agent) ?? null) : null;

  return (
    <div className={styles.board} role="group" aria-label="Pipeline stages">
      {stages.map((stage) => {
        const gate = stage.gate == null ? null : phases[stage.gate];
        const gateLevel = stage.gate == null ? undefined : levelByPhase.get(stage.gate);
        return (
          <div key={stage.index} className={styles.stageWrap}>
            <section
              className={styles.stage}
              aria-label={`${stageLabel(stage, stages.length)}, ${stage.members.length} phases`}
            >
              <header className={styles.stageHead}>
                <div className={styles.stageHeadText}>
                  <p className={styles.stageName}>{stageLabel(stage, stages.length)}</p>
                  <p className={styles.stageHint}>{stageGateSummary(stage, phases)}</p>
                </div>
                <span className={styles.stageCount}>{stage.members.length}</span>
              </header>

              <ul className={styles.cards}>
                {stage.members.map((index, positionInStage) => {
                  const phase = phases[index]!;
                  const hue = hueOf(phase);
                  const on = index === selected;
                  const level = levelByPhase.get(index);
                  const prevStage = stageMoveTarget(phases, index, -1);
                  const nextStage = stageMoveTarget(phases, index, 1);
                  return (
                    <li key={index}>
                      <div
                        className={`${styles.card} ${on ? styles.on : ''}`}
                        style={{ ['--hue' as string]: hue }}
                      >
                        <button
                          type="button"
                          className={styles.cardFace}
                          aria-pressed={on}
                          onClick={() => onSelect(index)}
                        >
                          <span className={styles.cardTop}>
                            <span className={styles.cardIndex}>
                              {String(index + 1).padStart(2, '0')}
                            </span>
                            <span className={styles.cardIcon}>
                              <PhaseGlyph kind={phase.kind} />
                            </span>
                            {phase.kind === 'agent' && (
                              <AgentAvatar name={phase.agent ?? null} size={18} />
                            )}
                            <span className={styles.cardName}>{phase.name}</span>
                            {level && (
                              <span
                                className={`${styles.issueDot} ${
                                  level === 'error' ? styles.issueError : styles.issueWarning
                                }`}
                                title={level === 'error' ? 'Has an error' : 'Has a warning'}
                              />
                            )}
                            {marked.has(index) && (
                              <span
                                className={styles.outcomeMark}
                                title="Acceptance reads this phase"
                              >
                                <OutcomeGlyph size={11} />
                              </span>
                            )}
                          </span>
                          <span className={styles.cardMeta}>
                            <CardMeta phase={phase} owner={ownerOf(phase)} />
                          </span>
                          <span className={styles.cardTags}>
                            <span className={styles.kindTag}>{KIND_LABEL[phase.kind]}</span>
                            {phase.optional && <span className={styles.flagTag}>optional</span>}
                            {phase.feedbackTo && (
                              <span className={styles.loopTag} title="Repair loop">
                                repairs to {phase.feedbackTo}
                              </span>
                            )}
                          </span>
                        </button>
                        <div className={styles.cardTools}>
                          <button
                            type="button"
                            className={styles.tool}
                            disabled={prevStage == null}
                            title="Move to the previous stage"
                            aria-label={`Move ${phase.name} to the previous stage`}
                            onClick={() => prevStage != null && onMoveStage(index, prevStage)}
                          >
                            <MoveGlyph dir="left" />
                          </button>
                          <button
                            type="button"
                            className={styles.tool}
                            disabled={positionInStage === 0}
                            title="Move earlier in this stage"
                            aria-label={`Move ${phase.name} earlier`}
                            onClick={() => onMove(index, -1)}
                          >
                            <MoveGlyph dir="up" />
                          </button>
                          <button
                            type="button"
                            className={styles.tool}
                            disabled={positionInStage === stage.members.length - 1}
                            title="Move later in this stage"
                            aria-label={`Move ${phase.name} later`}
                            onClick={() => onMove(index, 1)}
                          >
                            <MoveGlyph dir="down" />
                          </button>
                          <button
                            type="button"
                            className={styles.tool}
                            disabled={nextStage == null}
                            title="Move to the next stage"
                            aria-label={`Move ${phase.name} to the next stage`}
                            onClick={() => nextStage != null && onMoveStage(index, nextStage)}
                          >
                            <MoveGlyph dir="right" />
                          </button>
                          <button
                            type="button"
                            className={`${styles.tool} ${styles.danger}`}
                            title="Remove phase"
                            aria-label={`Remove ${phase.name}`}
                            onClick={() => onRemove(index)}
                          >
                            <RemoveGlyph />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}

                {stage.members.length === 0 && (
                  <li className={styles.stageEmpty}>Nothing runs in this stage yet.</li>
                )}

                <li>
                  <Dropdown
                    value=""
                    options={ADD_PHASE_OPTIONS}
                    onChange={(kind) =>
                      onAdd(kind as PhaseDef['kind'], stage.gate == null ? stage.end : stage.gate)
                    }
                    aria-label={`Add a phase to ${stageLabel(stage, stages.length)}`}
                    className={styles.composeWrap}
                    triggerClassName={styles.compose}
                    renderValue={() => (
                      <span className={styles.composeFace}>
                        <PlusGlyph />
                        <span>Add phase</span>
                        <ChevronDownGlyph />
                      </span>
                    )}
                  />
                </li>
              </ul>
            </section>

            {gate ? (
              <div
                className={`${styles.gate} ${stage.gate === selected ? styles.on : ''}`}
                style={{ ['--hue' as string]: hueOf(gate) }}
              >
                <button
                  type="button"
                  className={styles.gateFace}
                  aria-pressed={stage.gate === selected}
                  onClick={() => stage.gate != null && onSelect(stage.gate)}
                >
                  <span className={styles.gateIcon}>
                    <PhaseGlyph kind="engineer" />
                  </span>
                  <span className={styles.gateLabel}>Gate</span>
                  <span className={styles.gateName}>{gate.name}</span>
                  <span className={styles.gateQuestion}>{gate.question || 'no question'}</span>
                  {gateLevel && (
                    <span
                      className={`${styles.issueDot} ${
                        gateLevel === 'error' ? styles.issueError : styles.issueWarning
                      }`}
                      title={gateLevel === 'error' ? 'Has an error' : 'Has a warning'}
                    />
                  )}
                </button>
                <button
                  type="button"
                  className={`${styles.tool} ${styles.danger} ${styles.gateRemove}`}
                  title="Remove gate"
                  aria-label={`Remove gate ${gate.name}`}
                  onClick={() => stage.gate != null && onRemove(stage.gate)}
                >
                  <RemoveGlyph />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={styles.addGate}
                title="Close this stage with a checkpoint"
                onClick={() => onAddGate(stage.end)}
              >
                <PhaseGlyph kind="engineer" />
                <span>Add gate</span>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
