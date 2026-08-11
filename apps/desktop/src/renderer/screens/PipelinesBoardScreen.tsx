/**
 * PipelinesBoardScreen — redesign Option B, the modular workbench.
 *
 * Same contracts as Option A (both are presentations of `usePipelineDraft`),
 * a deliberately different shape:
 *
 *   - pipelines switch from a pill tablist in a top bar, not a dropdown
 *   - the full width becomes a board of gate-delimited stages, not a column
 *   - deep editing happens in a slide-over over the canvas, not a docked pane
 *   - outcome and validation share one footer instead of a section plus a bar
 *
 * The organising idea is approval structure: where the run stops and who has
 * to answer. Option A's is sequence and repair loops.
 */
import { useCallback, useId, useState } from 'react';
import type { Acceptance, PhaseDef } from '@shared/types.js';
import { KIND_LABEL, phaseKindColor } from '../derive.js';
import { useApp } from '../stores/app.js';
import {
  acceptanceSummary,
  issuePhaseIndex,
  phaseComposition,
  stagesOf,
  validationSummary,
} from '../pipeline-view.js';
import { usePipelineDraft } from '../hooks/usePipelineDraft.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useTablistNav } from '../hooks/useTablistNav.js';
import EmptyState from '../components/EmptyState.js';
import PhaseEditor from '../components/PhaseEditor.js';
import StageBoard from '../components/StageBoard.js';
import { PhaseGlyph } from '../components/PhaseGlyphs.js';
import DryRunSheet from '../components/DryRunSheet.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown, type DropdownOption } from '../components/ui/Dropdown.js';
import styles from './PipelinesBoardScreen.module.css';

const ACCEPTANCE_OPTIONS: DropdownOption[] = [
  { value: 'all_phases_pass', label: 'Every phase passed' },
  { value: 'last_phase_pass', label: 'The last phase passed' },
  { value: 'envelope_status', label: "A phase's envelope reports success" },
  { value: 'phase_flag', label: "A phase's envelope sets a flag" },
];

export default function PipelinesBoardScreen({
  onOpenSettings,
}: {
  onOpenSettings?: (pane: string) => void;
} = {}): React.JSX.Element {
  const { agentColor } = useApp();
  const draftApi = usePipelineDraft();
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
    insertPhase,
    movePhase,
    reorderPhase,
    removePhase,
    updatePhase,
    setAcceptanceKind,
    setAcceptancePhase,
    setAcceptanceFlag,
    setIsolation,
    acceptancePhase,
  } = draftApi;

  const onTablistKey = useTablistNav();
  const sheetId = useId();
  // The slide-over is an overlay, not a dock: it stays shut until a card is
  // opened, so the board is never covered before the operator asks for it.
  // (Option A's inspector is docked and so is always showing something.)
  const [sheetOpen, setSheetOpen] = useState(false);
  const openPhase = useCallback(
    (index: number): void => {
      setActivePhase(index);
      setSheetOpen(true);
    },
    [setActivePhase],
  );
  const closeSheet = useCallback((): void => setSheetOpen(false), []);
  const phases = draft?.phases ?? [];
  const open = sheetOpen && activePhase >= 0 && activePhase < phases.length;
  useEscapeToClose(closeSheet, open);

  // A different pipeline is a different board; don't leave a sheet hanging
  // over it pointed at a phase that no longer exists.
  const switchPipeline = useCallback(
    (id: string): void => {
      setSheetOpen(false);
      selectPipeline(id);
    },
    [selectPipeline],
  );

  const status = validationSummary(issues, { hasProject: !!projectId });
  const activeDef = open ? phases[activePhase] : undefined;
  const activeHue = activeDef
    ? phaseKindColor(activeDef.kind, agentColor(activeDef.agent ?? null))
    : 'var(--accent)';
  const stageCount = stagesOf(phases).length;

  return (
    <div className={styles.boardScreen}>
      <header className={styles.topBar}>
        <p className="eyebrow">
          <span className="index">02</span>Pipelines
        </p>
        <div
          className={styles.pills}
          role="tablist"
          aria-label="Pipelines"
          onKeyDown={onTablistKey}
        >
          {pipelines.map((p) => {
            const on = p.id === selectedId;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                className={`${styles.pill} ${on ? styles.on : ''}`}
                onClick={() => switchPipeline(p.id)}
              >
                {p.name}
                <span className={styles.pillCount}>{p.phases.length}</span>
              </button>
            );
          })}
          <button
            type="button"
            className={styles.pillNew}
            aria-label="Create pipeline"
            title="Create pipeline"
            onClick={() => void createPipeline()}
          >
            +
          </button>
        </div>
        <div className={styles.topActions}>
          {draft && (
            <button
              type="button"
              className={styles.action}
              disabled={!projectId}
              title={!projectId ? 'Select a project first' : undefined}
              onClick={() => void preview()}
            >
              Dry run
            </button>
          )}
          {selected && (
            <button type="button" className={styles.action} onClick={() => void duplicate()}>
              Duplicate
            </button>
          )}
          {selected && !selected.builtin && (
            <button
              type="button"
              className={`${styles.action} ${styles.danger}`}
              onClick={() => void remove()}
            >
              Delete
            </button>
          )}
        </div>
      </header>

      {draft && (
        <div className={styles.titleBlock}>
          <div className={styles.titleText}>
            <input
              className={styles.title}
              aria-label="Pipeline name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
            <input
              className={styles.desc}
              aria-label="Pipeline description"
              value={draft.description}
              placeholder="What is this pipeline for?"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className={styles.chips}>
            <span className={styles.chip}>
              {stageCount} stage{stageCount === 1 ? '' : 's'}
            </span>
            <span className={styles.chip}>{phaseComposition(draft.phases)}</span>
            {draft.builtin && <span className={styles.chip}>shipped</span>}
          </div>
        </div>
      )}

      {draft && (
        <div className={styles.canvas}>
          <StageBoard
            phases={draft.phases}
            agents={agents}
            agentColor={agentColor}
            acceptance={draft.acceptance}
            issues={issues}
            selected={open ? activePhase : -1}
            onSelect={openPhase}
            onMove={movePhase}
            onMoveStage={reorderPhase}
            onRemove={removePhase}
            onAdd={(kind, at) => {
              insertPhase(kind, at);
              setSheetOpen(true);
            }}
            onAddGate={(at) => {
              insertPhase('engineer', at);
              setSheetOpen(true);
            }}
          />
        </div>
      )}

      {draft && (
        <footer className={styles.footer}>
          <div className={styles.outcome}>
            <span className={styles.footerLabel}>Outcome</span>
            <p className={styles.outcomeRead}>
              {acceptanceSummary(draft.acceptance, draft.phases)}
            </p>
            <div className={styles.outcomeControls}>
              <Dropdown
                value={draft.acceptance.kind}
                options={ACCEPTANCE_OPTIONS}
                aria-label="Acceptance rule"
                triggerClassName={styles.select}
                onChange={(next) => setAcceptanceKind(next as Acceptance['kind'])}
              />
              {acceptancePhase !== null && (
                <Dropdown
                  value={acceptancePhase}
                  options={draft.phases.map((p) => ({ value: p.name, label: p.name }))}
                  aria-label="Acceptance phase"
                  triggerClassName={styles.select}
                  onChange={setAcceptancePhase}
                />
              )}
              {draft.acceptance.kind === 'phase_flag' && (
                <Dropdown
                  value={(draft.acceptance as { flag: string }).flag}
                  options={[
                    { value: 'passed', label: 'passed' },
                    { value: 'approved', label: 'approved' },
                  ]}
                  aria-label="Acceptance flag"
                  triggerClassName={styles.select}
                  onChange={(next) => setAcceptanceFlag(next as 'passed' | 'approved')}
                />
              )}
              <label className={styles.worktree}>
                <input
                  type="checkbox"
                  checked={draft.isolation !== false}
                  onChange={(e) => setIsolation(e.target.checked)}
                />
                <span>Isolated git worktree</span>
              </label>
            </div>
          </div>

          <div className={styles.validation}>
            <span className={`${styles.statusPill} ${styles[status.tone]}`}>{status.label}</span>
            <span className={styles.statusDetail}>{status.detail}</span>
            <div className={styles.issues}>
              {[...status.errors, ...status.warnings].map((issue, i) => {
                const target = issuePhaseIndex(issue.where);
                return (
                  <button
                    key={i}
                    type="button"
                    className={`${styles.issue} ${styles[issue.level]}`}
                    disabled={target == null}
                    title={target == null ? undefined : 'Open this phase'}
                    onClick={() => target != null && openPhase(target)}
                  >
                    <strong>{issue.where}</strong>
                    {issue.message}
                  </button>
                );
              })}
              {dryRunError && (
                <span className={`${styles.issue} ${styles.error}`}>{dryRunError}</span>
              )}
            </div>
            <span className={styles.autosave}>Changes save automatically</span>
          </div>
        </footer>
      )}

      {!draft && (
        <div className={styles.empty}>
          <EmptyState
            art="scenes/empty-state.png"
            title={pipelines.length ? 'No pipeline selected' : 'No pipelines yet'}
            body={
              pipelines.length
                ? 'Pick a pipeline above or create a new one. Phases are grouped into the stages your checkpoints create.'
                : 'This workspace has no pipelines. Create one to define how agents should work together.'
            }
          >
            <Button variant="primary" onClick={() => void createPipeline()}>
              New pipeline
            </Button>
          </EmptyState>
        </div>
      )}

      {/* ── slide-over: deep editing without collapsing the canvas ── */}
      {draft && activeDef && (
        <>
          <div className={styles.scrim} onClick={closeSheet} aria-hidden />
          <aside
            className={styles.sheet}
            style={{ ['--hue' as string]: activeHue }}
            id={sheetId}
            role="dialog"
            aria-modal="false"
            aria-label={`Edit phase ${activeDef.name}`}
          >
            <header className={styles.sheetHead}>
              <span className={styles.sheetIndex}>{String(activePhase + 1).padStart(2, '0')}</span>
              <span className={styles.sheetIcon}>
                <PhaseGlyph kind={activeDef.kind} />
              </span>
              <span className={styles.sheetName}>{activeDef.name}</span>
              <span className={styles.sheetKind}>{KIND_LABEL[activeDef.kind]}</span>
              <button
                type="button"
                className={styles.sheetClose}
                aria-label="Close phase editor"
                onClick={closeSheet}
              >
                Esc
              </button>
            </header>
            <div className={styles.sheetBody}>
              <PhaseEditor
                key={activePhase}
                phase={activeDef}
                index={activePhase}
                phases={draft.phases}
                agents={agents}
                commands={commandNames}
                onChange={(next: PhaseDef) => updatePhase(activePhase, next)}
                onOpenSettings={onOpenSettings}
              />
            </div>
          </aside>
        </>
      )}

      {dryRun && <DryRunSheet prompts={dryRun} onClose={closeDryRun} />}
    </div>
  );
}
