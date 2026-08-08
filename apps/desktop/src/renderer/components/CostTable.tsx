import { useMemo } from 'react';
import type { EventRow, PhaseRow } from '@shared/types.js';
import { credits, tokens } from '../format.js';
import { modelFor, usageFor } from '../derive.js';
import AgentAvatar from './AgentAvatar.js';
import styles from './CostTable.module.css';

export default function CostTable({
  phases,
  eventsByPhase,
}: {
  phases: PhaseRow[];
  eventsByPhase: Map<string, EventRow[]>;
}): React.JSX.Element {
  const rows = useMemo(
    () =>
      phases
        .filter((p) => p.kind === 'agent' && p.startedAt)
        .map((phase) => {
          const events = eventsByPhase.get(phase.phaseId) ?? [];
          return { phase, usage: usageFor(events), model: modelFor(events) };
        }),
    [phases, eventsByPhase],
  );

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, { usage }) => ({
          input: acc.input + usage.inputTokens,
          output: acc.output + usage.outputTokens,
          cacheRead: acc.cacheRead + usage.cacheReadTokens,
          thinking: acc.thinking + usage.thinkingTokens,
          credits: acc.credits + usage.credits,
        }),
        { input: 0, output: 0, cacheRead: 0, thinking: 0, credits: 0 },
      ),
    [rows],
  );

  return (
    <section className={styles.cost}>
      <table>
        <thead>
          <tr>
            <th className={styles.left}>Phase</th>
            <th className={styles.left}>Model</th>
            <th>Turns</th>
            <th>In</th>
            <th>Out</th>
            <th>Cache read</th>
            <th>Thinking</th>
            <th>Credits</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.phase.phaseId}>
              <td className={styles.left}>
                <span className={styles.phaseCell}>
                  <AgentAvatar name={row.phase.owner} size={20} />
                  {row.phase.name}
                </span>
              </td>
              <td className={`mono ${styles.model} ${styles.left}`}>{row.model ?? '—'}</td>
              <td className="mono">{row.usage.turns || '—'}</td>
              {row.usage.reported ? (
                <>
                  <td className="mono">{tokens(row.usage.inputTokens)}</td>
                  <td className="mono">{tokens(row.usage.outputTokens)}</td>
                  <td className={`mono ${styles.cache}`}>{tokens(row.usage.cacheReadTokens)}</td>
                  <td className="mono">{tokens(row.usage.thinkingTokens)}</td>
                  <td className="mono">{credits(row.usage.credits)}</td>
                </>
              ) : (
                <td colSpan={5} className={`faint ${styles.unreported}`}>
                  the model did not report usage
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr>
              <td className={styles.left}>Total</td>
              <td colSpan={2} />
              <td className="mono">{tokens(totals.input)}</td>
              <td className="mono">{tokens(totals.output)}</td>
              <td className={`mono ${styles.cache}`}>{tokens(totals.cacheRead)}</td>
              <td className="mono">{tokens(totals.thinking)}</td>
              <td className="mono">{credits(totals.credits)}</td>
            </tr>
          </tfoot>
        )}
      </table>
      {!rows.length && (
        <p className={`faint ${styles.none}`}>No agent phases ran, so nothing was spent.</p>
      )}
    </section>
  );
}
