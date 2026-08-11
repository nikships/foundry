/**
 * PipelinesScreen — the stage board.
 *
 * Columns are the phases that run unattended; the element between two columns
 * is the checkpoint that closes the earlier one. The board owns the whole
 * viewport height: everything that is not the board (pipeline settings,
 * acceptance, validation, phase fields) opens in one slide-over sheet so the
 * board behind it stays whole.
 *
 * Key interactions:
 * - Pill tablist in the top bar for fast pipeline switching
 * - In-place editing of pipeline name and description
 * - Horizontal canvas with auto-grouped stages and checkpoint gates
 * - Phase sheet for deep editing, pipeline sheet for acceptance and validation
 * - Debounced auto-save, live validation, and dry-run preview
 */
import { useCallback, useState } from 'react';
import { Play, Plus, SlidersHorizontal } from 'lucide-react';
import { useApp } from '../stores/app.js';
import { KIND_LABEL } from '../derive.js';
import { acceptanceLabel, issuePhaseIndex, phaseComposition } from '../pipeline-view.js';
import { usePipelineDraft } from '../hooks/usePipelineDraft.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import EmptyState from '../components/EmptyState.js';
import PhaseEditor from '../components/PhaseEditor.js';
import PipelineSheet from '../components/PipelineSheet.js';
import StageBoard from '../components/StageBoard.js';
import DryRunSheet from '../components/DryRunSheet.js';
import { Button } from '../components/ui/Button.js';
import { IssueCount } from '../components/ui/Issues.js';
import { SaveState } from '../components/ui/SaveState.js';
import { SideSheet } from '../components/ui/SideSheet.js';
import styles from './PipelinesScreen.module.css';

type Sheet = 'phase' | 'pipeline' | null;

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
  const {
    pipelines,
    selectedId,
    draft,
    commandNames,
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
    movePhaseToNewStage,
    removePhase,
    updatePhase,
    updateDraft,
    setAcceptanceKind,
    setAcceptancePhase,
    setAcceptanceFlag,
    setIsolation,
  } = usePipelineDraft({ openPipeline, openNonce });

  const [sheet, setSheet] = useState<Sheet>(null);
  const tablistNav = useTablistNav();

  const closeSheet = useCallback(() => setSheet(null), []);

  const openPhase = useCallback(
    (index: number) => {
      setActivePhase(index);
      setSheet('phase');
    },
    [setActivePhase],
  );

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

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  const activePhaseObj = activePhase !== null ? (draft.phases[activePhase] ?? null) : null;

  return (
    <div className={styles.container}>
      {/* ── Pipeline switcher ───────────────────────────────────────── */}
      <header className={styles.topBar}>
        <span className="eyebrow">Pipelines</span>

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
                onClick={() => {
                  closeSheet();
                  void selectPipeline(p.id);
                }}
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
            onClick={() => {
              closeSheet();
              void createPipeline();
            }}
          >
            <Plus size={14} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>

        <div className={styles.topBarRight}>
          <SaveState saving={saving} savedAt={savedAt} />

          <button
            type="button"
            className={styles.issueCountBtn}
            title="Open pipeline settings and validation"
            onClick={() => setSheet('pipeline')}
          >
            <IssueCount errors={errors} warnings={warnings} />
            <span className={styles.srOnly}>Open pipeline settings and validation</span>
          </button>

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

      {/* ── Identity header ─────────────────────────────────────────── */}
      <section className={styles.identityHeader}>
        <div className={styles.identityInputs}>
          <input
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
            className={`${styles.metaChip} ${draft.isolation !== false ? styles.metaChipGreen : ''}`}
          >
            {draft.isolation !== false ? 'isolated worktree' : 'runs in place'}
          </span>
          <Button
            size="sm"
            onClick={() => setSheet('pipeline')}
            title={acceptanceLabel(draft.acceptance)}
          >
            <SlidersHorizontal size={12} strokeWidth={1.6} aria-hidden="true" />
            Acceptance
          </Button>
          <Button size="sm" disabled={draft.phases.length === 0} onClick={() => void preview()}>
            <Play size={12} strokeWidth={1.6} aria-hidden="true" />
            Dry run
          </Button>
        </div>
      </section>

      {/* ── Stage board ─────────────────────────────────────────────── */}
      <main className={styles.boardWrap}>
        <StageBoard
          phases={draft.phases}
          selectedPhase={activePhase}
          onSelectPhase={openPhase}
          onAddPhase={(kind, at) => openPhase(insertPhase(kind, at))}
          onMovePhase={movePhase}
          onReorderPhase={reorderPhase}
          onNewStagePhase={movePhaseToNewStage}
          onRemovePhase={removePhase}
          agentColor={agentColor}
          issues={issues}
        />
      </main>

      {/* ── Sheets ──────────────────────────────────────────────────── */}
      <SideSheet
        open={sheet === 'phase' && activePhaseObj !== null && activePhase !== null}
        onClose={closeSheet}
        label={activePhaseObj ? `Edit ${activePhaseObj.name}` : 'Phase editor'}
        eyebrow={
          <>
            Phase{' '}
            <span className="index">
              {activePhase !== null ? String(activePhase + 1).padStart(2, '0') : ''}
            </span>
          </>
        }
        title={
          <p className={styles.sheetTitle}>
            {activePhaseObj?.name}{' '}
            {activePhaseObj && (
              <span className={styles.sheetTitleKind}>{KIND_LABEL[activePhaseObj.kind]}</span>
            )}
          </p>
        }
        footer={
          <>
            <SaveState saving={saving} savedAt={savedAt} />
            <Button size="sm" onClick={closeSheet}>
              Done
            </Button>
          </>
        }
      >
        {activePhaseObj && activePhase !== null && (
          <PhaseEditor
            phase={activePhaseObj}
            index={activePhase}
            phases={draft.phases}
            agents={agents}
            commands={commandNames}
            issues={issues.filter((i) => issuePhaseIndex(i.where) === activePhase)}
            onChange={(p) => updatePhase(activePhase, p)}
            onRemove={() => {
              removePhase(activePhase);
              closeSheet();
            }}
            onOpenSettings={onOpenSettings}
          />
        )}
      </SideSheet>

      <PipelineSheet
        draft={draft}
        issues={issues}
        saving={saving}
        savedAt={savedAt}
        open={sheet === 'pipeline'}
        onClose={closeSheet}
        onAcceptanceKind={setAcceptanceKind}
        onAcceptancePhase={setAcceptancePhase}
        onAcceptanceFlag={setAcceptanceFlag}
        onIsolation={setIsolation}
      />

      {dryRun && <DryRunSheet prompts={dryRun} onClose={closeDryRun} />}
    </div>
  );
}
