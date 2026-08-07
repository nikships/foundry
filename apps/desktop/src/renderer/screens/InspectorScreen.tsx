/**
 * The Inspector: every agent's full transcript, live, one lane per phase.
 * It follows the currently running run unless the user picks a specific one,
 * so opening it during a run needs no clicks and opening it after a run is
 * one. Lanes sit in a grid sized to how many phases the pipeline has, ready
 * for the day phases run in parallel.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { useRun, useRunList } from '../stores/run.js';
import StatusBadge from '../components/StatusBadge.js';
import EmptyState from '../components/EmptyState.js';
import TranscriptLane from '../components/inspector/TranscriptLane.js';
import { clockTime, since, truncate } from '../format.js';

type LaneFilter = 'all' | 'running' | 'failed';

const FILTERS: { id: LaneFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'failed', label: 'Failed' },
];

export default function InspectorScreen({
  pinnedRunId,
}: {
  pinnedRunId: string;
}): React.JSX.Element {
  const { projectId, project } = useApp();
  const {
    runs,
    loading: listLoading,
    error: listError,
    refresh: refreshList,
  } = useRunList(projectId, false);
  const [pickedRunId, setPickedRunId] = useState('');
  const [filter, setFilter] = useState<LaneFilter>('all');
  const [focusedPhaseId, setFocusedPhaseId] = useState('');
  const [now, setNow] = useState(Date.now());
  const [filesError, setFilesError] = useState('');

  // A deep link from the run detail screen pins the picker to that run.
  useEffect(() => {
    if (pinnedRunId) setPickedRunId(pinnedRunId);
  }, [pinnedRunId]);

  useEffect(() => {
    setFilesError('');
  }, [pickedRunId, projectId]);

  // Auto-follow: the live run wins; with nothing live, the most recent run.
  const autoRunId = useMemo(() => {
    const live = runs.find((r) => r.status === 'running');
    return (live ?? runs[0])?.runId ?? '';
  }, [runs]);

  const runId = pickedRunId && runs.some((r) => r.runId === pickedRunId) ? pickedRunId : autoRunId;
  const { view, eventsByPhase, envelopesByPhase, refresh: refreshRun } = useRun(projectId, runId);

  const live = view.live;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const lanes = useMemo(() => {
    const phases = view.phases.filter((phase) => {
      if (filter === 'running') return phase.status === 'running';
      if (filter === 'failed') return phase.status === 'fail';
      return true;
    });
    return phases;
  }, [view.phases, filter]);

  const visibleLanes = focusedPhaseId ? lanes.filter((p) => p.phaseId === focusedPhaseId) : lanes;

  const revealFiles = async (): Promise<void> => {
    setFilesError('');
    try {
      await api.runs.revealFiles(projectId, runId);
    } catch (e) {
      setFilesError((e as Error).message);
    }
  };

  const retry = async (): Promise<void> => {
    await refreshList();
    if (runId) await refreshRun();
  };

  if (!project) {
    return (
      <div className="insp">
        <header className="insp-head">
          <h1>Inspector</h1>
        </header>
        <EmptyState
          art="scenes/empty-state.png"
          title="No project yet"
          body="Add a git repository from the sidebar. The Inspector follows that project's runs."
        />
        <InspStyle />
      </div>
    );
  }

  return (
    <div className="insp">
      <header className="insp-head">
        <h1>Inspector</h1>
        <select
          className="select"
          value={pickedRunId && runs.some((r) => r.runId === pickedRunId) ? pickedRunId : ''}
          onChange={(e) => {
            setPickedRunId(e.target.value);
            setFocusedPhaseId('');
          }}
        >
          <option value="">
            {runs.some((r) => r.status === 'running') ? 'Follow live run' : 'Follow latest run'}
          </option>
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.status === 'running' ? '* ' : ''}
              {r.pipelineName} · {r.status} · {clockTime(r.startedAt)} · {since(r.startedAt)}
            </option>
          ))}
        </select>
        {view.run && (
          <>
            <StatusBadge status={view.run.status} />
            {view.live && <span className="insp-live">Live</span>}
            <span className="insp-request" title={view.run.request}>
              {truncate(view.run.request, 80)}
            </span>
          </>
        )}
        <div className="insp-controls">
          <div className="insp-filter">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`insp-filter-btn ${filter === f.id ? 'active' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {view.run && (
            <button className="btn sm" onClick={() => void revealFiles()}>
              Raw files
            </button>
          )}
        </div>
      </header>

      {(listError || view.error || filesError) && (
        <div className="insp-banner" role="alert">
          <span>{listError || view.error || filesError}</span>
          {(listError || view.error) && (
            <button className="btn sm" onClick={() => void retry()}>
              Retry
            </button>
          )}
        </div>
      )}

      {listLoading && !runs.length && !listError && (
        <div className="insp-empty faint">Loading runs…</div>
      )}
      {view.loading && runId && !view.error && <div className="insp-empty faint">Loading run…</div>}
      {!listLoading && !view.loading && !listError && !view.error && !runId && (
        <EmptyState
          art="scenes/empty-state.png"
          title="No runs yet"
          body="Start a run from the Runs screen. The Inspector follows the live run automatically, or pick one above."
        />
      )}
      {!view.loading && !view.error && runId && lanes.length === 0 && (
        <div className="insp-empty">
          <p className="faint">No phases match this filter.</p>
          {filter !== 'all' && (
            <button className="btn sm" onClick={() => setFilter('all')}>
              Show all phases
            </button>
          )}
        </div>
      )}
      {!view.loading && runId && visibleLanes.length > 0 && (
        <div className={`insp-grid lanes-${Math.min(visibleLanes.length, 3)}`}>
          {visibleLanes.map((phase) => (
            <TranscriptLane
              key={phase.phaseId}
              phase={phase}
              events={eventsByPhase.get(phase.phaseId) ?? []}
              envelope={envelopesByPhase.get(phase.phaseId)?.[0]}
              sessions={view.sessions}
              now={now}
              focused={focusedPhaseId === phase.phaseId}
              onToggleFocus={() =>
                setFocusedPhaseId((id) => (id === phase.phaseId ? '' : phase.phaseId))
              }
            />
          ))}
        </div>
      )}

      <InspStyle />
    </div>
  );
}

function InspStyle(): React.JSX.Element {
  return (
    <style>{`
      .insp { display: flex; flex-direction: column; height: 100%; min-height: 0; padding: calc(var(--titlebar-h) + var(--s2)) var(--s5) var(--s4); gap: 12px; }
      .insp-head { display: flex; align-items: center; gap: 10px; flex: none; flex-wrap: wrap; }
      .insp-head h1 { font-size: 17px; font-weight: 600; margin: 0; }
      .insp-head .select { max-width: 300px; }
      .insp-request { font-size: 12px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
      .insp-live { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; padding: 2px 7px; border-radius: var(--r-full); background: var(--cyan-dim); color: var(--cyan); }
      .insp-controls { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
      .insp-filter { display: flex; border: 1px solid var(--line); border-radius: var(--r-sm); overflow: hidden; }
      .insp-filter-btn { border: none; background: transparent; color: var(--text-faint); font: inherit; font-size: 11.5px; padding: 4px 12px; cursor: pointer; }
      .insp-filter-btn + .insp-filter-btn { border-left: 1px solid var(--line); }
      .insp-filter-btn.active { background: var(--bg-raised); color: var(--text); }
      .insp-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); padding: var(--s3); border-radius: var(--r-sm); background: var(--red-dim); color: var(--red); font-size: var(--text-sm); line-height: var(--leading); }
      .insp-grid { flex: 1; min-height: 0; overflow-y: auto; display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); grid-auto-rows: minmax(280px, 1fr); }
      .insp-grid.lanes-1 { grid-template-columns: 1fr; }
      .insp-grid.lanes-2 { grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); }
      .insp-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-dim); font-size: 13px; }
      .insp-empty .faint { color: var(--text-faint); font-size: 12px; }
    `}</style>
  );
}
