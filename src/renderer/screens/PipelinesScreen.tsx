import { useCallback, useState } from 'react';
import { Play, Settings2 } from 'lucide-react';
import { useApp } from '../stores/app.js';
import { KIND_LABEL } from '../derive.js';
import { acceptanceLabel, issuePhaseIndex } from '../pipeline-view.js';
import { usePipelineDraft } from '../hooks/usePipelineDraft.js';
import { useConfirmAction } from '../hooks/useConfirmAction.js';
import EmptyState from '../components/EmptyState.js';
import PhaseEditor from '../components/PhaseEditor.js';
import PipelineSheet from '../components/PipelineSheet.js';
import PipelineCanvas from '../components/PipelineCanvas.js';
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
    removePhase,
    updatePhase,
    updateDraft,
    updateCanvas,
    setAcceptanceKind,
    setAcceptancePhase,
    setAcceptanceFlag,
    setIsolation,
  } = usePipelineDraft({ openPipeline, openNonce });

  const [sheet, setSheet] = useState<Sheet>(null);

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
      <header className={styles.workspaceHeader}>
        <div className={styles.pipelineIdentity}>
          <span className={styles.headerEyebrow}>Pipelines</span>
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
            placeholder="Describe this run."
          />
        </div>

        <div className={styles.headerActions}>
          <SaveState saving={saving} savedAt={savedAt} />

          <button
            type="button"
            className={styles.issueCountBtn}
            title="Open acceptance and validation settings"
            onClick={() => setSheet('pipeline')}
          >
            <IssueCount errors={errors} warnings={warnings} />
            <span className={styles.srOnly}>Open acceptance and validation settings</span>
          </button>

          <button
            type="button"
            className={styles.actionGhostBtn}
            title={acceptanceLabel(draft.acceptance)}
            onClick={() => setSheet('pipeline')}
          >
            <Settings2 size={13} strokeWidth={1.7} aria-hidden="true" />
            Settings
          </button>
          <details className={styles.moreActions}>
            <summary>More</summary>
            <div>
              <button type="button" onClick={() => void duplicate()}>
                Duplicate pipeline
              </button>
              {pipelines.length > 1 && (
                <button
                  type="button"
                  className={styles.actionDanger}
                  onClick={() => void confirmDelete()}
                >
                  Delete pipeline
                </button>
              )}
            </div>
          </details>
          <button
            type="button"
            className={styles.dryRunBtn}
            disabled={draft.phases.length === 0}
            onClick={() => void preview()}
          >
            <Play size={13} strokeWidth={1.7} aria-hidden="true" />
            Dry run
          </button>
        </div>
      </header>

      <main className={styles.boardWrap}>
        <PipelineCanvas
          pipelineId={draft.id}
          pipelines={pipelines}
          selectedPipelineId={selectedId}
          onSelectPipeline={(id) => {
            closeSheet();
            void selectPipeline(id);
          }}
          onCreatePipeline={() => {
            closeSheet();
            void createPipeline();
          }}
          phases={draft.phases}
          canvas={draft.canvas}
          selectedPhase={activePhase}
          onSelectPhase={openPhase}
          onAddPhase={(kind) => openPhase(insertPhase(kind))}
          onMovePhase={movePhase}
          onRemovePhase={removePhase}
          onCanvasChange={updateCanvas}
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
