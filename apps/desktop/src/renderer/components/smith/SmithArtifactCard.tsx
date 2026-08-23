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
import { ChecklistDesign } from './SmithChecklistDesign.js';
import { AgentDesign, EnvelopeDesign, PipelineDesign, ViewJson } from './SmithEntityDesign.js';
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
  return <ChecklistDesign checklist={artifact.checklist} compact={compact} />;
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
      <ViewJson
        value={
          artifact.kind === 'pipeline_design'
            ? artifact.pipeline
            : artifact.kind === 'agent_design'
              ? artifact.agent
              : artifact.kind === 'envelope_design'
                ? artifact.envelope
                : artifact.checklist
        }
      />
    </section>
  );
}
