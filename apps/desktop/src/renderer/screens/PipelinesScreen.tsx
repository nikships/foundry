/**
 * PipelinesScreen — Magic Patterns 02 Stage Board implementation.
 *
 * Full-width Kanban-like workbench where columns are unattended execution stages
 * delimited by human checkpoint gates.
 *
 * Key interactions:
 * - Pill tablist in the top bar for fast pipeline switching
 * - In-place editing of pipeline name and description
 * - Horizontal canvas with auto-grouped stages and checkpoint gates
 * - Phase cards with reorder within stage and move across gates
 * - Slide-over drawer for deep phase editing (with Escape/backdrop dismiss)
 * - Shared acceptance & validation footer
 * - Debounced auto-save, live validation, and dry-run preview
 */
import { useCallback, useId } from 'react';
import type { Acceptance } from '@shared/types.js';
import { useApp } from '../stores/app.js';
import { acceptanceReads, phaseComposition, validationSummary } from '../pipeline-view.js';
import { usePipelineDraft } from '../hooks/usePipelineDraft.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import EmptyState from '../components/EmptyState.js';
import PhaseEditor from '../components/PhaseEditor.js';
import StageBoard from '../components/StageBoard.js';
import DryRunSheet from '../components/DryRunSheet.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown, type DropdownOption } from '../components/ui/Dropdown.js';
import styles from './PipelinesScreen.module.css';

const ACCEPTANCE_OPTIONS: DropdownOption[] = [
  { value: 'all_phases_pass', label: 'Every phase passed' },
  { value: 'last_phase_pass', label: 'The last phase passed' },
  { value: 'envelope_status', label: "A phase's envelope reports success" },
  { value: 'phase_flag', label: "A phase's envelope sets a flag" },
];

export default function PipelinesScreen({
  onOpenSettings,
  openPipeline,
  openNonce = 0,
}: {
  onOpenSettings?: (pane: string) => void;
  /** Deep link (e.g. a Smith approve): select this pipeline id when it resolves. */
  openPipeline?: string;
  /** Bumped per deep-link so re-selecting the same pipeline re-fires the effect. */
  openNonce?: number;
} = {}): React.JSX.Element {
  const { agentColor, agents } = useApp();
  const draftApi = usePipelineDraft({ openPipeline, openNonce });
  const {
    pipelines,
    selectedId,
    draft,
    commandNames,
    projectId,
    issues,
    activePhase,
    saving,
    savedAt,
    dryRun,
    closeDryRun,
    setActivePhase,
    selectPipeline,
    createPipeline,
    duplicate,
    remove,
    preview,
    insertPhase,
    movePhase,
    reorderPhase,
    removePhase,
    updatePhase,
    updateDraft,
    setAcceptanceKind,
    setAcceptancePhase,
    setAcceptanceFlag,
    setIsolation,
  } = draftApi;

  const tablistNav = useTablistNav();
  const nameId = useId();

  const handleCloseDrawer = useCallback(() => {
    setActivePhase(null);
  }, [setActivePhase]);

  useEscapeToClose(handleCloseDrawer, activePhase !== null);

  const confirmDelete = useConfirmAction(
    () =>
      `Delete "${draft?.name}"? This permanently deletes the pipeline definition. Existing runs that used this pipeline are kept in the trace.`,
    () => void remove(),
    {
      title: `Delete "${draft?.name}"?`,
      confirmLabel: 'Delete pipeline',
      variant: 'danger',
    },
  );

  if (!draft) {
    return (
      <div className={styles.emptyContainer}>
        <EmptyState
          title="No pipelines found"
          body="Create a pipeline to orchestrate bounded agent phases and command gates."
        >
          <Button onClick={() => void createPipeline()}>Create pipeline</Button>
        </EmptyState>
      </div>
    );
  }

  const phaseNames = draft.phases.map((p) => p.name);
  const phaseOptions: DropdownOption[] = phaseNames.map((name) => ({ value: name, label: name }));
  const valSummary = validationSummary(issues, { hasProject: !!projectId });
  const selectedPhaseObj = activePhase !== null ? (draft.phases[activePhase] ?? null) : null;

  return (
    <div className={styles.container}>
      {/* ── Top Pill Bar ────────────────────────────────────────────── */}
      <header className={styles.topBar}>
        <span className={styles.topEyebrow}>Pipelines</span>

        <div
          className={styles.pillList}
          role="tablist"
          aria-label="Pipelines"
          onKeyDown={tablistNav}
        >
          {pipelines.map((p) => {
            const active = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onClick={() => void selectPipeline(p.id)}
                className={`${styles.pillTab} ${active ? styles.pillTabActive : ''}`}
              >
                <span className={styles.pillName}>{p.name}</span>
                <span className={styles.pillCount}>{p.phases.length}</span>
              </button>
            );
          })}
          <button
            type="button"
            aria-label="New pipeline"
            title="Create new pipeline"
            className={styles.newPipelineBtn}
            onClick={() => void createPipeline()}
          >
            +
          </button>
        </div>

        <div className={styles.topBarRight}>
          <span className={styles.saveStateIndicator} aria-live="polite">
            <span
              className={`${styles.saveDot} ${saving ? styles.saveDotSaving : styles.saveDotSaved}`}
              aria-hidden="true"
            />
            {saving ? 'Saving…' : `Saved ${savedAt}`}
          </span>

          <span
            className={`${styles.statusBadge} ${
              valSummary.tone === 'error'
                ? styles.badgeError
                : valSummary.tone === 'warning'
                  ? styles.badgeWarning
                  : styles.badgeOk
            }`}
            title={valSummary.detail}
          >
            {valSummary.label}
          </span>

          <div className={styles.pipelineActions}>
            <button
              type="button"
              className={styles.actionGhostBtn}
              onClick={() => void duplicate()}
            >
              Duplicate
            </button>
            {pipelines.length > 1 && (
              <button
                type="button"
                className={`${styles.actionGhostBtn} ${styles.actionDanger}`}
                onClick={() => void confirmDelete()}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Identity Header ─────────────────────────────────────────── */}
      <section className={styles.identityHeader}>
        <div className={styles.identityInputs}>
          <input
            id={nameId}
            aria-label="Pipeline name"
            className={styles.nameInput}
            value={draft.name}
            onChange={(e) => updateDraft({ name: e.target.value })}
            placeholder="Pipeline name"
          />
          <input
            aria-label="Pipeline description"
            className={styles.descInput}
            value={draft.description}
            onChange={(e) => updateDraft({ description: e.target.value })}
            placeholder="One sentence on what this pipeline is for."
          />
        </div>

        <div className={styles.identityMeta}>
          {draft.builtin ? (
            <span className={styles.metaChip}>builtin</span>
          ) : (
            <span className={`${styles.metaChip} ${styles.metaChipAccent}`}>edited</span>
          )}
          <span className={styles.metaChip}>{phaseComposition(draft.phases)}</span>
          <span
            className={styles.metaChip}
            style={{ color: draft.isolation ? 'var(--green)' : 'var(--text-faint)' }}
          >
            {draft.isolation ? 'isolated worktree' : 'runs in place'}
          </span>
          <Button size="sm" onClick={() => void preview()}>
            ▶ Dry run
          </Button>
        </div>
      </section>

      {/* ── Stage Board ─────────────────────────────────────────────── */}
      <main className={styles.boardWrap}>
        <StageBoard
          phases={draft.phases}
          selectedPhase={activePhase}
          onSelectPhase={(idx) => setActivePhase(idx)}
          onAddPhase={(kind, at) => insertPhase(kind, at)}
          onMovePhase={(idx, delta) => movePhase(idx, delta)}
          onReorderPhase={(from, to) => reorderPhase(from, to)}
          onRemovePhase={(idx) => removePhase(idx)}
          agentColor={agentColor}
          issues={issues}
        />
      </main>

      {/* ── Acceptance & Validation Footer ──────────────────── */}
      <footer className={styles.footerSection}>
        <div className={styles.acceptanceColumn}>
          <span className={styles.sectionEyebrow}>Acceptance</span>
          <div className={styles.acceptanceControls}>
            <div className={styles.acceptanceDropdownWrap}>
              <Dropdown
                value={draft.acceptance.kind}
                options={ACCEPTANCE_OPTIONS}
                onChange={(v) => setAcceptanceKind(v as Acceptance['kind'])}
              />
            </div>

            {'phase' in draft.acceptance && (
              <div className={styles.acceptanceSubDropdown}>
                <Dropdown
                  value={draft.acceptance.phase}
                  options={phaseOptions}
                  onChange={(p) => setAcceptancePhase(p)}
                />
              </div>
            )}

            {draft.acceptance.kind === 'phase_flag' && (
              <div className={styles.acceptanceFlagDropdown}>
                <Dropdown
                  value={draft.acceptance.flag}
                  options={[
                    { value: 'passed', label: 'passed' },
                    { value: 'approved', label: 'approved' },
                  ]}
                  onChange={(f) => setAcceptanceFlag(f)}
                />
              </div>
            )}
          </div>

          <p className={styles.acceptanceReading}>{acceptanceReads(draft)}</p>

          <div className={styles.isolationWrap}>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={draft.isolation !== false}
                onChange={(e) => setIsolation(e.target.checked)}
                className={styles.toggleCheckbox}
              />
              <div>
                <span className={styles.toggleTitle}>Isolated worktree</span>
                <span className={styles.toggleDesc}>
                  Every run gets its own git worktree and branch.
                </span>
              </div>
            </label>
          </div>
        </div>

        <div className={styles.validationColumn}>
          <div className={styles.validationHeader}>
            <span className={styles.sectionEyebrow}>Validation</span>
            <span className={styles.issueCountsHint}>
              {valSummary.errors.length} errors · {valSummary.warnings.length} warnings
            </span>
          </div>

          <div className={styles.validationIssuesList}>
            {issues.length > 0 ? (
              issues.map((issue, i) => {
                const isErr = issue.level === 'error';
                return (
                  <div
                    key={`${issue.where}-${issue.message}-${i}`}
                    className={`${styles.issueRow} ${isErr ? styles.issueRowErr : styles.issueRowWarn}`}
                  >
                    <span
                      className={`${styles.issuePill} ${
                        isErr ? styles.issuePillErr : styles.issuePillWarn
                      }`}
                    >
                      {isErr ? 'ERR' : 'WARN'}
                    </span>
                    <span className={styles.issueMessage}>
                      {issue.where && (
                        <strong className={styles.issueWhere}>{issue.where} — </strong>
                      )}
                      {issue.message}
                    </span>
                  </div>
                );
              })
            ) : (
              <p className={styles.noIssuesText}>No issues. This pipeline saves as written.</p>
            )}
          </div>
        </div>
      </footer>

      {/* ── Slide-Over Phase Drawer ─────────────────────────────────── */}
      {selectedPhaseObj && activePhase !== null && (
        <div className={styles.drawerOverlay} onClick={handleCloseDrawer}>
          <aside
            className={styles.drawerPanel}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Edit ${selectedPhaseObj.name}`}
          >
            <div className={styles.drawerHeader}>
              <div className={styles.drawerTitleGroup}>
                <span className={styles.drawerEyebrow}>Phase</span>
                <h2 className={styles.drawerPhaseName}>{selectedPhaseObj.name}</h2>
              </div>
              <button
                type="button"
                className={styles.drawerCloseBtn}
                aria-label="Close drawer"
                onClick={handleCloseDrawer}
              >
                ✕
              </button>
            </div>

            <div className={styles.drawerBody}>
              <PhaseEditor
                phase={selectedPhaseObj}
                index={activePhase}
                phases={draft.phases}
                agents={agents}
                commands={commandNames}
                onChange={(p) => updatePhase(activePhase, p)}
                onRemove={() => {
                  removePhase(activePhase);
                }}
                onOpenSettings={onOpenSettings}
              />
            </div>

            <div className={styles.drawerFooter}>
              <span className={styles.saveStateIndicator}>
                <span
                  className={`${styles.saveDot} ${
                    saving ? styles.saveDotSaving : styles.saveDotSaved
                  }`}
                  aria-hidden="true"
                />
                {saving ? 'Saving…' : `Saved ${savedAt}`}
              </span>
              <Button size="sm" onClick={handleCloseDrawer}>
                Done
              </Button>
            </div>
          </aside>
        </div>
      )}

      {/* ── Modals ─────────────────────────────────────────────────── */}
      {dryRun && <DryRunSheet prompts={dryRun} onClose={closeDryRun} />}
    </div>
  );
}
