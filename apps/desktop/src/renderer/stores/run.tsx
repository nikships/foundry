/**
 * Live view of one run, plus the project run list. Polling is deliberate.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EnvelopeRow, EventRow, GateResultRow, PhaseRow, RunRow, AgentSessionRow } from '@shared/types.js';
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

function groupByPhaseId<T extends { phaseId: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.phaseId) ?? [];
    list.push(row);
    map.set(row.phaseId, list);
  }
  return map;
}

export function useRun(projectId: string, runId: string): {
  view: RunView;
  refresh: () => Promise<void>;
  eventsByPhase: Map<string, EventRow[]>;
  envelopesByPhase: Map<string, EnvelopeRow[]>;
  gatesByPhase: Map<string, GateResultRow[]>;
} {
  const { settings } = useApp();
  const [view, setView] = useState<RunView>(emptyView);

  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);
  const disposedRef = useRef(false);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (disposedRef.current) return;
    const cadence = viewRef.current.live ? (settings?.pollCadenceMs ?? 500) : 3000;
    timerRef.current = window.setTimeout(() => void tick(), cadence);
  }, [settings?.pollCadenceMs]);

  const tick = useCallback(async (): Promise<void> => {
    if (inFlightRef.current || disposedRef.current || !projectId || !runId) return;
    inFlightRef.current = true;
    try {
      const [detail, page] = await Promise.all([
        api.runs.detail(projectId, runId),
        api.runs.events(projectId, runId, viewRef.current.cursor),
      ]);
      setView((prev) => {
        // The cursor re-serves rows patched in place (tool results, growing
        // text), so merge by eventId rather than append: new rows land in
        // order, updated rows replace their earlier selves.
        let nextEvents = prev.events;
        if (page.events.length) {
          const indexById = new Map(prev.events.map((e, i) => [e.eventId, i]));
          nextEvents = [...prev.events];
          for (const event of page.events) {
            const at = indexById.get(event.eventId);
            if (at === undefined) {
              indexById.set(event.eventId, nextEvents.length);
              nextEvents.push(event);
            } else {
              nextEvents[at] = event;
            }
          }
        }
        return {
          run: detail.run,
          phases: detail.phases,
          envelopes: detail.envelopes,
          gates: detail.gates,
          sessions: detail.sessions,
          live: detail.live,
          events: nextEvents,
          cursor: page.events.length ? page.cursor : prev.cursor,
          loading: false,
          error: '',
        };
      });
    } catch (e) {
      setView((prev) => ({ ...prev, loading: false, error: (e as Error).message }));
    } finally {
      inFlightRef.current = false;
      schedule();
    }
  }, [projectId, runId, schedule]);

  useEffect(() => {
    disposedRef.current = false;
    const reset = emptyView();
    setView(reset);
    viewRef.current = reset;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    void tick();
    return () => {
      disposedRef.current = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [projectId, runId, tick]);

  const eventsByPhase = useMemo(() => {
    const map = new Map<string, EventRow[]>();
    for (const event of view.events) {
      if (!event.phaseId) continue;
      const list = map.get(event.phaseId) ?? [];
      list.push(event);
      map.set(event.phaseId, list);
    }
    return map;
  }, [view.events]);

  const envelopesByPhase = useMemo(() => groupByPhaseId(view.envelopes), [view.envelopes]);
  const gatesByPhase = useMemo(() => groupByPhaseId(view.gates), [view.gates]);

  return { view, refresh: tick, eventsByPhase, envelopesByPhase, gatesByPhase };
}

/** The runs list for a project, polled while any run is live. */
export function useRunList(projectId: string, includeArchived: boolean): {
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
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (disposedRef.current) return;
    const anyLive = runsRef.current.some((r) => r.status === 'running');
    timerRef.current = window.setTimeout(() => void tick(), anyLive ? 800 : 4000);
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
    disposedRef.current = false;
    void tick();
    const off = api.on('runs-changed', () => void tick());
    return () => {
      disposedRef.current = true;
      off();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [tick]);

  return { runs, loading, error, refresh: tick };
}
