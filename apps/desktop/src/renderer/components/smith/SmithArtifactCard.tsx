/**
 * One rich artifact card in the Smith transcript: a design `smith_present`
 * emitted, or a receipt main recorded when an approved action settled.
 *
 * Read-only by contract: an artifact never blocks, never looks pending, and
 * carries no approval controls — the accent-bordered proposal card stays the
 * only element in the conversation waiting on the human. A receipt's link is
 * navigation, not a retry: it opens what the action affected and re-runs
 * nothing. Unknown kinds and versions fail soft to a readable note so a
 * downgraded build still restores the chat around them.
 */

import type { SmithArtifact, SmithReceiptLink } from '@shared/types.js';
import {
  ARTIFACT_KIND_LABEL,
  artifactName,
  isRenderableArtifact,
} from '../../view-models/smith-artifact-view.js';
import SmithActionReceiptBody from './SmithActionReceipt.js';
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

function ArtifactBody({
  artifact,
  compact,
  onOpenReceiptLink,
}: {
  artifact: SmithArtifact;
  compact?: boolean;
  onOpenReceiptLink?: (link: SmithReceiptLink) => void;
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
  if (artifact.kind === 'pr_card') {
    return <PrCardDesign pr={artifact.pr} compact={compact} />;
  }
  return (
    <SmithActionReceiptBody
      receipt={artifact.receipt}
      compact={compact}
      {...(onOpenReceiptLink ? { onOpenLink: onOpenReceiptLink } : {})}
    />
  );
}

/** The JSON an audit reader wants: the definition, or the record of what ran. */
function auditValue(artifact: SmithArtifact): unknown {
  if (artifact.kind === 'pipeline_design') return artifact.pipeline;
  if (artifact.kind === 'agent_design') return artifact.agent;
  if (artifact.kind === 'envelope_design') return artifact.envelope;
  if (artifact.kind === 'checklist') return artifact.checklist;
  if (artifact.kind === 'change_receipt' || artifact.kind === 'action_receipt') {
    return artifact.receipt;
  }
  if (artifact.kind === 'project_card') return artifact.project;
  if (artifact.kind === 'pr_card') return artifact.pr;
  if (artifact.kind === 'engineer_checkpoint') return artifact.checkpoint;
  if (artifact.kind === 'readiness_journey') return artifact.journey;
  if (artifact.kind === 'provider_status') return artifact.status;
  return { before: artifact.before, after: artifact.after };
}

export default function SmithArtifactCard({
  artifact,
  compact,
  onOpenReceiptLink,
}: {
  artifact: SmithArtifact;
  /** Tighter layout for the titlebar bubble; same data, no overflow. */
  compact?: boolean;
  /** Follows a receipt's link. Absent means the receipt shows it as plain text. */
  onOpenReceiptLink?: (link: SmithReceiptLink) => void;
}): React.JSX.Element {
  if (!isRenderableArtifact(artifact)) {
    return (
      <section className={styles.card} data-testid="smith-artifact-fallback">
        <p className={styles.fallback}>
          Smith presented a card this version of Foundry cannot render.
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
      data-artifact-kind={artifact.kind}
    >
      <header className={styles.header}>
        <span className={styles.kind}>{ARTIFACT_KIND_LABEL[artifact.kind]}</span>
        <h3 className={styles.title}>{artifactName(artifact)}</h3>
      </header>
      <ArtifactBody
        artifact={artifact}
        compact={compact}
        {...(onOpenReceiptLink ? { onOpenReceiptLink } : {})}
      />
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
      <ViewJson value={auditValue(artifact)} />
    </section>
  );
}
