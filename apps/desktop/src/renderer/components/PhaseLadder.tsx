/**
 * PhaseLadder — the pipeline as a vertical ladder with a flow gutter.
 *
 * Rungs are phases, top to bottom in execution order. To their left the gutter
 * carries what a list of phases cannot say on its own: a rail marking the run,
 * kind-coloured anchors, and repair loops (`feedbackTo`) drawn as arcs back to
 * the phase that gets the failure handed to it. Nested loops are given their
 * own lanes so two arcs never sit on the same line.
 *
 * The ladder is a vertical tablist driving the phase inspector beside it —
 * selection follows focus, reorder and remove live on the rung itself, and the
 * geometry comes from `pipeline-view.ts` so the SVG and the rows cannot drift.
 */
import type { AgentDef, Acceptance, PhaseDef, ValidationIssue } from '@shared/types.js';
import { KIND_LABEL, phaseKindColor } from '../derive.js';
import {
  RUNG_H,
  arcPath,
  commandText,
  feedbackArcs,
  gutterWidth,
  issuePhaseIndex,
  outcomeMarks,
  rungCenter,
} from '../pipeline-view.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
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
import styles from './PhaseLadder.module.css';

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
  {
    value: 'engineer',
    label: 'Checkpoint',
    description: 'Pause the run until a human answers',
    icon: <PhaseGlyph kind="engineer" />,
  },
];

function ArrowGlyph({ up }: { up: boolean }): React.JSX.Element {
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
      style={up ? undefined : { transform: 'rotate(180deg)' }}
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

/** The mono line under a phase name: who runs it, or what it runs. */
function RungMeta({
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
        <span className={styles.rungWho}>{phase.agent || 'no agent'}</span>
        <span className={styles.envelopeChip} title="Envelope">
          <EnvelopeGlyph size={10} />
          <span>{phase.envelope ?? owner?.envelope ?? 'build'}</span>
        </span>
      </>
    );
  }
  if (phase.kind === 'code') {
    const text = commandText(phase);
    return (
      <span className={styles.rungCommand}>
        <span className={styles.rungPrompt}>$</span> {text || 'no command'}
      </span>
    );
  }
  return <span className={styles.rungWho}>{phase.question || 'no question'}</span>;
}

export default function PhaseLadder({
  phases,
  agents,
  agentColor,
  acceptance,
  issues,
  selected,
  panelId,
  onSelect,
  onMove,
  onRemove,
  onAdd,
}: {
  phases: PhaseDef[];
  agents: AgentDef[];
  agentColor: (name: string | null) => string;
  acceptance: Acceptance;
  issues: ValidationIssue[];
  /** Index of the phase the inspector is showing. */
  selected: number;
  /** Id of the inspector panel these rungs control. */
  panelId: string;
  onSelect: (index: number) => void;
  onMove: (index: number, delta: number) => void;
  onRemove: (index: number) => void;
  onAdd: (kind: PhaseDef['kind']) => void;
}): React.JSX.Element {
  const onLadderKey = useTablistNav('vertical');

  const arcs = feedbackArcs(phases);
  const gutterW = gutterWidth(arcs);
  const railX = gutterW - 0.5;
  const marked = new Set(outcomeMarks(acceptance, phases));

  // Worst level reported against each phase, so a rung can show it has a
  // problem without the operator hunting the status bar for which one.
  const levelByPhase = new Map<number, 'error' | 'warning'>();
  for (const issue of issues) {
    const index = issuePhaseIndex(issue.where);
    if (index == null) continue;
    if (issue.level === 'error' || !levelByPhase.has(index)) levelByPhase.set(index, issue.level);
  }

  const height = Math.max(phases.length * RUNG_H, RUNG_H);
  const activeIndex = selected >= 0 && selected < phases.length ? selected : 0;
  const hues = phases.map((p) => phaseKindColor(p.kind, agentColor(p.agent ?? null)));
  const ownerOf = (phase: PhaseDef): AgentDef | null =>
    phase.kind === 'agent' ? (agents.find((a) => a.name === phase.agent) ?? null) : null;

  return (
    <div className={styles.ladder} style={{ ['--rung-h' as string]: `${RUNG_H}px` }}>
      {phases.length > 0 && (
        <div className={styles.body} style={{ ['--gutter-w' as string]: `${gutterW}px` }}>
          <svg
            className={styles.gutter}
            width={gutterW}
            height={height}
            viewBox={`0 0 ${gutterW} ${height}`}
            aria-hidden
          >
            <line
              className={styles.rail}
              x1={railX}
              y1={rungCenter(0)}
              x2={railX}
              y2={rungCenter(phases.length - 1)}
            />
            {arcs.map((arc) => (
              <g key={`${arc.to}-${arc.from}`} className={styles.arc}>
                <path d={arcPath(arc, railX)} fill="none" />
                <path
                  className={styles.arcHead}
                  d={`M ${railX - 2} ${rungCenter(arc.to)} l -6 -3.2 v 6.4 z`}
                />
              </g>
            ))}
            {phases.map((_, i) => (
              <circle
                key={i}
                className={`${styles.anchor} ${i === activeIndex ? styles.anchorOn : ''}`}
                style={{ ['--hue' as string]: hues[i] }}
                cx={railX}
                cy={rungCenter(i)}
                r={i === activeIndex ? 4.5 : 3}
              />
            ))}
          </svg>

          <div
            className={styles.rungs}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Phases"
            onKeyDown={onLadderKey}
          >
            {phases.map((phase, i) => {
              const owner = ownerOf(phase);
              const hue = hues[i];
              const on = i === activeIndex;
              const level = levelByPhase.get(i);
              const issueClass = level === 'error' ? styles.issueError : styles.issueWarning;
              return (
                <div
                  key={i}
                  className={`${styles.rung} ${on ? styles.on : ''}`}
                  style={{ ['--hue' as string]: hue }}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`${panelId}-tab-${i}`}
                    aria-selected={on}
                    aria-controls={panelId}
                    tabIndex={on ? 0 : -1}
                    className={styles.face}
                    onClick={() => onSelect(i)}
                  >
                    <span className={styles.rungIndex}>{String(i + 1).padStart(2, '0')}</span>
                    <span className={styles.rungIcon}>
                      <PhaseGlyph kind={phase.kind} />
                    </span>
                    {phase.kind === 'agent' && <AgentAvatar name={phase.agent ?? null} size={20} />}
                    <span className={styles.rungText}>
                      <span className={styles.rungTitle}>
                        <span className={styles.rungName}>{phase.name}</span>
                        <span className={styles.rungKind}>{KIND_LABEL[phase.kind]}</span>
                        {phase.optional && <span className={styles.rungFlag}>optional</span>}
                      </span>
                      <span className={styles.rungMeta}>
                        <RungMeta phase={phase} owner={owner} />
                      </span>
                    </span>
                    <span className={styles.rungMarks}>
                      {level && (
                        <span
                          className={`${styles.issueDot} ${issueClass}`}
                          title={level === 'error' ? 'Has an error' : 'Has a warning'}
                        />
                      )}
                      {marked.has(i) && (
                        <span className={styles.outcomeMark} title="Acceptance reads this phase">
                          <OutcomeGlyph size={11} />
                        </span>
                      )}
                    </span>
                  </button>
                  <span className={styles.tools}>
                    <button
                      type="button"
                      className={styles.tool}
                      disabled={i === 0}
                      title="Move earlier"
                      aria-label={`Move ${phase.name} earlier`}
                      onClick={() => onMove(i, -1)}
                    >
                      <ArrowGlyph up />
                    </button>
                    <button
                      type="button"
                      className={styles.tool}
                      disabled={i === phases.length - 1}
                      title="Move later"
                      aria-label={`Move ${phase.name} later`}
                      onClick={() => onMove(i, 1)}
                    >
                      <ArrowGlyph up={false} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.tool} ${styles.danger}`}
                      title="Remove phase"
                      aria-label={`Remove ${phase.name}`}
                      onClick={() => onRemove(i)}
                    >
                      <RemoveGlyph />
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {phases.length === 0 && (
        <p className={styles.noPhases}>
          No phases yet. A pipeline is an ordered list of them — add the first one to start.
        </p>
      )}

      <div className={styles.addRow}>
        <Dropdown
          value=""
          options={ADD_PHASE_OPTIONS}
          onChange={(kind) => onAdd(kind as PhaseDef['kind'])}
          className={styles.addWrap}
          triggerClassName={styles.addBtn}
          aria-label="Add phase"
          renderValue={() => (
            <span className={styles.addFace}>
              <PlusGlyph />
              <span>Add phase</span>
              <ChevronDownGlyph />
            </span>
          )}
        />
        {arcs.length > 0 && (
          <span className={styles.legend}>
            <span className={styles.legendArc} aria-hidden />
            {`${arcs.length} repair loop${arcs.length === 1 ? '' : 's'}`}
          </span>
        )}
      </div>
    </div>
  );
}
