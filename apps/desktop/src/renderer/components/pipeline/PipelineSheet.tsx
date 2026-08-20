import type { Acceptance, PipelineDef, ValidationIssue } from '@shared/types.js';
import { ACCEPTANCE_OPTIONS, acceptanceReads } from '../../view-models/pipeline-view.js';
import { Button } from '../ui/Button.js';
import { Dropdown, type DropdownOption } from '../ui/Dropdown.js';
import { IssueCount, IssueLine } from '../ui/Issues.js';
import { SaveState } from '../ui/SaveState.js';
import { SideSheet } from '../ui/SideSheet.js';
import { Toggle } from '../ui/Toggle.js';
import styles from './PipelineSheet.module.css';

const KIND_OPTIONS: DropdownOption[] = ACCEPTANCE_OPTIONS.map((o) => ({
  value: o.value,
  label: o.label,
  description: o.description,
}));

const FLAG_OPTIONS: DropdownOption[] = [
  { value: 'passed', label: 'passed' },
  { value: 'approved', label: 'approved' },
];

/** Pipeline-level settings: what decides the run, and what blocks the save. */
export default function PipelineSheet({
  draft,
  issues,
  saving,
  savedAt,
  open,
  onClose,
  onAcceptanceKind,
  onAcceptancePhase,
  onAcceptanceFlag,
  onIsolation,
}: {
  draft: PipelineDef;
  issues: ValidationIssue[];
  saving: boolean;
  savedAt: string;
  open: boolean;
  onClose: () => void;
  onAcceptanceKind: (kind: Acceptance['kind']) => void;
  onAcceptancePhase: (phase: string) => void;
  onAcceptanceFlag: (flag: string) => void;
  onIsolation: (isolation: boolean) => void;
}): React.JSX.Element | null {
  const acceptance = draft.acceptance;
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;

  const phaseOptions: DropdownOption[] = draft.phases.map((p) => ({
    value: p.name,
    label: p.name,
  }));
  // An acceptance rule can outlive the phase it names; keep the dangling target
  // visible so the operator can see what to fix instead of a silent reset.
  if ('phase' in acceptance && !draft.phases.some((p) => p.name === acceptance.phase)) {
    phaseOptions.push({ value: acceptance.phase, label: `${acceptance.phase} (missing)` });
  }

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      label="Pipeline settings"
      eyebrow="Pipeline"
      title={<p className={styles.title}>{draft.name}</p>}
      footer={
        <>
          <SaveState saving={saving} savedAt={savedAt} />
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className={styles.sections}>
        <section className={styles.section}>
          <div className={styles.fieldLabel}>
            <span className={styles.fieldName}>Acceptance</span>
            <span className={styles.fieldHint}>4 kinds</span>
          </div>
          <Dropdown
            aria-label="Acceptance rule"
            value={acceptance.kind}
            options={KIND_OPTIONS}
            onChange={(v) => onAcceptanceKind(v as Acceptance['kind'])}
          />
          <p className={styles.optionDescription}>
            {ACCEPTANCE_OPTIONS.find((o) => o.value === acceptance.kind)?.description}
          </p>

          {'phase' in acceptance && (
            <div className={styles.targetRow}>
              <div
                className={
                  acceptance.kind === 'phase_flag' ? styles.targetPhaseNarrow : styles.targetPhase
                }
              >
                <div className={styles.fieldLabel}>
                  <span className={styles.fieldName}>Phase</span>
                </div>
                <Dropdown
                  aria-label="Acceptance phase"
                  value={acceptance.phase}
                  options={phaseOptions}
                  onChange={onAcceptancePhase}
                />
              </div>

              {acceptance.kind === 'phase_flag' && (
                <div>
                  <div className={styles.fieldLabel}>
                    <span className={styles.fieldName}>Flag</span>
                  </div>
                  <Dropdown
                    aria-label="Acceptance flag"
                    value={acceptance.flag}
                    options={FLAG_OPTIONS}
                    onChange={onAcceptanceFlag}
                  />
                </div>
              )}
            </div>
          )}

          <p className={styles.reading}>{acceptanceReads(draft)}</p>
        </section>

        <section className={styles.section}>
          <div className={styles.fieldLabel}>
            <span className={styles.fieldName}>Execution</span>
          </div>
          <Toggle
            checked={draft.isolation !== false}
            onChange={onIsolation}
            label="Isolated worktree"
            hint="Every run gets its own git worktree and branch."
          />
        </section>

        <section className={styles.section}>
          <div className={styles.fieldLabel}>
            <span className={styles.fieldName}>Validation</span>
            <span className={styles.fieldHint}>{issues.length} total</span>
          </div>
          <div className={styles.countRow}>
            <IssueCount errors={errors} warnings={warnings} />
          </div>
          <div className={styles.issueList}>
            {issues.length > 0 ? (
              issues.map((issue, i) => (
                <IssueLine key={`${issue.where}-${issue.message}-${i}`} issue={issue} showWhere />
              ))
            ) : (
              <p className={styles.noIssues}>No issues. This pipeline saves as written.</p>
            )}
          </div>
        </section>
      </div>
    </SideSheet>
  );
}
