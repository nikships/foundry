import { useRef } from 'react';
import type { ReasoningEffort } from '@shared/types.js';
import {
  modelForEffortPicker,
  normalizeReasoningEffortForModelChoice,
} from '@shared/reasoning-effort.js';
import { useAgentModels } from '../../hooks/useAgentModels.js';
import { KIND_LABEL } from '../../utils/derive.js';
import type { PlanPhaseView } from '../../view-models/plan-view.js';
import ModelPicker from '../common/ModelPicker.js';
import ReasoningEffortPicker from '../common/ReasoningEffortPicker.js';
import { Button } from '../ui/Button.js';
import { SideSheet } from '../ui/SideSheet.js';
import styles from './PlanPhaseSheet.module.css';

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </div>
  );
}

function ChipList({ items, empty }: { items: string[]; empty: string }): React.JSX.Element {
  if (items.length === 0) return <span className="faint">{empty}</span>;
  return (
    <span className={styles.chips}>
      {items.map((item) => (
        <span key={item} className={styles.chip}>
          {item}
        </span>
      ))}
    </span>
  );
}

/**
 * Deep, read-only inspection of one proposed phase, opened from the proposal
 * canvas. The only two live controls are the proposal's own overrides — model
 * and reasoning — which edit the plan the operator will start, never a stored
 * pipeline.
 */
export default function PlanPhaseSheet({
  phase,
  overridden,
  starting,
  onPhaseModelChange,
  onPhaseReasoningEffortChange,
  onClose,
}: {
  phase: PlanPhaseView | null;
  /** Whether the operator re-cast this phase against the proposal. */
  overridden: boolean;
  starting: boolean;
  onPhaseModelChange: (phaseName: string, model: string) => void;
  onPhaseReasoningEffortChange: (phaseName: string, effort: ReasoningEffort) => void;
  onClose: () => void;
}): React.JSX.Element | null {
  const { models, refresh } = useAgentModels();
  // The last inspected phase outlives `phase` by one exit animation, so the
  // sheet slides out showing its content instead of vanishing on dismiss.
  const lastPhase = useRef<PlanPhaseView | null>(null);
  if (phase) lastPhase.current = phase;
  const shown = phase ?? lastPhase.current;
  if (!shown) return null;

  return (
    <SideSheet
      open={phase !== null}
      onClose={onClose}
      label={`Phase ${shown.name}`}
      eyebrow={
        <>
          Phase <span className="index">{String(shown.index + 1).padStart(2, '0')}</span>
        </>
      }
      title={
        <p className={styles.title} data-testid="plan-phase-sheet-title">
          {shown.name} <span className={styles.titleKind}>{KIND_LABEL[shown.kind]}</span>
        </p>
      }
      footer={
        <Button size="sm" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className={styles.body} data-testid="plan-phase-sheet">
        <p className={styles.description}>{shown.description}</p>

        {shown.model !== null && (
          <div className={styles.overrides}>
            <div className={styles.overridesHead}>
              <span className={styles.sectionLabel}>Casting</span>
              {overridden && <span className={styles.overriddenBadge}>overridden</span>}
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Model</span>
              <ModelPicker
                value={shown.model}
                models={models}
                showNotes={false}
                disabled={starting}
                onChange={(model) => {
                  onPhaseModelChange(shown.name, model);
                  const normalized = normalizeReasoningEffortForModelChoice(
                    shown.reasoningEffort ?? 'medium',
                    model,
                    models,
                  );
                  if (normalized !== shown.reasoningEffort) {
                    onPhaseReasoningEffortChange(shown.name, normalized);
                  }
                }}
                onRefresh={() => void refresh()}
              />
            </div>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Reasoning</span>
              <ReasoningEffortPicker
                value={shown.reasoningEffort ?? 'medium'}
                model={modelForEffortPicker(shown.model, models)}
                disabled={starting}
                ariaLabel={`Reasoning effort for ${shown.name}`}
                data-testid={`plan-reasoning-${shown.name}`}
                onChange={(effort) => onPhaseReasoningEffortChange(shown.name, effort)}
              />
            </div>
            <p className={styles.overridesHint}>
              Casting changes apply to the run you start from this proposal. Everything else is the
              plan as proposed.
            </p>
          </div>
        )}

        <div className={styles.details}>
          <span className={styles.sectionLabel}>Execution</span>
          {shown.agent && (
            <Row label="Agent">
              {shown.agent}
              {shown.synthesized && <span className={styles.synthBadge}>synthesized</span>}
            </Row>
          )}
          {shown.command !== null && <Row label="Command">{shown.command}</Row>}
          {shown.kind === 'agent' && (
            <Row label="Prompt inputs">
              <ChipList items={shown.inputs} empty="none declared" />
            </Row>
          )}
          <Row label="Checks">
            <ChipList items={shown.gates} empty="none" />
          </Row>
          {shown.envelope && <Row label="Report">{shown.envelope}</Row>}
          {shown.kind === 'agent' && <Row label="Retries">{shown.retries} on check failure</Row>}
          <Row label="On failure">
            {shown.feedbackTo
              ? `hands evidence back to ${shown.feedbackTo} (${shown.feedbackRetries ?? 1} ${
                  (shown.feedbackRetries ?? 1) === 1 ? 'retry' : 'retries'
                })`
              : shown.optional
                ? 'recorded, run continues'
                : 'fails the run'}
          </Row>
          {shown.kind === 'code' && (
            <Row label="Healing">
              {shown.heals ? 'a bounded repair turn before the failure escalates' : 'off'}
            </Row>
          )}
          {shown.decides && (
            <Row label="Acceptance">
              <span className={styles.decides}>the acceptance rule reads this phase</span>
            </Row>
          )}
        </div>
      </div>
    </SideSheet>
  );
}
