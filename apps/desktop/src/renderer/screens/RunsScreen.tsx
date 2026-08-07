import { useEffect, useMemo, useState } from 'react';
import type { ValidationIssue } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { useRunList } from '../stores/run.js';
import { duration, since, tokens, truncate } from '../format.js';
import { runDuration } from '../derive.js';
import StatusBadge from '../components/StatusBadge.js';
import PipelineRibbon from '../components/PipelineRibbon.js';
import EmptyState from '../components/EmptyState.js';

export default function RunsScreen({
  onOpen,
  onAddProject,
  onOpenSettings,
}: {
  onOpen: (runId: string) => void;
  onAddProject?: () => void;
  onOpenSettings?: (pane: string) => void;
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
    <>
      <div className="screen">
        <header className="head">
          <h1>Runs</h1>
          <label className="archived faint">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Show archived
          </label>
        </header>
        {project ? (
          <section className="composer card">
            <textarea
              className="textarea request"
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={3}
              placeholder="What should the factory build? Be specific: the request is the whole brief."
              onKeyDown={onKeydown}
            />
            <div className="controls">
              <select
                className="select pipeline"
                value={selectedPipeline}
                onChange={(e) => setSelectedPipeline(e.target.value)}
              >
                {pipelines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {pipeline && <PipelineRibbon pipeline={pipeline} />}
              <div className="grow" />
              <button
                className="btn primary"
                disabled={!canStart || starting}
                title={startDisabledReason || undefined}
                onClick={() => void start()}
              >
                {starting ? 'Starting…' : 'Start run'}
                {canStart && !starting && <kbd>⌘↵</kbd>}
              </button>
            </div>
            {!canStart && startDisabledReason && (
              <p className="hint-line faint">{startDisabledReason}</p>
            )}
            {pipeline && <p className="desc faint">{pipeline.description}</p>}
            {missingCommands.length > 0 && (
              <div className="notice">
                <p>
                  This pipeline needs project command
                  {missingCommands.length === 1 ? '' : 's'} that are not configured yet
                  {missingCommands.length === 1
                    ? ` (${missingCommands[0]!.message.match(/"([^"]+)"/)?.[1] ?? 'test'})`
                    : ''}
                  . Starting will detect them from the repo (and ask an agent if needed).
                </p>
                <button className="btn sm" onClick={openProjectCommands}>
                  Configure commands
                </button>
              </div>
            )}
            {blockingPreflight.length > 0 && (
              <ul className="issues warn">
                {blockingPreflight.map((issue, i) => (
                  <li key={i}>
                    <strong>{issue.where}</strong> {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {startNote && <p className="hint-line faint">{startNote}</p>}
            {issues.length > 0 && (
              <ul className="issues">
                {issues.map((issue, i) => (
                  <li key={i}>
                    <strong>{issue.where}</strong> {issue.message}
                  </li>
                ))}
              </ul>
            )}
            {issues.some((i) => i.message.includes('project command')) && (
              <button className="btn sm fix" onClick={openProjectCommands}>
                Open project commands
              </button>
            )}
          </section>
        ) : null}
        {!project ? (
          <EmptyState
            art="scenes/empty-state.png"
            title="No project yet"
            body="Foundry runs against a git repository. Add one to get started."
          >
            {onAddProject && (
              <button className="btn primary" onClick={onAddProject}>
                Add a project…
              </button>
            )}
          </EmptyState>
        ) : (
          <div className="list scroll">
            {listError && (
              <div className="list-err" role="alert">
                <span>Could not load runs: {listError}</span>
                <button className="btn sm" onClick={() => void refreshList()}>
                  Retry
                </button>
              </div>
            )}
            {loading && !runs.length && !listError && (
              <p className="list-loading faint">Loading runs…</p>
            )}
            {!loading && !listError && runs.length === 0 && (
              <EmptyState
                art="scenes/empty-state.png"
                title="Nothing has run yet"
                body="Describe a change above and pick a pipeline. Every run is isolated in its own git worktree. Missing test commands are detected automatically when you start."
              />
            )}
            {runs.map((run) => (
              <button key={run.runId} className="run" onClick={() => onOpen(run.runId)}>
                <div className="run-main">
                  <div className="run-top">
                    <StatusBadge status={run.status} />
                    <span className="pipeline-name">{run.pipelineName}</span>
                    <span className="faint time">{since(run.startedAt)}</span>
                  </div>
                  <p className="req">{truncate(run.request, 160)}</p>
                </div>
                <div className="run-meta mono faint">
                  {run.branch && (
                    <span className="branch" title={run.branch}>
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
      <style>{`
        .screen { display: flex; flex-direction: column; height: 100%; min-height: 0; }
        .head { display: flex; align-items: baseline; justify-content: space-between; padding: calc(var(--titlebar-h) + var(--s2)) var(--s6) var(--s4); }
        .head h1 { font-size: var(--text-2xl); font-weight: 600; letter-spacing: -0.02em; }
        .archived { display: flex; align-items: center; gap: var(--s2); font-size: var(--text-sm); }
        .composer { margin: 0 var(--s6) var(--s5); padding: var(--s4); background: var(--bg-panel); border: 1px solid var(--line); border-radius: var(--r-lg); }
        .request { border: none; background: transparent; padding: 0; font-family: var(--font); font-size: var(--text-base); line-height: var(--leading); min-height: 72px; width: 100%; resize: vertical; color: var(--text); }
        .request:focus { outline: none; }
        .controls { display: flex; align-items: center; gap: var(--s3); margin-top: var(--s3); padding-top: var(--s3); border-top: 1px solid var(--line-faint); }
        .pipeline { width: auto; min-width: 190px; flex: none; }
        .grow { flex: 1; }
        .controls kbd { font-family: var(--font); font-size: var(--text-xs); opacity: 0.65; margin-left: var(--s2); }
        .desc { margin-top: var(--s3); font-size: var(--text-sm); line-height: var(--leading); }
        .hint-line { margin-top: var(--s2); font-size: var(--text-xs); }
        .notice { margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--amber-dim); color: var(--amber); font-size: var(--text-sm); display: flex; align-items: center; gap: var(--s3); justify-content: space-between; }
        .notice p { margin: 0; line-height: var(--leading); }
        .issues { margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); list-style: none; }
        .issues.warn { background: var(--amber-dim); color: var(--amber); }
        .fix { margin-top: var(--s2); }
        .list { flex: 1; min-height: 0; padding: 0 var(--s6) var(--s8); display: flex; flex-direction: column; gap: var(--s2); overflow-y: auto; }
        .list-err { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); }
        .list-loading { padding: var(--s6) var(--s3); font-size: var(--text-sm); text-align: center; }
        .run { display: flex; align-items: center; gap: var(--s4); width: 100%; padding: var(--s3) var(--s4); border: 1px solid var(--line); border-radius: var(--r); background: var(--bg-panel); color: inherit; font: inherit; text-align: left; cursor: default; transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease); }
        .run:hover { background: var(--bg-hover); border-color: var(--line-strong); }
        .run-main { flex: 1; min-width: 0; }
        .run-top { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s1); }
        .pipeline-name { font-size: var(--text-sm); font-weight: 500; }
        .time { font-size: var(--text-xs); }
        .req { font-size: var(--text-sm); color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .run-meta { display: flex; align-items: center; gap: var(--s4); font-size: var(--text-xs); flex: none; }
        .branch { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      `}</style>
    </>
  );
}
