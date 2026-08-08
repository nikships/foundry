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
import { Button } from '../components/ui/Button.js';
import styles from './InspectorScreen.module.css';

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
      <div className={styles.insp}>
        <header className={styles.inspHead}>
          <h1>Inspector</h1>
        </header>
        <EmptyState
          art="scenes/empty-state.png"
          title="No project yet"
          body="Add a git repository from the sidebar. The Inspector follows that project's runs."
        />
      </div>
    );
  }

  // Map visible count to the corresponding lane-count modifier class
  const lanesClass = (() => {
    const n = Math.min(visibleLanes.length, 3);
    if (n === 1) return styles.lanes1;
    if (n === 2) return styles.lanes2;
    return '';
  })();

  return (
    <div className={styles.insp}>
      <header className={styles.inspHead}>
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
            {view.live && <span className={styles.inspLive}>Live</span>}
            <span className={styles.inspRequest} title={view.run.request}>
              {truncate(view.run.request, 80)}
            </span>
          </>
        )}
        <div className={styles.inspControls}>
          <div className={styles.inspFilter}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`${styles.inspFilterBtn} ${filter === f.id ? styles.active : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {view.run && (
            <Button size="sm" onClick={() => void revealFiles()}>
              Raw files
            </Button>
          )}
        </div>
      </header>

      {(listError || view.error || filesError) && (
        <div className={styles.inspBanner} role="alert">
          <span>{listError || view.error || filesError}</span>
          {(listError || view.error) && (
            <Button size="sm" onClick={() => void retry()}>
              Retry
            </Button>
          )}
        </div>
      )}

      {listLoading && !runs.length && !listError && (
        <div className={styles.inspSkeleton} aria-hidden>
          <div className={styles.skelRow} />
          <div className={styles.skelRow} />
          <div className={styles.skelRow} />
        </div>
      )}
      {view.loading && runId && !view.error && (
        <div className={styles.inspSkeleton} aria-hidden>
          <div className={styles.skelRow} />
          <div className={styles.skelRow} />
          <div className={styles.skelRow} />
        </div>
      )}
      {!listLoading && !view.loading && !listError && !view.error && !runId && (
        <EmptyState
          art="scenes/empty-state.png"
          title="No runs yet"
          body="Start a run from the Runs screen. The Inspector follows the live run automatically, or pick one above."
        />
      )}
      {!view.loading && !view.error && runId && lanes.length === 0 && (
        <div className={styles.inspEmpty}>
          <p className="faint">No phases match this filter.</p>
          {filter !== 'all' && (
            <Button size="sm" onClick={() => setFilter('all')}>
              Show all phases
            </Button>
          )}
        </div>
      )}
      {!view.loading && runId && visibleLanes.length > 0 && (
        <div className={`${styles.inspGrid} ${lanesClass}`}>
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
    </div>
  );
}
