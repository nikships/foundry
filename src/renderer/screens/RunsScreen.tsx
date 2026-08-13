import { useEffect, useMemo, useState } from 'react';
import type { ReadinessInspectResult, ValidationIssue } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { useRunList } from '../stores/run.js';
import { duration, since, tokens, truncate } from '../format.js';
import { runDuration } from '../derive.js';
import StatusBadge from '../components/StatusBadge.js';
import PipelineRibbon from '../components/PipelineRibbon.js';
import EmptyState from '../components/EmptyState.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown } from '../components/ui/Dropdown.js';
import styles from './RunsScreen.module.css';

export default function RunsScreen({
  onOpen,
  onAddProject,
  onNewProject,
  onOpenSettings,
  onOpenReadiness,
}: {
  onOpen: (runId: string) => void;
  onAddProject?: () => void;
  /** Create a repository on GitHub instead of pointing at an existing checkout. */
  onNewProject?: () => void;
  onOpenSettings?: (pane: string) => void;
  onOpenReadiness?: () => void;
}): React.JSX.Element {
  const { pipelines, project, projectId, refreshAll } = useApp();
  const [request, setRequest] = useState('');
  const [selectedPipeline, setSelectedPipeline] = useState(
    () => localStorage.getItem('foundry.pipeline') ?? '',
  );
  const [includeArchived, setIncludeArchived] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startNote, setStartNote] = useState('');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [preflight, setPreflight] = useState<ValidationIssue[]>([]);
  const [readiness, setReadiness] = useState<ReadinessInspectResult | null>(null);

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

  const requestOk = request.trim().length > 0;
  const canStart = !!project && !!pipeline && requestOk && blockingPreflight.length === 0;
  const startDisabledReason = !project
    ? 'Add a project first'
    : !pipeline
      ? 'No pipeline available'
      : !requestOk
        ? 'Describe what to build'
        : blockingPreflight.length
          ? 'Fix pipeline errors first'
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
      setRequest('');
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

  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <p className="eyebrow">
          <span className="index">01</span>Runs
        </p>
        <label className={styles.archived}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />
          Show archived
        </label>
      </header>
      {project && readiness && (
        <div className={readiness.ready ? styles.readinessReady : styles.readinessBanner}>
          <p>
            {readiness.ready
              ? readiness.marker?.summary || 'This project is agent-ready.'
              : 'This project is not agent-ready. Pipeline runs may fail mid-flight until the checklist is green.'}
          </p>
          {!readiness.ready && onOpenReadiness && (
            <Button size="sm" onClick={onOpenReadiness}>
              {readiness.skipped ? 'Re-run readiness' : 'Check readiness'}
            </Button>
          )}
        </div>
      )}
      {project ? (
        <section className={`${styles.composer} card`}>
          <textarea
            className={`textarea ${styles.request}`}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
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
            <button key={run.runId} className={styles.run} onClick={() => onOpen(run.runId)}>
              <div className={styles.runMain}>
                <div className={styles.runTop}>
                  <StatusBadge status={run.status} />
                  <span className={styles.pipelineName}>{run.pipelineName}</span>
                  <span className={`faint ${styles.time}`}>{since(run.startedAt)}</span>
                </div>
                <p className={styles.req}>{truncate(run.request, 160)}</p>
              </div>
              <div className={`${styles.runMeta} mono faint`}>
                {run.branch && (
                  <span className={styles.branch} title={run.branch}>
                    {run.branch.replace('foundry/', '')}
                  </span>
                )}
                <span>{duration(runDuration(run))}</span>
                {run.totalTokens ? <span>{tokens(run.totalTokens)} tok</span> : null}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
