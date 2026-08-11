/**
 * PipelinesScreen — the pipeline workbench.
 *
 * A slim command bar switches pipelines and carries the destructive actions,
 * so the page below it belongs entirely to the thing being edited: a vertical
 * phase ladder with a flow gutter (the centre of the screen) and a docked
 * inspector for whichever phase is selected. Ordering and removal live on the
 * rung; the fields live in the dock; the outcome rule and the live validation
 * read as prose rather than as a row of controls.
 *
 * Everything still saves itself — there is no Save button, and there never was.
 */
import { useId, useMemo } from 'react';
import type { Acceptance, PipelineDef } from '@shared/types.js';
import { useApp } from '../stores/app.js';
import { phaseKindColor, KIND_LABEL } from '../derive.js';
import {
  acceptanceSummary,
  issuePhaseIndex,
  phaseComposition,
  validationSummary,
} from '../pipeline-view.js';
import EmptyState from '../components/EmptyState.js';
import PhaseEditor from '../components/PhaseEditor.js';
import PhaseLadder from '../components/PhaseLadder.js';
import { PhaseGlyph } from '../components/PhaseGlyphs.js';
import DryRunSheet from '../components/DryRunSheet.js';
import { usePipelineDraft } from '../hooks/usePipelineDraft.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown, type DropdownOption } from '../components/ui/Dropdown.js';
import styles from './PipelinesScreen.module.css';

const ACCEPTANCE_OPTIONS: DropdownOption[] = [
  {
    value: 'all_phases_pass',
    label: 'Every phase passed',
    description: 'The run is accepted only when every phase ends in success.',
  },
  {
    value: 'last_phase_pass',
    label: 'The last phase passed',
    description: "Only the final phase's status decides acceptance.",
  },
  {
    value: 'envelope_status',
    label: "A phase's envelope reports success",
    description: "Accepted when a chosen phase's envelope status is success.",
  },
  {
    value: 'phase_flag',
    label: "A phase's envelope sets a flag",
    description: 'Accepted when a chosen phase sets passed or approved.',
  },
];

function pipelineHue(pipeline: PipelineDef, agentColor: (name: string | null) => string): string {
  const firstAgent = pipeline.phases.find((p) => p.kind === 'agent' && p.agent);
  if (firstAgent?.agent) return agentColor(firstAgent.agent);
  return 'var(--accent)';
}

export default function PipelinesScreen({
  onOpenSettings,
}: {
  onOpenSettings?: (pane: string) => void;
} = {}): React.JSX.Element {
  const { agentColor } = useApp();
  const {
    pipelines,
    selected,
    selectedId,
    draft,
    agents,
    commandNames,
    projectId,
    issues,
    activePhase,
    setActivePhase,
    dryRun,
    dryRunError,
    closeDryRun,
    setDraft,
    selectPipeline,
    createPipeline,
    duplicate,
    remove,
    preview,
    addPhase,
    movePhase,
    removePhase,
    updatePhase,
    setAcceptanceKind,
    setAcceptancePhase,
    setAcceptanceFlag,
    setIsolation,
    acceptancePhase,
  } = usePipelineDraft();
  const dockId = useId();

  const status = useMemo(
    () => validationSummary(issues, { hasProject: !!projectId }),
    [issues, projectId],
  );

  const switcherOptions = useMemo<DropdownOption[]>(
    () =>
      pipelines.map((p) => ({
        value: p.id,
        label: p.name,
        description: p.description || phaseComposition(p.phases),
        icon: (
          <span
            className={styles.switchCount}
            style={{ ['--hue' as string]: pipelineHue(p, agentColor) }}
          >
            {p.phases.length}
          </span>
        ),
      })),
    [pipelines, agentColor],
  );

  const phases = draft?.phases ?? [];
  const activeIndex = activePhase;
  const activeDef = activeIndex >= 0 ? phases[activeIndex] : undefined;
  const activeHue = activeDef
    ? phaseKindColor(activeDef.kind, agentColor(activeDef.agent ?? null))
    : 'var(--accent)';

  return (
    <div className={styles.pipelineScreen}>
      {/* ── command bar: switch, then act. The page below is the pipeline. ── */}
      <header className={styles.pipelineBar}>
        <p className="eyebrow">
          <span className="index">02</span>Pipelines
        </p>
        {pipelines.length > 0 && (
          <Dropdown
            value={selectedId}
            options={switcherOptions}
            onChange={selectPipeline}
            aria-label="Pipeline"
            className={styles.pipelineSwitchWrap}
            triggerClassName={styles.pipelineSwitch}
            placeholder="Select a pipeline"
          />
        )}
        {draft && (
          <span className={styles.pipelineBarSpec}>
            {draft.phases.length} phase{draft.phases.length === 1 ? '' : 's'}
            <span className={styles.pipelineBarDot} aria-hidden />
            {phaseComposition(draft.phases)}
            {draft.builtin && (
              <>
                <span className={styles.pipelineBarDot} aria-hidden />
                shipped
              </>
            )}
          </span>
        )}
        <div className={styles.pipelineBarActions}>
          {draft && (
            <button
              type="button"
              className={styles.pipelineAction}
              disabled={!projectId}
              title={!projectId ? 'Select a project first' : undefined}
              onClick={() => void preview()}
            >
              Dry run
            </button>
          )}
          {selected && (
            <button
              type="button"
              className={styles.pipelineAction}
              onClick={() => void duplicate()}
            >
              Duplicate
            </button>
          )}
          {selected && !selected.builtin && (
            <button
              type="button"
              className={`${styles.pipelineAction} ${styles.danger}`}
              onClick={() => void remove()}
            >
              Delete
            </button>
          )}
          <button
            type="button"
            className={`${styles.pipelineAction} ${styles.accent}`}
            onClick={() => void createPipeline()}
          >
            New pipeline
          </button>
        </div>
      </header>

      {draft && (
        <div className={styles.pipelineWork}>
          {/* ── blueprint: identity, the ladder, and what accepting means ── */}
          <section className={styles.pipelineBlueprint} aria-label="Pipeline">
            <div className={styles.pipelineIdentity}>
              <input
                className={styles.pipelineTitle}
                aria-label="Pipeline name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <input
                className={styles.pipelineDesc}
                aria-label="Pipeline description"
                value={draft.description}
                placeholder="What is this pipeline for?"
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </div>

            <PhaseLadder
              phases={draft.phases}
              agents={agents}
              agentColor={agentColor}
              acceptance={draft.acceptance}
              issues={issues}
              selected={activeIndex}
              panelId={dockId}
              onSelect={setActivePhase}
              onMove={movePhase}
              onRemove={removePhase}
              onAdd={addPhase}
            />

            <section className={styles.pipelineOutcome} aria-label="Outcome">
              <p className="eyebrow">
                <span className="index">03</span>Outcome
              </p>
              <p className={styles.pipelineOutcomeRead}>
                {acceptanceSummary(draft.acceptance, draft.phases)}
              </p>
              <div className={styles.pipelineOutcomeControls}>
                <label className={styles.pipelineField}>
                  <span className={styles.pipelineFieldLabel}>A run counts as accepted when</span>
                  <Dropdown
                    value={draft.acceptance.kind}
                    options={ACCEPTANCE_OPTIONS}
                    aria-label="Acceptance rule"
                    triggerClassName={styles.pipelineSelect}
                    onChange={(next) => setAcceptanceKind(next as Acceptance['kind'])}
                  />
                </label>
                {acceptancePhase !== null && (
                  <label className={styles.pipelineField}>
                    <span className={styles.pipelineFieldLabel}>Phase</span>
                    <Dropdown
                      value={acceptancePhase}
                      options={draft.phases.map((p) => ({ value: p.name, label: p.name }))}
                      aria-label="Acceptance phase"
                      triggerClassName={styles.pipelineSelect}
                      onChange={setAcceptancePhase}
                    />
                  </label>
                )}
                {draft.acceptance.kind === 'phase_flag' && (
                  <label className={`${styles.pipelineField} ${styles.pipelineFieldNarrow}`}>
                    <span className={styles.pipelineFieldLabel}>Flag</span>
                    <Dropdown
                      value={(draft.acceptance as { flag: string }).flag}
                      options={[
                        { value: 'passed', label: 'passed' },
                        { value: 'approved', label: 'approved' },
                      ]}
                      aria-label="Acceptance flag"
                      triggerClassName={styles.pipelineSelect}
                      onChange={(next) => setAcceptanceFlag(next as 'passed' | 'approved')}
                    />
                  </label>
                )}
              </div>
              <label className={styles.pipelineWorktree}>
                <input
                  type="checkbox"
                  checked={draft.isolation !== false}
                  onChange={(e) => setIsolation(e.target.checked)}
                />
                <span>
                  <span className={styles.pipelineWorktreeTitle}>Isolated git worktree</span>
                  <span className={styles.pipelineFieldHint}>
                    Each run gets its own checkout, so phases never touch your working tree.
                  </span>
                </span>
              </label>
            </section>
          </section>

          {/* ── dock: the selected rung, opened up ── */}
          <aside
            className={styles.pipelineDock}
            style={{ ['--hue' as string]: activeHue }}
            id={dockId}
            role="tabpanel"
            aria-labelledby={activeIndex >= 0 ? `${dockId}-tab-${activeIndex}` : undefined}
            tabIndex={-1}
          >
            {activeDef ? (
              <>
                <div className={styles.pipelineDockHead}>
                  <span className={styles.pipelineDockIndex}>
                    {String(activeIndex + 1).padStart(2, '0')}
                  </span>
                  <span className={styles.pipelineDockIcon}>
                    <PhaseGlyph kind={activeDef.kind} />
                  </span>
                  <span className={styles.pipelineDockName}>{activeDef.name}</span>
                  <span className={styles.pipelineDockKind}>{KIND_LABEL[activeDef.kind]}</span>
                </div>
                <div className={styles.pipelineDockBody}>
                  <PhaseEditor
                    key={activeIndex}
                    phase={activeDef}
                    index={activeIndex}
                    phases={draft.phases}
                    agents={agents}
                    commands={commandNames}
                    onChange={(next) => updatePhase(activeIndex, next)}
                    onOpenSettings={onOpenSettings}
                  />
                </div>
              </>
            ) : (
              <p className={styles.pipelineDockEmpty}>
                Select a phase to edit it. Nothing runs until this pipeline has at least one.
              </p>
            )}
          </aside>
        </div>
      )}

      {draft && (
        <div className={styles.pipelineStatus}>
          <span className={`${styles.pipelineStatusPill} ${styles[status.tone]}`}>
            {status.label}
          </span>
          <span className={styles.pipelineStatusDetail}>{status.detail}</span>
          <div className={styles.pipelineStatusIssues}>
            {[...status.errors, ...status.warnings].map((issue, i) => {
              const target = issuePhaseIndex(issue.where);
              return (
                <button
                  key={i}
                  type="button"
                  className={`${styles.pipelineIssue} ${styles[issue.level]}`}
                  disabled={target == null}
                  title={target == null ? undefined : 'Open this phase'}
                  onClick={() => target != null && setActivePhase(target)}
                >
                  <strong>{issue.where}</strong>
                  {issue.message}
                </button>
              );
            })}
            {dryRunError && (
              <span className={`${styles.pipelineIssue} ${styles.error}`}>{dryRunError}</span>
            )}
          </div>
          <span className={styles.pipelineAutosave}>Changes save automatically</span>
        </div>
      )}

      {!draft && (
        <div className={styles.pipelineEmpty}>
          <EmptyState
            art="scenes/empty-state.png"
            title={pipelines.length ? 'No pipeline selected' : 'No pipelines yet'}
            body={
              pipelines.length
                ? 'Pick a pipeline from the switcher or create a new one. Pipelines are data — reorder phases, swap agents, and it saves as you go.'
                : 'This workspace has no pipelines. Create one to define how agents should work together.'
            }
          >
            <Button variant="primary" onClick={() => void createPipeline()}>
              New pipeline
            </Button>
          </EmptyState>
        </div>
      )}
      {dryRun && <DryRunSheet prompts={dryRun} onClose={closeDryRun} />}
    </div>
  );
}
