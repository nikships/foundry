import { useMemo } from 'react';
import type { EventRow, PhaseRow } from '@shared/types.js';
import { credits, tokens } from '../format.js';
import { modelFor, usageFor } from '../derive.js';
import AgentAvatar from './AgentAvatar.js';

export default function CostTable({ phases, eventsByPhase }: { phases: PhaseRow[]; eventsByPhase: Map<string, EventRow[]> }): React.JSX.Element {
  const rows = useMemo(() =>
    phases.filter((p) => p.kind === 'agent' && p.startedAt).map((phase) => {
      const events = eventsByPhase.get(phase.phaseId) ?? [];
      return { phase, usage: usageFor(events), model: modelFor(events) };
    }), [phases, eventsByPhase]);

  const totals = useMemo(() =>
    rows.reduce((acc, { usage }) => ({
      input: acc.input + usage.inputTokens,
      output: acc.output + usage.outputTokens,
      cacheRead: acc.cacheRead + usage.cacheReadTokens,
      thinking: acc.thinking + usage.thinkingTokens,
      credits: acc.credits + usage.credits,
    }), { input: 0, output: 0, cacheRead: 0, thinking: 0, credits: 0 }), [rows]);

  return (
    <>
      <section className="cost">
        <table>
          <thead>
            <tr>
              <th className="left">Phase</th>
              <th className="left">Model</th>
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
                <td className="left">
                  <span className="phase-cell">
                    <AgentAvatar name={row.phase.owner} size={20} />
                    {row.phase.name}
                  </span>
                </td>
                <td className="left mono model">{row.model ?? '—'}</td>
                <td className="mono">{row.usage.turns || '—'}</td>
                {row.usage.reported ? (
                  <>
                    <td className="mono">{tokens(row.usage.inputTokens)}</td>
                    <td className="mono">{tokens(row.usage.outputTokens)}</td>
                    <td className="mono cache">{tokens(row.usage.cacheReadTokens)}</td>
                    <td className="mono">{tokens(row.usage.thinkingTokens)}</td>
                    <td className="mono">{credits(row.usage.credits)}</td>
                  </>
                ) : (
                  <td colSpan={5} className="faint unreported">the model did not report usage</td>
                )}
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                <td className="left">Total</td>
                <td colSpan={2} />
                <td className="mono">{tokens(totals.input)}</td>
                <td className="mono">{tokens(totals.output)}</td>
                <td className="mono cache">{tokens(totals.cacheRead)}</td>
                <td className="mono">{tokens(totals.thinking)}</td>
                <td className="mono">{credits(totals.credits)}</td>
              </tr>
            </tfoot>
          )}
        </table>
        {!rows.length && <p className="faint none">No agent phases ran, so nothing was spent.</p>}
      </section>
      <style>{`
        .cost { margin: var(--s4) var(--s6) 0; padding: var(--s2); border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--bg-panel); animation: fade-in var(--fast) var(--ease); }
        .cost table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); }
        .cost th, .cost td { padding: var(--s2) var(--s3); text-align: right; white-space: nowrap; }
        .cost th { color: var(--text-faint); font-weight: 500; border-bottom: 1px solid var(--line-faint); }
        .cost .left { text-align: left; }
        .cost tbody tr:hover { background: var(--bg-hover); }
        .phase-cell { display: inline-flex; align-items: center; gap: var(--s2); }
        .model { color: var(--text-faint); max-width: 200px; overflow: hidden; text-overflow: ellipsis; }
        .cache { color: var(--green); }
        .unreported { text-align: center; font-style: italic; }
        .cost tfoot td { border-top: 1px solid var(--line-faint); font-weight: 600; }
        .none { padding: var(--s3); font-size: var(--text-sm); }
      `}</style>
    </>
  );
}
