import { useState } from 'react';
import type { SmithRunPlanArtifact } from '@shared/types.js';
import { smithRunPlanArtifact } from '@shared/smith-run-plan.js';
import { api } from '../../api.js';
import { useProposal } from '../../hooks/useProposal.js';
import { useSmithChatUI } from '../../stores/smith-chat-ui.js';
import { ProposalRow } from '../run/ProposalList.js';
import { EarlierPlanDiscussion } from './SmithRunPlanDesign.js';
import styles from './SmithRunPlanDesign.module.css';

/** Persisted cards are snapshots. Only a fresh durable row supplies actionable plans. */
export default function SmithRunPlanCard({
  artifact,
}: {
  artifact: SmithRunPlanArtifact;
}): React.JSX.Element {
  const { openReceiptLink } = useSmithChatUI();
  const live = useProposal(artifact.planId);
  const [error, setError] = useState('');

  const regenerate = (): void => {
    void (async () => {
      const row = await api.compose.get?.(artifact.planId);
      if (!row) throw new Error('Proposal unavailable.');
      const result = await api.compose.start(
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
          onOpen={(runId) =>
            openReceiptLink({ kind: 'run', label: 'Open run', projectId: live.projectId, runId })
          }
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
          {live && <EarlierPlanDiscussion messages={live.messages} />}
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
