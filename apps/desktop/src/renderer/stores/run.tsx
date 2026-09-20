/**
 * Live view of one run, plus the project run list. Polling is deliberate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  EnvelopeRow,
  EventRow,
  GateResultRow,
  PhaseRow,
  RunRow,
  AgentSessionRow,
} from '@shared/types.js';
import { api } from '../api.js';
import { useProposals } from '../hooks/useProposals.js';
import { pollWhileVisible } from '../utils/visible-poll.js';
import {
  selectActivityItems,
  selectActivityRuns,
  type ActivityItem,
} from '../view-models/activity-runs.js';

export interface RunView {
  run: RunRow | null;
  phases: PhaseRow[];
  events: EventRow[];
  envelopes: EnvelopeRow[];
  gates: GateResultRow[];
  sessions: AgentSessionRow[];
  live: boolean;
  cursor: number;
  loading: boolean;
  error: string;
}

function emptyView(): RunView {
  return {
    run: null,
    phases: [],
    events: [],
    envelopes: [],
    gates: [],
    sessions: [],
    live: false,
    cursor: 0,
    loading: true,
    error: '',
  };
}

function groupByPhaseId<T extends { phaseId: string | null }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    if (!row.phaseId) continue;
    const list = map.get(row.phaseId) ?? [];
    list.push(row);
    map.set(row.phaseId, list);
  }
  return map;
}

/**
 * The cursor re-serves rows patched in place (tool results, growing text), so
 * merge by eventId rather than append: new rows land in order, updated rows
 * replace their earlier selves.
 */
function mergeEvents(prev: EventRow[], incoming: EventRow[]): EventRow[] {
  if (!incoming.length) return prev;
  const indexById = new Map(prev.map((e, i) => [e.eventId, i]));
  const next = [...prev];
  for (const event of incoming) {
    const at = indexById.get(event.eventId);
    if (at === undefined) {
      indexById.set(event.eventId, next.length);
      next.push(event);
    } else {
      next[at] = event;
    }
  }
  return next;
}

export function useRun(
  projectId: string,
  runId: string,
): {
  view: RunView;
  refresh: () => Promise<void>;
  eventsByPhase: Map<string, EventRow[]>;
  envelopesByPhase: Map<string, EnvelopeRow[]>;
  gatesByPhase: Map<string, GateResultRow[]>;
} {
  const [view, setView] = useState<RunView>(emptyView);
  const pollRef = useRef<ReturnType<typeof pollWhileVisible> | null>(null);
  const refresh = useCallback(async () => {
    await pollRef.current?.refresh();
  }, []);

  useEffect(() => {
    setView(emptyView());
    if (!projectId || !runId) return;
    let cursor = 0;
    let live = false;
    const poll = pollWhileVisible(
      async (signal) => {
        try {
          const [detail, page] = await Promise.all([
            api.runs.detail(projectId, runId),
            api.runs.events(projectId, runId, cursor),
          ]);
          if (signal.aborted) return;
          live = detail.live;
          if (page.events.length) cursor = page.cursor;
          setView((prev) => ({
            ...detail,
            events: mergeEvents(prev.events, page.events),
            cursor,
            loading: false,
            error: '',
          }));
        } catch (e) {
          if (!signal.aborted) {
            setView((prev) => ({ ...prev, loading: false, error: (e as Error).message }));
          }
        }
      },
      () => (live ? 500 : 3000),
    );
    pollRef.current = poll;
    return () => {
      poll.stop();
      pollRef.current = null;
    };
  }, [projectId, runId]);

  const eventsByPhase = useMemo(() => groupByPhaseId(view.events), [view.events]);
  const envelopesByPhase = useMemo(() => groupByPhaseId(view.envelopes), [view.envelopes]);
  const gatesByPhase = useMemo(() => groupByPhaseId(view.gates), [view.gates]);

  return { view, refresh, eventsByPhase, envelopesByPhase, gatesByPhase };
}

/** The runs list for a project, polled while any run is live. */
export function useRunList(
  projectId: string,
  includeArchived: boolean,
): {
  runs: RunRow[];
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
} {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const pollRef = useRef<ReturnType<typeof pollWhileVisible> | null>(null);
  const refresh = useCallback(async () => {
    await pollRef.current?.refresh();
  }, []);

  useEffect(() => {
    setRuns([]);
    setError('');
    setLoading(Boolean(projectId));
    if (!projectId) {
      return;
    }
    let live = false;
    const poll = pollWhileVisible(
      async (signal) => {
        try {
          const next = await api.runs.list(projectId, includeArchived);
          if (signal.aborted) return;
          live = next.some((run) => run.status === 'running');
          setRuns(next);
          setError('');
        } catch (e) {
          if (!signal.aborted) setError((e as Error).message);
        } finally {
          if (!signal.aborted) setLoading(false);
        }
      },
      () => (live ? 800 : 4000),
    );
    pollRef.current = poll;
    const off = api.on('runs-changed', () => void poll.refresh());
    return () => {
      off();
      poll.stop();
      pollRef.current = null;
    };
  }, [projectId, includeArchived]);

  return { runs, loading, error, refresh };
}

/**
 * Selected-project Activity, proposals interleaved with runs in sidebar
 * order (generating proposals, live runs, ready/failed proposals, recent
 * finished runs). The component renders the order verbatim.
 */
export function useActivityItems(projectId: string, recentLimit = 5): { items: ActivityItem[] } {
  const { runs } = useRunList(projectId, false);
  const { proposals } = useProposals(projectId);
  const items = useMemo(
    () => selectActivityItems(runs, proposals, projectId, recentLimit),
    [runs, proposals, projectId, recentLimit],
  );
  return { items };
}

/** Selected-project Activity: every live run plus a short recency cap of finished runs. */
export function useActivityRuns(projectId: string, recentLimit = 5): { runs: RunRow[] } {
  const { runs } = useRunList(projectId, false);
  const activityRuns = useMemo(
    () => selectActivityRuns(runs, projectId, recentLimit),
    [runs, projectId, recentLimit],
  );
  return { runs: activityRuns };
}
