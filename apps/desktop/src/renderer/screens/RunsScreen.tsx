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
}: {
  onOpen: (runId: string) => void;
}): React.JSX.Element {
  const { pipelines, project, projectId } = useApp();
  const [request, setRequest] = useState('');
  const [selectedPipeline, setSelectedPipeline] = useState(
    () => localStorage.getItem('foundry.pipeline') ?? '',
  );
  const [includeArchived, setIncludeArchived] = useState(false);
  const [starting, setStarting] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);

  const { runs, loading } = useRunList(projectId, includeArchived);

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

  const canStart = !!project && !!pipeline && request.trim().length > 0;

  const start = async (): Promise<void> => {
    if (!canStart || starting) return;
    setStarting(true);
    setIssues([]);
    try {
      const result = await api.runs.start({
        projectId,
        pipelineId: pipeline!.id,
        request: request.trim(),
      });
      if (!result.ok) {
        setIssues(result.issues);
        return;
      }
      setRequest('');
      if (result.runId) onOpen(result.runId);
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
                onClick={() => void start()}
              >
                {starting ? 'Starting…' : 'Start run'}
                {canStart && !starting && <kbd>⌘↵</kbd>}
              </button>
            </div>
            {pipeline && <p className="desc faint">{pipeline.description}</p>}
            {issues.length > 0 && (
              <ul className="issues">
                {issues.map((issue, i) => (
                  <li key={i}>
                    <strong>{issue.where}</strong> {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
        {!project ? (
          <EmptyState
            art="scenes/empty-state.png"
            title="No project yet"
            body="Foundry runs against a git repository. Add one to get started."
          />
        ) : (
          <div className="list scroll">
            {!loading && runs.length === 0 && (
              <EmptyState
                art="scenes/empty-state.png"
                title="Nothing has run yet"
                body="Describe a change above and pick a pipeline. Every run is isolated in its own git worktree."
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
        .issues { margin-top: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); list-style: none; }
        .list { flex: 1; min-height: 0; padding: 0 var(--s6) var(--s8); display: flex; flex-direction: column; gap: var(--s2); overflow-y: auto; }
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
