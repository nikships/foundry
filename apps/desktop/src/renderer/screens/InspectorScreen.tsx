/**
 * The Inspector: every agent's full transcript, live, one lane per phase.
 * It follows the currently running run unless the user picks a specific one,
 * so opening it during a run needs no clicks and opening it after a run is
 * one. Lanes sit in a single row of full-height columns (~3 visible); scroll
 * horizontally to see the rest.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { useRun, useRunList } from '../stores/run.js';
import StatusBadge from '../components/common/StatusBadge.js';
import EmptyState from '../components/common/EmptyState.js';
import TranscriptLane from '../components/inspector/TranscriptLane.js';
import { clockTime, since, truncate } from '../utils/format.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown } from '../components/ui/Dropdown.js';
import { CollapseContext } from '../components/inspector/collapse.js';
import styles from './InspectorScreen.module.css';

type LaneFilter = 'all' | 'running' | 'failed';

const FILTERS: { id: LaneFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'failed', label: 'Failed' },
];

const LANE_COUNT_KEY = 'inspectorLaneCount';

function loadLaneCount(): number {
  try {
    // Prefer localStorage so the preference survives app restarts, but
    // fall back to sessionStorage for sessions that already saved there.
    const fromLocal =
      typeof localStorage !== 'undefined' ? localStorage.getItem(LANE_COUNT_KEY) : null;
    const fromSession =
      typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(LANE_COUNT_KEY) : null;
    const saved = fromLocal ?? fromSession;
    if (saved) {
      const n = parseInt(saved, 10);
      if (n >= 1 && n <= 6) return n;
    }
  } catch {
    // ignore storage access errors (e.g. tests without DOM)
  }
  return 3;
}

function InspectorFooter({
  disabledAll = false,
  hasVisibleTools = false,
  laneCount,
  onLaneCount,
  onCollapse,
}: {
  /** No project: everything renders but nothing is interactive. */
  disabledAll?: boolean;
  hasVisibleTools?: boolean;
  laneCount: number;
  onLaneCount: (n: number) => void;
  onCollapse?: () => void;
}): React.JSX.Element {
  return (
    <footer className={styles.inspectorFooter}>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabledAll || !hasVisibleTools}
        onClick={disabledAll ? undefined : onCollapse}
        aria-label="Collapse all tool calls"
        data-testid={disabledAll ? undefined : 'inspector-collapse-all'}
        title={
          disabledAll
            ? 'No project, nothing to collapse'
            : hasVisibleTools
              ? 'Collapse every tool call in all visible lanes'
              : 'No visible tool calls to collapse'
        }
      >
        Collapse all tool calls
      </Button>
      <span className={styles.inspectorFooterHint}>
        {disabledAll
          ? 'Collapses every tool call across all visible agents'
          : 'Collapses every tool call across all visible agents — re-expand any step individually'}
      </span>
      <div className={styles.inspectorDensity}>
        <span className={styles.densityLabel}>Lanes</span>
        <span className={styles.densityValue} aria-hidden>
          {laneCount}
        </span>
        <input
          type="range"
          min="1"
          max="6"
          step="1"
          value={laneCount}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (!Number.isNaN(n) && n >= 1 && n <= 6) onLaneCount(n);
          }}
          className={styles.densitySlider}
          disabled={disabledAll}
          title="Lanes per viewport"
          aria-label="Adjust visible lanes density"
          data-testid={disabledAll ? undefined : 'inspector-lanes'}
        />
      </div>
    </footer>
  );
}

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
  const [collapseSignal, setCollapseSignal] = useState(0);
  const [laneCount, setLaneCount] = useState<number>(loadLaneCount);

  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined')
        localStorage.setItem(LANE_COUNT_KEY, String(laneCount));
      if (typeof sessionStorage !== 'undefined')
        sessionStorage.setItem(LANE_COUNT_KEY, String(laneCount));
    } catch {
      // ignore storage access errors
    }
  }, [laneCount]);

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

  const pickedIsValid = Boolean(pickedRunId) && runs.some((r) => r.runId === pickedRunId);
  const runId = pickedIsValid ? pickedRunId : autoRunId;
  const { view, eventsByPhase, envelopesByPhase, refresh: refreshRun } = useRun(projectId, runId);

  const live = view.live;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  const lanes = useMemo(
    () =>
      view.phases.filter((phase) => {
        if (filter === 'running') return phase.status === 'running';
        if (filter === 'failed') return phase.status === 'fail';
        return true;
      }),
    [view.phases, filter],
  );

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
      <div className={styles.inspector}>
        <header className={styles.inspectorHead}>
          <p className="eyebrow">
            <span className="index">04</span>Inspector
          </p>
        </header>
        <EmptyState
          art="scenes/empty-state.png"
          title="No project yet"
          body="Add a git repository from the sidebar. The Inspector follows that project's runs."
        />
        <InspectorFooter disabledAll laneCount={laneCount} onLaneCount={setLaneCount} />
      </div>
    );
  }

  const hasVisibleTools = visibleLanes.length > 0;
  const isFocused = Boolean(focusedPhaseId);

  return (
    <CollapseContext.Provider value={collapseSignal}>
      <div className={styles.inspector}>
        <header className={styles.inspectorHead}>
          <p className="eyebrow">
            <span className="index">04</span>Inspector
          </p>
          <Dropdown
            className={styles.inspectorSelect}
            value={pickedIsValid ? pickedRunId : ''}
            options={[
              {
                value: '',
                label: runs.some((r) => r.status === 'running')
                  ? 'Follow live run'
                  : 'Follow latest run',
              },
              ...runs.map((r) => ({
                value: r.runId,
                label: `${r.status === 'running' ? '* ' : ''}${r.pipelineName} · ${r.status} · ${clockTime(r.startedAt)} · ${since(r.startedAt)}`,
              })),
            ]}
            onChange={(next) => {
              setPickedRunId(next);
              setFocusedPhaseId('');
            }}
            aria-label="Run"
            data-testid="inspector-run"
          />
          {view.run && (
            <>
              <StatusBadge status={view.run.status} />
              {view.live && <span className={styles.inspectorLive}>Live</span>}
              <span className={styles.inspectorRequest} title={view.run.request}>
                {truncate(view.run.request, 80)}
              </span>
            </>
          )}
          <div className={styles.inspectorControls}>
            <div className={styles.inspectorFilter}>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`${styles.inspectorFilterBtn} ${filter === f.id ? styles.active : ''}`}
                  onClick={() => setFilter(f.id)}
                  data-testid={`inspector-filter-${f.id}`}
                >
                  {f.label}
                </button>
              ))}
            </div>
            {view.run && (
              <Button
                size="sm"
                onClick={() => void revealFiles()}
                data-testid="inspector-raw-files"
              >
                Raw files
              </Button>
            )}
          </div>
        </header>

        {(listError || view.error || filesError) && (
          <div className={styles.inspectorBanner} role="alert">
            <span>{listError || view.error || filesError}</span>
            {(listError || view.error) && (
              <Button size="sm" onClick={() => void retry()}>
                Retry
              </Button>
            )}
          </div>
        )}

        {((listLoading && !runs.length && !listError) ||
          (view.loading && runId && !view.error)) && (
          <div className={styles.inspectorSkeleton} aria-hidden>
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
          <div className={styles.inspectorEmpty}>
            <p className="faint">No phases match this filter.</p>
            {filter !== 'all' && (
              <Button size="sm" onClick={() => setFilter('all')}>
                Show all phases
              </Button>
            )}
          </div>
        )}
        {!view.loading && runId && visibleLanes.length > 0 && (
          <div
            className={`${styles.inspectorGrid} ${isFocused ? styles.inspectorGridFocused : ''}`}
            style={{ '--lane-count': laneCount } as React.CSSProperties}
          >
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
        <InspectorFooter
          hasVisibleTools={hasVisibleTools}
          laneCount={laneCount}
          onLaneCount={setLaneCount}
          onCollapse={() => setCollapseSignal((n) => n + 1)}
        />
      </div>
    </CollapseContext.Provider>
  );
}
