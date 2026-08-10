/**
 * What is actually filling an agent's context, disclosed beside the lane's
 * context meter. The meter says how full the window is; this says what is in it,
 * which is the difference between "compaction is coming" and knowing why.
 *
 * The data is read live off the agent's own session, so it exists only while the
 * run does. Every way it can be absent has its own sentence: a panel that opens
 * onto nothing is indistinguishable from a broken one.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ContextBreakdown as Breakdown } from '@shared/types.js';
import type { ContextBreakdownReason } from '@shared/ipc-contract.js';
import { api } from '../../api.js';
import { useApp } from '../../stores/app.js';
import { clockTime, tokens } from '../../format.js';
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

/** Lists worth showing under the categories, in the order they earn attention. */
const EXTRA_LISTS = [
  { key: 'skills', label: 'Skills' },
  { key: 'mcpServers', label: 'MCP servers' },
  { key: 'droids', label: 'Droids' },
] as const;

interface State {
  loading: boolean;
  breakdown: Breakdown | null;
  /** Empty when a breakdown is showing; otherwise why it is not. */
  message: string;
  /** Set when the numbers came from a snapshot rather than the live session. */
  capturedAt: string;
}

const EMPTY: State = { loading: false, breakdown: null, message: '', capturedAt: '' };

function Rows({ breakdown }: { breakdown: Breakdown }): React.JSX.Element {
  const budget = breakdown.contextBudget || breakdown.usedTokens || 1;
  const categories = [...breakdown.categories]
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  return (
    <>
      <div className={styles.head}>
        <span className={styles.model}>{breakdown.modelDisplayName || breakdown.modelId}</span>
        <span className={styles.total}>
          {tokens(breakdown.usedTokens)} of {tokens(breakdown.contextBudget)} used ·{' '}
          {tokens(breakdown.freeTokens)} free
        </span>
      </div>
      {categories.length > 0 ? (
        <ul className={styles.rows}>
          {categories.map((category) => (
            <li key={category.colorKey || category.name} className={styles.row}>
              <span className={styles.rowName}>{category.name}</span>
              <span className={styles.rowBar} aria-hidden>
                <span
                  className={styles.rowFill}
                  style={{ width: `${Math.min(100, (category.tokens / budget) * 100)}%` }}
                />
              </span>
              <span className={styles.rowTokens}>{tokens(category.tokens)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.note}>
          The session reports no categorised context yet — the first turn has not filled it.
        </p>
      )}
      {EXTRA_LISTS.map(({ key, label }) => {
        const entries = breakdown[key];
        if (!entries.length) return null;
        return (
          <div key={key} className={styles.list}>
            <span className={styles.listLabel}>{label}</span>
            <span className={styles.listValue}>
              {entries
                .map((entry) => `${entry.name} (${tokens(entry.tokens)})`)
                .slice(0, 6)
                .join(', ')}
              {entries.length > 6 ? ` +${entries.length - 6} more` : ''}
            </span>
          </div>
        );
      })}
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

  // Read on open rather than on mount: it costs a round trip to a live session,
  // and a closed panel has nothing to show it with.
  useEffect(() => {
    if (open) void load();
    else setState(EMPTY);
  }, [open, load]);

  return (
    <span className={styles.wrap}>
      <button
        className={styles.toggle}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? 'Hide context breakdown' : 'What is filling this context'}
      >
        {open ? '▾' : '▸'} ctx
      </button>
      {open && (
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <span className="te-tag">context</span>
            <button className={styles.refresh} onClick={() => void load()} disabled={state.loading}>
              {state.loading ? 'reading…' : 'refresh'}
            </button>
          </div>
          {state.loading && !state.breakdown && <p className={styles.note}>Reading the session…</p>}
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
        </div>
      )}
    </span>
  );
}
