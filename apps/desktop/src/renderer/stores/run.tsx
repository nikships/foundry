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
import { useApp } from './app.js';

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

function cancelTimer(ref: { current: number | null }): void {
  if (ref.current !== null) window.clearTimeout(ref.current);
  ref.current = null;
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

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const disposedRef = useRef(false);
  // Ref breaks the schedule <-> tick cycle without stale timeouts.
  const tickRef = useRef<() => Promise<void>>(async () => {});

  const schedule = useCallback(() => {
    cancelTimer(timerRef);
    if (disposedRef.current) return;
    const cadence = viewRef.current.live ? 500 : 3000;
    timerRef.current = window.setTimeout(() => void tickRef.current(), cadence);
  }, []);

  const tick = useCallback(async (): Promise<void> => {
    if (inFlightRef.current || disposedRef.current || !projectId || !runId) return;
    inFlightRef.current = true;
    try {
      const [detail, page] = await Promise.all([
        api.runs.detail(projectId, runId),
        api.runs.events(projectId, runId, viewRef.current.cursor),
      ]);
      setView((prev) => ({
        run: detail.run,
        phases: detail.phases,
        envelopes: detail.envelopes,
        gates: detail.gates,
        sessions: detail.sessions,
        live: detail.live,
        events: mergeEvents(prev.events, page.events),
        cursor: page.events.length ? page.cursor : prev.cursor,
        loading: false,
        error: '',
      }));
    } catch (e) {
      setView((prev) => ({ ...prev, loading: false, error: (e as Error).message }));
    } finally {
      inFlightRef.current = false;
      schedule();
    }
  }, [projectId, runId, schedule]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    disposedRef.current = false;
    const reset = emptyView();
    setView(reset);
    viewRef.current = reset;
    cancelTimer(timerRef);
    void tick();
    return () => {
      disposedRef.current = true;
      cancelTimer(timerRef);
    };
  }, [projectId, runId, tick]);

  const eventsByPhase = useMemo(() => groupByPhaseId(view.events), [view.events]);
  const envelopesByPhase = useMemo(() => groupByPhaseId(view.envelopes), [view.envelopes]);
  const gatesByPhase = useMemo(() => groupByPhaseId(view.gates), [view.gates]);

  return { view, refresh: tick, eventsByPhase, envelopesByPhase, gatesByPhase };
}

/**
 * Runs across every project for the sidebar: everything live plus the most
 * recently finished, newest first. Trace DBs are sharded per project, so this
 * fans one list call out per project and merges.
 */
export function useAllProjectRuns(recentLimit = 5): { runs: RunRow[] } {
  const { projects } = useApp();
  const [runs, setRuns] = useState<RunRow[]>([]);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const disposedRef = useRef(false);
  const tickRef = useRef<() => Promise<void>>(async () => {});

  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);

  const schedule = useCallback(() => {
    cancelTimer(timerRef);
    if (disposedRef.current) return;
    timerRef.current = window.setTimeout(() => void tickRef.current(), 500);
  }, []);

  const tick = useCallback(async (): Promise<void> => {
    if (inFlightRef.current || disposedRef.current) return;
    if (!projectIds.length) {
      setRuns([]);
      return;
    }
    inFlightRef.current = true;
    try {
      const lists = await Promise.all(projectIds.map((id) => api.runs.list(id, false)));
      const all = lists.flat();
      const running = all
        .filter((r) => r.status === 'running')
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      const finished = all
        .filter((r) => r.status !== 'running')
        .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
        .slice(0, recentLimit);
      setRuns([...running, ...finished]);
    } catch {
      // The sidebar list is ambient; a failed poll just waits for the next.
    } finally {
      inFlightRef.current = false;
      schedule();
    }
  }, [projectIds, recentLimit, schedule]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    disposedRef.current = false;
    void tick();
    const off = api.on('runs-changed', () => void tick());
    return () => {
      disposedRef.current = true;
      off();
      cancelTimer(timerRef);
    };
  }, [tick]);

  return { runs };
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
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const disposedRef = useRef(false);
  const runsRef = useRef(runs);
  const tickRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  const schedule = useCallback(() => {
    cancelTimer(timerRef);
    if (disposedRef.current) return;
    const anyLive = runsRef.current.some((r) => r.status === 'running');
    timerRef.current = window.setTimeout(() => void tickRef.current(), anyLive ? 800 : 4000);
  }, []);

  const tick = useCallback(async (): Promise<void> => {
    if (inFlightRef.current || disposedRef.current) return;
    if (!projectId) {
      setRuns([]);
      setLoading(false);
      return;
    }
    inFlightRef.current = true;
    try {
      setRuns(await api.runs.list(projectId, includeArchived));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      inFlightRef.current = false;
      schedule();
    }
  }, [projectId, includeArchived, schedule]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  useEffect(() => {
    disposedRef.current = false;
    void tick();
    const off = api.on('runs-changed', () => void tick());
    return () => {
      disposedRef.current = true;
      off();
      cancelTimer(timerRef);
    };
  }, [tick]);

  return { runs, loading, error, refresh: tick };
}
