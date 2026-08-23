import { useEffect, useMemo, useState } from 'react';
import type { ReadinessInspectResult, ValidationIssue } from '@shared/types.js';
import type { CompanionHostState } from '@shared/companion.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { useRunList } from '../stores/run.js';
import { since, truncate, durationClock, tokensBadge } from '../utils/format.js';
import { runDuration } from '../utils/derive.js';
import StatusBadge from '../components/common/StatusBadge.js';
import PipelineRibbon from '../components/pipeline/PipelineRibbon.js';
import EmptyState from '../components/common/EmptyState.js';
import BaseSyncBar from '../components/project/BaseSyncBar.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown } from '../components/ui/Dropdown.js';
import { readinessBanner } from '../view-models/readiness-view.js';
import styles from './RunsScreen.module.css';

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
  const { pipelines, project, projectId, refreshAll } = useApp();
  const [selectedPipeline, setSelectedPipeline] = useState(
    () => localStorage.getItem('foundry.pipeline') ?? '',
  );
  const [includeArchived, setIncludeArchived] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startNote, setStartNote] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [preflight, setPreflight] = useState<ValidationIssue[]>([]);
  const [readiness, setReadiness] = useState<ReadinessInspectResult | null>(null);
  const [baseSyncing, setBaseSyncing] = useState(false);
  const [companion, setCompanion] = useState<CompanionHostState | null>(null);

  useEffect(() => {
    void api.companion.state().then(setCompanion);
    return api.on('companion-changed', () => {
      void api.companion.state().then(setCompanion);
    });
  }, []);

  const {
    runs,
    loading,
    error: listError,
    refresh: refreshList,
  } = useRunList(projectId, includeArchived);

  const pipeline = useMemo(
    () => pipelines.find((p) => p.id === selectedPipeline) ?? pipelines[0] ?? null,
    [pipelines, selectedPipeline],
  );

  useEffect(() => {
    if (!pipelines.some((p) => p.id === selectedPipeline))
      setSelectedPipeline(pipelines[0]?.id ?? '');
  }, [pipelines, selectedPipeline]);

  useEffect(() => {
    if (selectedPipeline) localStorage.setItem('foundry.pipeline', selectedPipeline);
  }, [selectedPipeline]);

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

  // Live preflight so missing commands and broken refs show before Start is hit.
  useEffect(() => {
    if (!pipeline) {
      setPreflight([]);
      return;
    }
    let cancelled = false;
    void api.pipelines.validate(pipeline, projectId || undefined).then((next) => {
      if (!cancelled) setPreflight(next);
    });
    return () => {
      cancelled = true;
    };
  }, [pipeline, projectId, project?.commands]);

  const missingCommands = useMemo(
    () =>
      preflight.filter(
        (i) =>
          i.level === 'warning' &&
          i.message.includes('project command') &&
          i.message.includes('not configured'),
      ),
    [preflight],
  );
  const blockingPreflight = useMemo(
    () => preflight.filter((i) => i.level === 'error'),
    [preflight],
  );

  const banner = useMemo(() => (readiness ? readinessBanner(readiness) : null), [readiness]);

  const requestOk = request.trim().length > 0;
  const canStart =
    !!project && !!pipeline && requestOk && blockingPreflight.length === 0 && !baseSyncing;
  const startDisabledReason = !project
    ? 'Add a project first'
    : !pipeline
      ? 'No pipeline available'
      : !requestOk
        ? 'Describe what to build'
        : blockingPreflight.length
          ? 'Fix pipeline errors first'
          : baseSyncing
            ? `Updating ${project.baseRef} first`
            : '';

  const start = async (): Promise<void> => {
    if (!canStart || starting) return;
    setStarting(true);
    setIssues([]);
    setStartNote(
      missingCommands.length
        ? 'Checking project commands (detecting from the repo if needed)…'
        : '',
    );
    try {
      const result = await api.runs.start({
        projectId,
        pipelineId: pipeline!.id,
        request: request.trim(),
      });
      if (!result.ok) {
        setIssues(result.issues);
        setStartNote('');
        // Project commands may have been partially filled; refresh so Settings matches.
        await refreshAll();
        return;
      }
      onRequestChange('');
      setStartNote('');
      await refreshAll();
      if (result.runId) onOpen(result.runId);
    } catch (e) {
      setIssues([{ level: 'error', where: 'start', message: (e as Error).message }]);
      setStartNote('');
    } finally {
      setStarting(false);
    }
  };

  const onKeydown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void start();
    }
  };

  const openProjectCommands = (): void => onOpenSettings?.('project');
  const pill = companion ? companionPill(companion) : null;

  return (
    <div className={styles.screen}>
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
              onChange={(e) => setIncludeArchived(e.target.checked)}
              data-testid="runs-archived"
            />
            Show archived
          </label>
        </div>
      </header>
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
      {project ? (
        <section className={`${styles.composer} card`}>
          <textarea
            className={`textarea ${styles.request}`}
            value={request}
            onChange={(e) => onRequestChange(e.target.value)}
            rows={3}
            placeholder="What should the factory build? Be specific: the request is the whole brief."
            onKeyDown={onKeydown}
            aria-label="Run request"
            data-testid="run-request"
          />
          <div className={styles.controls}>
            <Dropdown
              className={styles.pipeline}
              value={selectedPipeline || pipeline?.id || ''}
              options={pipelines.map((p) => ({
                value: p.id,
                label: p.name,
                description: p.description || undefined,
              }))}
              onChange={(next) => setSelectedPipeline(next)}
              aria-label="Pipeline"
              data-testid="run-pipeline"
            />
            {pipeline && <PipelineRibbon pipeline={pipeline} />}
            <Button
              variant="primary"
              className={styles.startButton}
              disabled={!canStart || starting}
              title={startDisabledReason || undefined}
              onClick={() => void start()}
              data-testid="run-start"
            >
              {starting ? 'Starting…' : 'Start run'}
              {canStart && !starting && <kbd>⌘↵</kbd>}
            </Button>
          </div>
          {!canStart && startDisabledReason && (
            <p className={`${styles.hintLine} faint`}>{startDisabledReason}</p>
          )}
          {pipeline && <p className={`${styles.desc} faint`}>{pipeline.description}</p>}
          {missingCommands.length > 0 && (
            <div className={styles.notice}>
              <p>
                This pipeline needs project command
                {missingCommands.length === 1 ? '' : 's'} that are not configured yet
                {missingCommands.length === 1
                  ? ` (${missingCommands[0]!.message.match(/"([^"]+)"/)?.[1] ?? 'test'})`
                  : ''}
                . Starting will detect them from the repo (and ask an agent if needed).
              </p>
              <Button size="sm" onClick={openProjectCommands}>
                Configure commands
              </Button>
            </div>
          )}
          {blockingPreflight.length > 0 && (
            <ul className={`${styles.issues} ${styles.warn}`}>
              {blockingPreflight.map((issue, i) => (
                <li key={i}>
                  <strong>{issue.where}</strong> {issue.message}
                </li>
              ))}
            </ul>
          )}
          {startNote && <p className={`${styles.hintLine} faint`}>{startNote}</p>}
          {issues.length > 0 && (
            <ul className={styles.issues}>
              {issues.map((issue, i) => (
                <li key={i}>
                  <strong>{issue.where}</strong> {issue.message}
                </li>
              ))}
            </ul>
          )}
          {issues.some((i) => i.message.includes('project command')) && (
            <Button size="sm" className={styles.fix} onClick={openProjectCommands}>
              Open project commands
            </Button>
          )}
        </section>
      ) : null}
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
        <div className={`${styles.list} scroll`}>
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
              body="Describe a change above and pick a pipeline. Every run is isolated in its own git worktree. Missing test commands are detected automatically when you start."
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
      )}
    </div>
  );
}
