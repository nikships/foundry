/**
 * One rich artifact card in the Smith transcript, emitted by `smith_present`.
 *
 * Read-only by contract: an artifact never blocks, never looks pending, and
 * carries no approval controls — the accent-bordered proposal card stays the
 * only element in the conversation waiting on the human. Unknown kinds and
 * versions fail soft to a readable note so a downgraded build still restores
 * the chat around them.
 */

import type { SmithArtifact } from '@shared/types.js';
import {
  ARTIFACT_KIND_LABEL,
  artifactName,
  isRenderableArtifact,
} from '../../view-models/smith-artifact-view.js';
import { ChangeReceiptDesign } from './SmithChangeReceiptDesign.js';
import { CheckpointDesign } from './SmithCheckpointDesign.js';
import { ChecklistDesign } from './SmithChecklistDesign.js';
import { EntityComparisonDesign } from './SmithEntityComparisonDesign.js';
import { ProjectCardDesign } from './SmithProjectCardDesign.js';
import { PrCardDesign } from './SmithPrCardDesign.js';
import { AgentDesign, EnvelopeDesign, PipelineDesign, ViewJson } from './SmithEntityDesign.js';
import { ProviderStatusDesign } from './SmithProviderStatusDesign.js';
import { ReadinessJourneyDesign } from './SmithReadinessJourneyDesign.js';
import styles from './SmithArtifactCard.module.css';

function DesignBody({
  artifact,
  compact,
}: {
  artifact: SmithArtifact;
  compact?: boolean;
}): React.JSX.Element {
  if (artifact.kind === 'pipeline_design') {
    return <PipelineDesign pipeline={artifact.pipeline} compact={compact} />;
  }
  if (artifact.kind === 'agent_design') {
    return <AgentDesign agent={artifact.agent} compact={compact} />;
  }
  if (artifact.kind === 'envelope_design') {
    return <EnvelopeDesign envelope={artifact.envelope} compact={compact} />;
  }
  if (artifact.kind === 'checklist') {
    return <ChecklistDesign checklist={artifact.checklist} compact={compact} />;
  }
  if (artifact.kind === 'entity_comparison') {
    return <EntityComparisonDesign artifact={artifact} compact={compact} />;
  }
  if (artifact.kind === 'change_receipt') {
    return <ChangeReceiptDesign receipt={artifact.receipt} compact={compact} />;
  }
  if (artifact.kind === 'project_card') {
    return <ProjectCardDesign project={artifact.project} compact={compact} />;
  }
  if (artifact.kind === 'engineer_checkpoint') {
    return <CheckpointDesign checkpoint={artifact.checkpoint} compact={compact} />;
  }
  if (artifact.kind === 'readiness_journey') {
    return <ReadinessJourneyDesign journey={artifact.journey} compact={compact} />;
  }
  if (artifact.kind === 'provider_status') {
    return <ProviderStatusDesign status={artifact.status} compact={compact} />;
  }
  return <PrCardDesign pr={artifact.pr} compact={compact} />;
}

/** The payload the audit disclosure shows for each kind. */
function artifactPayload(artifact: SmithArtifact): unknown {
  switch (artifact.kind) {
    case 'pipeline_design':
      return artifact.pipeline;
    case 'agent_design':
      return artifact.agent;
    case 'envelope_design':
      return artifact.envelope;
    case 'checklist':
      return artifact.checklist;
    case 'entity_comparison':
      return { before: artifact.before, after: artifact.after };
    case 'engineer_checkpoint':
      return artifact.checkpoint;
    case 'readiness_journey':
      return artifact.journey;
    case 'provider_status':
      return artifact.status;
    case 'change_receipt':
      return artifact.receipt;
    case 'project_card':
      return artifact.project;
    case 'pr_card':
      return artifact.pr;
  }
}

export default function SmithArtifactCard({
  artifact,
  compact,
}: {
  artifact: SmithArtifact;
  /** Tighter layout for the titlebar bubble; same data, no overflow. */
  compact?: boolean;
}): React.JSX.Element {
  if (!isRenderableArtifact(artifact)) {
    return (
      <section className={styles.card} data-testid="smith-artifact-fallback">
        <p className={styles.fallback}>
          Smith presented a design this version of Foundry cannot render.
        </p>
        <ViewJson value={artifact} />
      </section>
    );
  }

  return (
    <section
      className={styles.card}
      aria-label={`${ARTIFACT_KIND_LABEL[artifact.kind]}: ${artifactName(artifact)}`}
      data-testid="smith-artifact-card"
    >
      <header className={styles.header}>
        <span className={styles.kind}>{ARTIFACT_KIND_LABEL[artifact.kind]}</span>
        <h3 className={styles.title}>{artifactName(artifact)}</h3>
      </header>
      <DesignBody artifact={artifact} compact={compact} />
      {artifact.warnings.length > 0 && (
        <ul className={styles.warnings}>
          {artifact.warnings.map((issue, index) => (
            <li key={`${issue.where}-${index}`} className={styles.warning}>
              <span className={styles.warningWhere}>{issue.where}</span>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
      {artifact.rationale && <p className={styles.rationale}>{artifact.rationale}</p>}
      <ViewJson value={artifactPayload(artifact)} />
    </section>
  );
}
