import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReadinessInspectResult, ValidationIssue } from '@shared/types.js';
import type { OrchestratorState } from '@shared/ipc-contract.js';
import type { CompanionHostState } from '@shared/companion.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { useRunList } from '../stores/run.js';
import { since, truncate, durationClock, tokensBadge } from '../utils/format.js';
import { runDuration } from '../utils/derive.js';
import { safeGetItem, safeSetItem } from '../utils/local-store.js';
import StatusBadge from '../components/common/StatusBadge.js';
import EmptyState from '../components/common/EmptyState.js';
import BaseSyncBar from '../components/project/BaseSyncBar.js';
import PanelTranscript from '../components/readiness/PanelTranscript.js';
import ManualComposer from '../components/run/ManualComposer.js';
import OrchestratorPicker, {
  loadOrchestratorChoice,
  type OrchestratorChoice,
} from '../components/run/OrchestratorPicker.js';
import PlanCard from '../components/run/PlanCard.js';
import { Button } from '../components/ui/Button.js';
import { readinessBanner } from '../view-models/readiness-view.js';
import styles from './RunsScreen.module.css';

const MODE_KEY = 'foundry.runs.mode';
type RunsMode = 'orchestrated' | 'manual';

function loadMode(): RunsMode {
  return safeGetItem(MODE_KEY) === 'manual' ? 'manual' : 'orchestrated';
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
  const devices = companion.devices;
  if (!devices.length) {
    return {
      title: `Companion host active · Waiting for a phone to scan QR (${companion.origin})`,
      label: 'Pair phone',
      dot: styles.dotOrange,
    };
  }
  return {
    title: `Companion host active · Paired to ${devices.map((d) => d.name).join(', ')}`,
    label: devices.length === 1 ? devices[0]!.name : `${devices.length} phones`,
    dot: styles.dotGreen,
  };
}

function RunsHeader({
  companion,
  includeArchived,
  onIncludeArchived,
  onOpenSettings,
}: {
  companion: CompanionHostState | null;
  includeArchived: boolean;
  onIncludeArchived: (include: boolean) => void;
  onOpenSettings?: (pane: string) => void;
}): React.JSX.Element {
  const pill = companion ? companionPill(companion) : null;
  return (
    <header className={styles.head}>
      <p className="eyebrow">
        <span className="index">01</span>Runs
      </p>
      <div className={styles.headActions}>
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
        <label className={styles.archived}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => onIncludeArchived(event.target.checked)}
            data-testid="runs-archived"
          />
          Show archived
        </label>
      </div>
    </header>
  );
}

function RunList({
  onOpen,
  projectId,
  includeArchived,
}: {
  onOpen: (runId: string) => void;
  projectId: string;
  includeArchived: boolean;
}): React.JSX.Element {
  const {
    runs,
    loading,
    error: listError,
    refresh: refreshList,
  } = useRunList(projectId, includeArchived);

  return (
    <div className={styles.list}>
      {listError && (
        <div className={styles.listErr} role="alert">
          <span>Could not load runs: {listError}</span>
          <Button size="sm" onClick={() => void refreshList()}>
            Retry
          </Button>
        </div>
      )}
      {loading && !runs.length && !listError && (
        <p className={`${styles.listLoading} faint`}>Loading runs…</p>
      )}
      {!loading && !listError && runs.length === 0 && (
        <EmptyState
          title="Nothing has run yet"
          body="Describe a change above. Every run is isolated in its own git worktree. Missing test commands are detected automatically when you start."
        />
      )}
      {runs.map((run) => (
        <button
          key={run.runId}
          className={styles.run}
          onClick={() => onOpen(run.runId)}
          data-testid={`run-row-${run.runId}`}
          data-run-id={run.runId}
        >
          <div className={styles.runMain}>
            <div className={styles.runTop}>
              <StatusBadge status={run.status} />
              <span className={styles.pipelineName}>{run.pipelineName}</span>
              <span className={`faint ${styles.time}`}>{since(run.startedAt)}</span>
            </div>
            <p className={styles.req}>{truncate(run.request, 160)}</p>
          </div>
          <div className={styles.runMeta}>
            {run.amendments > 0 && (
              <span className={`${styles.metaBadge} ${styles.metaBadgeAmended}`}>
                amended ×{run.amendments}
              </span>
            )}
            {run.branch && (
              <span className={styles.branch} title={run.branch}>
                {run.branch.replace('foundry/', '')}
              </span>
            )}
            <span className={`${styles.metaBadge} ${styles.metaBadgeTime}`}>
              {durationClock(runDuration(run))}
            </span>
            {run.totalTokens ? (
              <span className={`${styles.metaBadge} ${styles.metaBadgeTokens}`}>
                {tokensBadge(run.totalTokens)}
              </span>
            ) : null}
          </div>
        </button>
      ))}
    </div>
  );
}

function OrchestratedComposer({
  request,
  onRequestChange,
  onOpen,
  onManual,
  includeArchived,
  baseSyncing,
}: {
  request: string;
  onRequestChange: (request: string) => void;
  onOpen: (runId: string) => void;
  onManual: () => void;
  includeArchived: boolean;
  baseSyncing: boolean;
}): React.JSX.Element {
  const { project, projectId, refreshAll } = useApp();
  const [choice, setChoice] = useState<OrchestratorChoice>(loadOrchestratorChoice);
  const [planning, setPlanning] = useState<OrchestratorState | null>(null);
  const [requestingPlan, setRequestingPlan] = useState(false);
  const [planError, setPlanError] = useState('');
  const [starting, setStarting] = useState(false);
  const [startIssues, setStartIssues] = useState<ValidationIssue[]>([]);
  // A session can emit its first progress snapshot before the invoke that
  // returns its id settles. Cache those snapshots by id so the planning panel
  // starts with the real transcript rather than dropping its first line.
  const progressRef = useRef(new Map<string, OrchestratorState>());
  const planIdRef = useRef('');

  useEffect(
    () =>
      api.on('orchestrator-progress', (data) => {
        const state = data as OrchestratorState | undefined;
        if (!state) return;
        progressRef.current.set(state.planId, state);
        if (state.planId === planIdRef.current) setPlanning(state);
      }),
    [],
  );

  useEffect(() => {
    setPlanning(null);
    setPlanError('');
    setStartIssues([]);
    return () => {
      const planId = planIdRef.current;
      planIdRef.current = '';
      if (planId) void api.orchestrator.cancel(planId);
    };
  }, [projectId]);

  const requestOk = request.trim().length > 0;
  const composeBlocked = !project
    ? 'Add a project first'
    : !requestOk
      ? 'Describe what to build'
      : baseSyncing
        ? `Updating ${project.baseRef} first`
        : null;

  const plan = planning?.status === 'done' ? planning.plan : null;
  const stage: 'compose' | 'planning' | 'ready' = plan
    ? 'ready'
    : requestingPlan || planning?.status === 'running' || planning?.status === 'failed'
      ? 'planning'
      : 'compose';

  const submitPlan = useCallback(async (): Promise<void> => {
    const prompt = request;
    if (!prompt.trim() || !projectId || baseSyncing || requestingPlan) return;
    planIdRef.current = '';
    setRequestingPlan(true);
    setPlanError('');
    setStartIssues([]);
    setPlanning(null);
    try {
      const result = await api.orchestrator.plan(
        projectId,
        prompt,
        choice.model,
        choice.reasoningEffort,
      );
      if ('error' in result) {
        setPlanError(result.error);
        return;
      }
      planIdRef.current = result.planId;
      setPlanning(
        progressRef.current.get(result.planId) ?? {
          planId: result.planId,
          projectId,
          status: 'running',
          model: choice.model,
          reasoningEffort: choice.reasoningEffort,
          prompt,
          entries: [],
          plan: null,
          rawReply: '',
          detail: 'Opening the planning session…',
          startedAt: Date.now(),
        },
      );
    } catch (error) {
      setPlanError((error as Error).message || 'Could not open the planning session.');
    } finally {
      setRequestingPlan(false);
    }
  }, [request, projectId, baseSyncing, requestingPlan, choice]);

  const cancelPlanning = (): void => {
    const planId = planIdRef.current;
    planIdRef.current = '';
    if (planId) void api.orchestrator.cancel(planId);
    setPlanning(null);
  };

  const discardPlan = (): void => {
    planIdRef.current = '';
    setPlanning(null);
    setStartIssues([]);
  };

  const startFromPlan = async (): Promise<void> => {
    if (!plan || starting || baseSyncing) return;
    setStarting(true);
    setStartIssues([]);
    try {
      const result = await api.runs.start({
        projectId,
        pipelineId: plan.pipeline.id,
        request: plan.refinedRequest,
        plan,
      });
      if (!result.ok) {
        setStartIssues(result.issues);
        // Project commands may have been partially filled; refresh so Settings matches.
        await refreshAll();
        return;
      }
      onRequestChange('');
      discardPlan();
      await refreshAll();
      if (result.runId) onOpen(result.runId);
    } catch (error) {
      setStartIssues([{ level: 'error', where: 'start', message: (error as Error).message }]);
    } finally {
      setStarting(false);
    }
  };

  const onHeroKeydown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void submitPlan();
    }
  };

  const heroCollapsed = stage !== 'compose';
  const planningLive = requestingPlan || planning?.status === 'running';

  return (
    <div className={`${styles.stage} scroll`}>
      <div className={heroCollapsed ? styles.heroCollapsed : styles.hero}>
        <div className={styles.heroInner}>
          {!heroCollapsed && <h1 className={styles.heroTitle}>What should the factory build?</h1>}
          <div className={`${styles.heroBox} card`}>
            <textarea
              className={`textarea ${styles.heroRequest}`}
              value={request}
              onChange={(event) => onRequestChange(event.target.value)}
              rows={heroCollapsed ? 2 : 4}
              placeholder="Describe the change. The Orchestrator rewrites it into a full brief and composes the pipeline."
              onKeyDown={onHeroKeydown}
              aria-label="Run request"
              data-testid="run-request"
            />
            <div className={styles.heroControls}>
              <OrchestratorPicker choice={choice} disabled={planningLive} onChange={setChoice} />
              <Button
                variant="primary"
                className={styles.planButton}
                disabled={Boolean(composeBlocked) || planningLive}
                title={composeBlocked ?? undefined}
                onClick={() => void submitPlan()}
                data-testid="run-plan"
              >
                {stage === 'ready' ? 'Regenerate plan' : planningLive ? 'Planning…' : 'Plan run'}
                {!composeBlocked && !planningLive && <kbd>⌘↵</kbd>}
              </Button>
            </div>
            {composeBlocked && stage === 'compose' && (
              <p className={`${styles.hintLine} faint`}>{composeBlocked}</p>
            )}
            {planError && (
              <p className={styles.planError} role="alert">
                {planError}
              </p>
            )}
          </div>
          {!heroCollapsed && (
            <button
              type="button"
              className={styles.modeToggle}
              onClick={onManual}
              data-testid="runs-mode-manual"
            >
              Manual pipeline…
            </button>
          )}
        </div>
      </div>

      {stage === 'planning' && (
        <section className={`${styles.planning} card`} data-testid="planning-panel">
          <div className={styles.planningHead}>
            <span className={styles.planningTitle}>
              {planning?.status === 'failed' ? 'Planning failed' : 'The Orchestrator is planning'}
            </span>
            <span className={`faint ${styles.planningDetail}`}>
              {planning?.detail ?? 'Opening the planning session…'}
            </span>
            {planningLive && !requestingPlan && (
              <Button size="sm" variant="ghost" onClick={cancelPlanning}>
                Cancel
              </Button>
            )}
            {planning?.status === 'failed' && (
              <Button size="sm" onClick={() => void submitPlan()}>
                Try again
              </Button>
            )}
          </div>
          <PanelTranscript entries={planning?.entries ?? []} live={planningLive} />
        </section>
      )}

      {stage === 'ready' && plan && (
        <div className={styles.planWrap}>
          <PlanCard
            plan={plan}
            starting={starting}
            startBlocked={
              baseSyncing ? `Updating ${project?.baseRef ?? 'base branch'} first` : null
            }
            issues={startIssues}
            onStart={() => void startFromPlan()}
            onRegenerate={() => void submitPlan()}
            onDiscard={discardPlan}
          />
        </div>
      )}

      <section className={styles.history} aria-labelledby="run-history-title">
        <p id="run-history-title" className={styles.historyLabel}>
          Run history
        </p>
        <RunList onOpen={onOpen} projectId={projectId} includeArchived={includeArchived} />
      </section>
    </div>
  );
}

export default function RunsScreen({
  request,
  onRequestChange,
  onOpen,
  onAddProject,
  onNewProject,
  onOpenSettings,
}: {
  request: string;
  onRequestChange: (request: string) => void;
  onOpen: (runId: string) => void;
  onAddProject?: () => void;
  /** Create a repository on GitHub instead of pointing at an existing checkout. */
  onNewProject?: () => void;
  onOpenSettings?: (pane: string) => void;
}): React.JSX.Element {
  const { project, projectId } = useApp();
  const [mode, setMode] = useState<RunsMode>(loadMode);
  const [includeArchived, setIncludeArchived] = useState(false);
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

  const manual = (
    <>
      <div className={styles.manualToggleRow}>
        <button
          type="button"
          className={styles.modeToggle}
          onClick={() => switchMode('orchestrated')}
          data-testid="runs-mode-orchestrated"
        >
          Back to the Orchestrator
        </button>
      </div>
      <ManualComposer
        request={request}
        onRequestChange={onRequestChange}
        onOpen={onOpen}
        onOpenSettings={onOpenSettings}
        baseSyncing={baseSyncing}
      />
      <RunList onOpen={onOpen} projectId={projectId} includeArchived={includeArchived} />
    </>
  );

  return (
    <div className={styles.screen}>
      <RunsHeader
        companion={companion}
        includeArchived={includeArchived}
        onIncludeArchived={setIncludeArchived}
        onOpenSettings={onOpenSettings}
      />
      {project && banner && (
        <div
          className={banner.tone === 'ready' ? styles.readinessReady : styles.readinessBanner}
          data-testid="readiness-banner"
          data-ready={banner.tone === 'ready' ? 'yes' : 'no'}
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
      ) : mode === 'manual' ? (
        manual
      ) : (
        <OrchestratedComposer
          request={request}
          onRequestChange={onRequestChange}
          onOpen={onOpen}
          onManual={() => switchMode('manual')}
          includeArchived={includeArchived}
          baseSyncing={baseSyncing}
        />
      )}
    </div>
  );
}
