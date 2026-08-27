import { CircleDot, Sparkles, Workflow } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ReadinessInspectResult, ValidationIssue } from '@shared/types.js';
import type { CompanionHostState } from '@shared/companion.js';
import type { LinearConnectionState } from '@shared/ipc-contract.js';
import { api } from '../api.js';
import type { OrchestratorPlanController } from '../hooks/useOrchestratorPlan.js';
import { useApp } from '../stores/app.js';
import { safeGetItem, safeSetItem } from '../utils/local-store.js';
import EmptyState from '../components/common/EmptyState.js';
import BaseSyncBar from '../components/project/BaseSyncBar.js';
import PanelTranscript from '../components/readiness/PanelTranscript.js';
import LinearComposer from '../components/run/LinearComposer.js';
import ManualComposer from '../components/run/ManualComposer.js';
import OrchestratorPicker, {
  type OrchestratorChoice,
} from '../components/run/OrchestratorPicker.js';
import PlanCard from '../components/run/PlanCard.js';
import { Button } from '../components/ui/Button.js';
import { readinessBanner, showReadinessOnRuns } from '../view-models/readiness-view.js';
import styles from './RunsScreen.module.css';

const MODE_KEY = 'foundry.runs.mode';
type RunsMode = 'orchestrator' | 'manual' | 'linear';

function loadMode(): RunsMode {
  const saved = safeGetItem(MODE_KEY);
  return saved === 'manual' || saved === 'linear' ? saved : 'orchestrator';
}

function companionPill(companion: CompanionHostState): {
  title: string;
  label: string;
  dot: string;
} {
  if (!companion.running) {
    return {
      title: 'Companion host is off · Click to open Settings',
      label: 'Phone off',
      dot: styles.dotFaint,
    };
  }
  if (!companion.devices.length) {
    return {
      title: `Companion host active · Waiting for a phone to scan QR (${companion.origin})`,
      label: 'Pair phone',
      dot: styles.dotOrange,
    };
  }
  return {
    title: `Companion host active · Paired to ${companion.devices.map((device) => device.name).join(', ')}`,
    label:
      companion.devices.length === 1
        ? companion.devices[0]!.name
        : `${companion.devices.length} phones`,
    dot: styles.dotGreen,
  };
}

function RunsHeader({
  companion,
  onOpenSettings,
}: {
  companion: CompanionHostState | null;
  onOpenSettings?: (pane: string) => void;
}): React.JSX.Element {
  const pill = companion ? companionPill(companion) : null;
  return (
    <header className={styles.head}>
      <p className="eyebrow">
        <span className="index">01</span>Runs
      </p>
      {companion && pill && (
        <button
          type="button"
          className={styles.phonePill}
          onClick={() => onOpenSettings?.('general')}
          data-testid="companion-pill"
          data-running={companion.running ? 'true' : 'false'}
          title={pill.title}
        >
          <span className={`${styles.phoneDot} ${pill.dot}`} />
          <span className="mono">{pill.label}</span>
        </button>
      )}
    </header>
  );
}

function SourceTabs({
  mode,
  linearConnection,
  onChange,
}: {
  mode: RunsMode;
  linearConnection: LinearConnectionState | null;
  onChange: (mode: RunsMode) => void;
}): React.JSX.Element {
  const tabs: ReadonlyArray<{
    id: RunsMode;
    label: string;
    icon: React.JSX.Element;
  }> = [
    { id: 'orchestrator', label: 'Orchestrator', icon: <Sparkles size={11} /> },
    { id: 'manual', label: 'Manual pipeline', icon: <Workflow size={11} /> },
    { id: 'linear', label: 'Linear issue', icon: <CircleDot size={11} /> },
  ];
  return (
    <div className={styles.composerHead}>
      <div className={styles.sourceTabs} role="tablist" aria-label="Run source">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className={mode === tab.id ? styles.sourceTabActive : undefined}
            aria-selected={mode === tab.id}
            onClick={() => onChange(tab.id)}
            data-testid={`runs-source-${tab.id}`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>
      {mode === 'linear' && (
        <span className={styles.linearConnection}>
          <span
            className={`${styles.linearDot} ${
              linearConnection?.keySet ? styles.linearDotConnected : ''
            }`}
          />
          {linearConnection?.keySet ? 'Linear connected' : 'Linear not connected'}
        </span>
      )}
    </div>
  );
}

function OrchestratedComposer({
  header,
  request,
  choice,
  orchestrator,
  onChoiceChange,
  onRequestChange,
  onOpen,
  baseSyncing,
}: {
  header: ReactNode;
  request: string;
  choice: OrchestratorChoice;
  orchestrator: OrchestratorPlanController;
  onChoiceChange: (choice: OrchestratorChoice) => void;
  onRequestChange: (request: string) => void;
  onOpen: (runId: string) => void;
  baseSyncing: boolean;
}): React.JSX.Element {
  const { project, projectId, refreshAll } = useApp();
  const [starting, setStarting] = useState(false);
  const [startIssues, setStartIssues] = useState<ValidationIssue[]>([]);
  const composeBlocked = !project
    ? 'Add a project first'
    : !request.trim()
      ? 'Describe what to build'
      : baseSyncing
        ? `Updating ${project.baseRef} first`
        : null;

  const submitPlan = (): void => {
    if (composeBlocked || orchestrator.planningLive) return;
    setStartIssues([]);
    void orchestrator.submit(request);
  };

  const startFromPlan = async (): Promise<void> => {
    if (!orchestrator.plan || starting || baseSyncing) return;
    setStarting(true);
    setStartIssues([]);
    try {
      const result = await api.runs.start({
        projectId,
        pipelineId: orchestrator.plan.pipeline.id,
        request: orchestrator.plan.refinedRequest,
        plan: orchestrator.plan,
      });
      if (!result.ok) {
        setStartIssues(result.issues);
        await refreshAll();
        return;
      }
      onRequestChange('');
      orchestrator.discard();
      await refreshAll();
      if (result.runId) onOpen(result.runId);
    } catch (error) {
      setStartIssues([{ level: 'error', where: 'start', message: (error as Error).message }]);
    } finally {
      setStarting(false);
    }
  };

  const onRequestKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      submitPlan();
    }
  };

  return (
    <div className={styles.composerColumn}>
      <section className={`${styles.composerCard} card`} data-testid="run-composer">
        {header}
        {orchestrator.stage === 'compose' && (
          <h1 className={styles.composerTitle}>What should the factory build?</h1>
        )}
        <textarea
          className={`textarea ${styles.request}`}
          value={request}
          onChange={(event) => onRequestChange(event.target.value)}
          rows={orchestrator.stage === 'compose' ? 4 : 2}
          placeholder="Describe the change. The Orchestrator rewrites it into a full brief and composes the pipeline."
          onKeyDown={onRequestKeyDown}
          aria-label="Run request"
          data-testid="run-request"
        />
        <div className={styles.composerControls}>
          <OrchestratorPicker
            choice={choice}
            disabled={orchestrator.planningLive}
            onChange={onChoiceChange}
          />
          <Button
            variant="primary"
            className={styles.planButton}
            disabled={Boolean(composeBlocked) || orchestrator.planningLive}
            title={composeBlocked ?? undefined}
            onClick={submitPlan}
            data-testid="run-plan"
          >
            {orchestrator.stage === 'ready'
              ? 'Regenerate plan'
              : orchestrator.planningLive
                ? 'Planning…'
                : 'Plan run'}
            {!composeBlocked && !orchestrator.planningLive && <kbd>⌘↵</kbd>}
          </Button>
        </div>
        {composeBlocked && orchestrator.stage === 'compose' && (
          <p className={styles.hintLine}>{composeBlocked}</p>
        )}
        {orchestrator.planError && (
          <p className={styles.planError} role="alert">
            {orchestrator.planError}
          </p>
        )}
      </section>

      {orchestrator.stage === 'planning' && (
        <section className={`${styles.planning} card`} data-testid="planning-panel">
          <div className={styles.planningHead}>
            <span className={styles.planningTitle}>
              {orchestrator.planning?.status === 'failed'
                ? 'Planning failed'
                : 'The Orchestrator is planning'}
            </span>
            <span className={styles.planningDetail}>
              {orchestrator.planning?.detail ?? 'Opening the planning session…'}
            </span>
            {orchestrator.planningLive && !orchestrator.requestingPlan && (
              <Button size="sm" variant="ghost" onClick={orchestrator.cancel}>
                Cancel
              </Button>
            )}
            {orchestrator.planning?.status === 'failed' && (
              <Button size="sm" onClick={submitPlan}>
                Try again
              </Button>
            )}
          </div>
          <PanelTranscript
            entries={orchestrator.planning?.entries ?? []}
            live={orchestrator.planningLive}
          />
        </section>
      )}

      {orchestrator.stage === 'ready' && orchestrator.plan && orchestrator.original && (
        <PlanCard
          plan={orchestrator.plan}
          original={orchestrator.original}
          starting={starting}
          startBlocked={baseSyncing ? `Updating ${project?.baseRef ?? 'base branch'} first` : null}
          issues={startIssues}
          onPhaseModelChange={orchestrator.setPhaseModel}
          onResetModels={orchestrator.resetModels}
          onStart={() => void startFromPlan()}
          onRegenerate={submitPlan}
          onDiscard={() => {
            orchestrator.discard();
            setStartIssues([]);
          }}
        />
      )}
    </div>
  );
}

export default function RunsScreen({
  request,
  onRequestChange,
  orchestratorChoice,
  onOrchestratorChoiceChange,
  orchestrator,
  onOpen,
  onAddProject,
  onNewProject,
  onOpenSettings,
}: {
  request: string;
  onRequestChange: (request: string) => void;
  orchestratorChoice: OrchestratorChoice;
  onOrchestratorChoiceChange: (choice: OrchestratorChoice) => void;
  orchestrator: OrchestratorPlanController;
  onOpen: (runId: string) => void;
  onAddProject?: () => void;
  /** Create a repository on GitHub instead of pointing at an existing checkout. */
  onNewProject?: () => void;
  onOpenSettings?: (pane: string) => void;
}): React.JSX.Element {
  const { project, projectId } = useApp();
  const [mode, setMode] = useState<RunsMode>(loadMode);
  const [linearConnection, setLinearConnection] = useState<LinearConnectionState | null>(null);
  const [readiness, setReadiness] = useState<ReadinessInspectResult | null>(null);
  const [baseSyncing, setBaseSyncing] = useState(false);
  const [companion, setCompanion] = useState<CompanionHostState | null>(null);

  useEffect(() => {
    void api.companion.state().then(setCompanion);
    return api.on('companion-changed', () => {
      void api.companion.state().then(setCompanion);
    });
  }, []);

  useEffect(() => {
    if (!projectId) {
      setReadiness(null);
      return;
    }
    let cancelled = false;
    void api.readiness.inspect(projectId).then((next) => {
      if (!cancelled) setReadiness(next);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, project?.path, project?.readinessValidated, project?.readinessSkipped]);

  const banner = useMemo(() => (readiness ? readinessBanner(readiness) : null), [readiness]);
  const switchMode = (next: RunsMode): void => {
    setMode(next);
    safeSetItem(MODE_KEY, next);
  };
  const tabs = <SourceTabs mode={mode} linearConnection={linearConnection} onChange={switchMode} />;

  return (
    <div className={styles.screen}>
      <RunsHeader companion={companion} onOpenSettings={onOpenSettings} />
      {project && banner && showReadinessOnRuns(banner) && (
        <div
          className={styles.readinessBanner}
          data-testid="readiness-banner"
          data-ready="no"
          role="status"
          aria-live="polite"
        >
          <p>{banner.message}</p>
        </div>
      )}
      {project && (
        <BaseSyncBar
          projectId={project.id}
          baseRef={project.baseRef}
          onSyncingChange={setBaseSyncing}
        />
      )}
      {!project ? (
        <EmptyState
          title="No project yet"
          body="Foundry runs against a git repository. Point it at one you already have, or create a new one on GitHub."
        >
          {onAddProject && (
            <Button variant="primary" onClick={onAddProject}>
              Add a project…
            </Button>
          )}
          {onNewProject && <Button onClick={onNewProject}>Create a new project…</Button>}
        </EmptyState>
      ) : (
        <div className={styles.composerRegion}>
          {mode === 'orchestrator' && (
            <div className={styles.modePanel}>
              <OrchestratedComposer
                header={tabs}
                request={request}
                choice={orchestratorChoice}
                orchestrator={orchestrator}
                onChoiceChange={onOrchestratorChoiceChange}
                onRequestChange={onRequestChange}
                onOpen={onOpen}
                baseSyncing={baseSyncing}
              />
            </div>
          )}

          {mode === 'manual' && (
            <div className={styles.modePanel}>
              <div className={styles.composerColumn}>
                <section className={`${styles.composerCard} card`} data-testid="run-composer">
                  {tabs}
                  <ManualComposer
                    request={request}
                    onRequestChange={onRequestChange}
                    onOpen={onOpen}
                    onOpenSettings={onOpenSettings}
                    baseSyncing={baseSyncing}
                  />
                </section>
              </div>
            </div>
          )}

          <div className={styles.modePanel} hidden={mode !== 'linear'}>
            <LinearComposer
              active={mode === 'linear'}
              header={mode === 'linear' ? tabs : null}
              choice={orchestratorChoice}
              onChoiceChange={onOrchestratorChoiceChange}
              onOpen={onOpen}
              onOpenSettings={onOpenSettings}
              onConnectionChange={setLinearConnection}
              baseSyncing={baseSyncing}
            />
          </div>
        </div>
      )}
    </div>
  );
}
