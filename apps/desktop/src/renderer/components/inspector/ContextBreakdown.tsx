/**
 * What is actually filling an agent's context, disclosed beside the lane's
 * context meter. The meter says how full the window is; this says what is in it,
 * which is the difference between "compaction is coming" and knowing why.
 *
 * The data is read live off the agent's own session, so it exists only while the
 * run does. Every way it can be absent has its own sentence: a panel that opens
 * onto nothing is indistinguishable from a broken one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextBreakdown as Breakdown } from '@shared/types.js';
import type { ContextBreakdownReason } from '@shared/ipc-contract.js';
import { modelLabel } from '@shared/model-label.js';
import { api } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { clockTime, tokens } from '../../utils/format.js';
import styles from './ContextBreakdown.module.css';

/** Why there is nothing to show, said in the operator's terms. */
const REASON_COPY: Record<ContextBreakdownReason, string> = {
  not_live:
    'Breakdown unavailable: this run has finished and never recorded one — it is read from a live session.',
  not_started: 'Breakdown unavailable: this agent has not opened a session yet.',
  no_session_context:
    'Breakdown unavailable: this agent runs one turn per process, so there is no conversation to account for.',
  unanswered: 'Breakdown unavailable: the agent’s session did not answer the request.',
};

interface State {
  loading: boolean;
  breakdown: Breakdown | null;
  /** Empty when a breakdown is showing; otherwise why it is not. */
  message: string;
  /** Set when the numbers came from a snapshot rather than the live session. */
  capturedAt: string;
}

const EMPTY: State = { loading: false, breakdown: null, message: '', capturedAt: '' };

/**
 * Pi reports occupancy as one number for the whole conversation, so this is a
 * used/free split rather than a composition. Two rows say what four honest
 * numbers can; anything finer would be invented.
 */
function Rows({ breakdown }: { breakdown: Breakdown }): React.JSX.Element {
  const budget = breakdown.contextBudget || breakdown.usedTokens || 1;
  const rows = [
    { name: 'Used', tokens: breakdown.usedTokens },
    { name: 'Free', tokens: breakdown.freeTokens },
  ].filter((row) => row.tokens > 0);
  return (
    <>
      <div className={styles.head}>
        <span className={styles.model}>
          {modelLabel(breakdown.modelDisplayName || breakdown.modelId)}
        </span>
        <span className={styles.total}>
          {tokens(breakdown.usedTokens)} of {tokens(breakdown.contextBudget)} used ·{' '}
          {tokens(breakdown.freeTokens)} free
        </span>
      </div>
      {rows.length > 0 ? (
        <ul className={styles.rows}>
          {rows.map((row) => (
            <li key={row.name} className={styles.row}>
              <span className={styles.rowName}>{row.name}</span>
              <span className={styles.rowBar} aria-hidden>
                <span
                  className={styles.rowFill}
                  style={{ width: `${Math.min(100, (row.tokens / budget) * 100)}%` }}
                />
              </span>
              <span className={styles.rowTokens}>{tokens(row.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.note}>
          The session reports no context yet — the first turn has not filled it.
        </p>
      )}
    </>
  );
}

export default function ContextBreakdownDisclosure({
  runId,
  agent,
}: {
  runId: string;
  agent: string;
}): React.JSX.Element {
  const { projectId } = useApp();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>(EMPTY);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<React.CSSProperties>({});

  const load = useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, loading: true, message: '' }));
    try {
      const result = await api.runs.contextBreakdown(projectId, runId, agent);
      setState({
        loading: false,
        breakdown: result.breakdown,
        message: result.breakdown ? '' : REASON_COPY[result.reason ?? 'unanswered'],
        capturedAt: result.breakdown && !result.live ? (result.capturedAt ?? '') : '',
      });
    } catch (e) {
      setState({
        ...EMPTY,
        message: `Breakdown unavailable: ${(e as Error).message}`,
      });
    }
  }, [projectId, runId, agent]);

  const close = useCallback(() => setOpen(false), []);

  // Read on open rather than on mount: it costs a round trip to a live session,
  // and a closed panel has nothing to show it with.
  useEffect(() => {
    if (open) void load();
    else setState(EMPTY);
  }, [open, load]);

  // Measure on open (and on viewport changes) so the panel never clips off-screen.
  useEffect(() => {
    if (!open) return;
    const measure = (): void => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;
      const gap = 6;
      const pad = 8;
      const panelWidth = 300;
      const panelMaxH = 340;
      const spaceBelow = viewportH - rect.bottom - pad;
      const spaceAbove = rect.top - pad;
      const openUp = spaceBelow < Math.min(200, panelMaxH) && spaceAbove > spaceBelow;
      const maxHeight = Math.min(panelMaxH, openUp ? spaceAbove - gap : spaceBelow - gap);
      // Keep the panel inside the viewport horizontally — align to the wrap's right edge.
      let left = rect.right - panelWidth;
      left = Math.max(pad, Math.min(left, viewportW - panelWidth - pad));
      setPanelStyle(
        openUp
          ? {
              top: rect.top - gap,
              left,
              width: panelWidth,
              maxHeight: Math.max(80, maxHeight),
              transform: 'translateY(-100%)',
            }
          : {
              top: rect.bottom + gap,
              left,
              width: panelWidth,
              maxHeight: Math.max(80, maxHeight),
            },
      );
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, state.breakdown, state.message]);

  // Escape dismisses, outside-click dismisses.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open, close]);

  return (
    <span ref={wrapRef} className={styles.wrap}>
      <button
        className={styles.toggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide context breakdown' : 'What is filling this context'}
      >
        {open ? '▾' : '▸'} ctx
      </button>
      {open &&
        createPortal(
          <div ref={panelRef} className={styles.panel} style={panelStyle}>
            <div className={styles.panelHead}>
              <span className="te-tag">context</span>
              <button
                className={styles.refresh}
                onClick={() => void load()}
                disabled={state.loading}
              >
                {state.loading ? 'reading…' : 'refresh'}
              </button>
            </div>
            {state.loading && !state.breakdown && (
              <p className={styles.note}>Reading the session…</p>
            )}
            {!state.loading && state.breakdown && (
              <>
                <Rows breakdown={state.breakdown} />
                {state.capturedAt && (
                  <p className={styles.note}>
                    As of this agent&rsquo;s last turn, {clockTime(state.capturedAt)}.
                  </p>
                )}
              </>
            )}
            {!state.loading && !state.breakdown && state.message && (
              <p className={styles.note}>{state.message}</p>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
