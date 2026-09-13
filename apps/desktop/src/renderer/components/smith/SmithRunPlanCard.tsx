import { useEffect, useState } from 'react';
import type { ProposalSnapshot, SmithRunPlanArtifact } from '@shared/types.js';
import { smithRunPlanArtifact } from '@shared/smith-run-plan.js';
import { api } from '../../api.js';
import { ProposalRow } from '../run/ProposalList.js';
import styles from './SmithRunPlanDesign.module.css';

/** Persisted cards are snapshots. Only a fresh durable row supplies actionable plans. */
export default function SmithRunPlanCard({
  artifact,
  onOpen,
}: {
  artifact: SmithRunPlanArtifact;
  onOpen?: (runId: string) => void;
}): React.JSX.Element {
  const [live, setLive] = useState<ProposalSnapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async (): Promise<void> => {
      const current = ++request;
      const row = await api.orchestrator.get?.(artifact.planId).catch(() => null);
      if (active && current === request) setLive(row ?? null);
    };
    void refresh();
    const off = api.on('proposals-changed', () => void refresh());
    return () => {
      active = false;
      off();
    };
  }, [artifact.planId]);

  const regenerate = (): void => {
    void (async () => {
      const row = await api.orchestrator.get?.(artifact.planId);
      if (!row) throw new Error('Proposal unavailable.');
      const result = await api.orchestrator.plan(
        row.projectId,
        row.prompt,
        row.model,
        row.reasoningEffort,
      );
      if ('error' in result) throw new Error(result.error);
    })().catch((cause: Error) => setError(cause.message));
  };
  const shown = live ? smithRunPlanArtifact(live) : artifact;
  return (
    <div data-testid="smith-run-plan" data-plan-status={shown.status}>
      <p className={styles.summary} role="status">
        {shown.status} · revision {shown.revision}
        {!live && ' · snapshot'}
      </p>
      {error && <p role="alert">{error}</p>}
      {live && !['accepted', 'discarded'].includes(live.status) ? (
        <ProposalRow
          proposal={live}
          baseSyncing={false}
          focusRequested={false}
          onOpen={(runId) => onOpen?.(runId)}
          onRetry={regenerate}
        />
      ) : (
        <div className={styles.section} data-testid="plan-card">
          <h3 className={styles.title}>{shown.title}</h3>
          <p className={styles.brief}>{shown.refinedRequest}</p>
          <ol>
            {shown.phases.map((phase) => (
              <li key={phase.index}>
                {phase.name} · {phase.agent ?? phase.command} {phase.model} {phase.reasoningEffort}
              </li>
            ))}
          </ol>
          <p className={styles.rationale}>{shown.rationale}</p>
          {shown.warnings.length > 0 && (
            <ul>
              {shown.warnings.map((warning, index) => (
                <li key={index}>
                  {warning.where}: {warning.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
