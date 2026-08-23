/**
 * Read-only entity comparison design body for Smith's chat.
 *
 * Compares the current stored definition (fetched by main from the real store)
 * with a proposed edit (supplied by the model and validated against store rails).
 * Supports toggling between a unified semantic changes view and a side-by-side
 * or stacked before/after view.
 */

import { useMemo, useState } from 'react';
import type {
  AgentDef,
  EntityComparisonKind,
  EnvelopeDef,
  PipelineDef,
  SmithEntityComparisonArtifact,
} from '@shared/types.js';
import { compareEntities } from '../../view-models/smith-artifact-view.js';
import { AgentDesign, EnvelopeDesign, PipelineDesign } from './SmithEntityDesign.js';
import { cx } from '../ui/cx.js';
import styles from './SmithEntityComparisonDesign.module.css';

function ComparisonEntityBody({
  kind,
  spec,
  compact,
}: {
  kind: EntityComparisonKind;
  spec: AgentDef | PipelineDef | EnvelopeDef;
  compact?: boolean;
}): React.JSX.Element {
  if (kind === 'pipeline') {
    return <PipelineDesign pipeline={spec as PipelineDef} compact={compact} />;
  }
  if (kind === 'agent') {
    return <AgentDesign agent={spec as AgentDef} compact={compact} />;
  }
  return <EnvelopeDesign envelope={spec as EnvelopeDef} compact={compact} />;
}

export function EntityComparisonDesign({
  artifact,
  compact,
}: {
  artifact: SmithEntityComparisonArtifact;
  compact?: boolean;
}): React.JSX.Element {
  const [mode, setMode] = useState<'unified' | 'before-after'>('unified');

  const changes = useMemo(
    () => compareEntities(artifact.entityKind, artifact.before, artifact.after),
    [artifact.entityKind, artifact.before, artifact.after],
  );

  const scopeLabel = artifact.targetProjectId
    ? `project ${artifact.targetProjectId}`
    : artifact.projectId
      ? `project ${artifact.projectId}`
      : 'global';

  return (
    <div
      className={cx(styles.comparison, compact && styles.compact)}
      data-testid="entity-comparison-design"
    >
      <div className={styles.toggleBar}>
        <span className={styles.scopeNote}>
          Scope: {scopeLabel} · {artifact.entityKind}
        </span>
        <div className={styles.segmentedToggle} role="group" aria-label="Comparison view mode">
          <button
            type="button"
            className={cx(styles.toggleButton, mode === 'unified' && styles.toggleButtonActive)}
            onClick={() => setMode('unified')}
            aria-pressed={mode === 'unified'}
            data-testid="comparison-toggle-unified"
          >
            Unified
          </button>
          <button
            type="button"
            className={cx(
              styles.toggleButton,
              mode === 'before-after' && styles.toggleButtonActive,
            )}
            onClick={() => setMode('before-after')}
            aria-pressed={mode === 'before-after'}
            data-testid="comparison-toggle-split"
          >
            Before / After
          </button>
        </div>
      </div>

      {mode === 'unified' ? (
        <>
          {changes.length === 0 ? (
            <p className={styles.noChanges} data-testid="smith-comparison-no-changes">
              No differences detected between stored and proposed definitions.
            </p>
          ) : (
            <div className={styles.changes} data-testid="smith-comparison-changes">
              <span className={styles.changesTitle}>What changes ({changes.length})</span>
              <div className={styles.changeList}>
                {changes.map((change, index) => (
                  <span
                    key={`${change.where}-${index}`}
                    className={styles.change}
                    data-testid={`comparison-change-${change.kind}`}
                  >
                    <span className={styles.changeKind} data-change={change.kind}>
                      {change.kind}
                    </span>
                    <span className={styles.changeWhere}>{change.where}</span>
                    {change.kind === 'changed' || change.kind === 'reordered' ? (
                      <span className={styles.changeValue}>
                        {change.before} → {change.after}
                      </span>
                    ) : (
                      <span className={styles.changeValue}>{change.after ?? change.before}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className={styles.unifiedBody}>
            <h4 className={styles.sectionHeader}>Proposed definition ({artifact.name})</h4>
            <ComparisonEntityBody
              kind={artifact.entityKind}
              spec={artifact.after}
              compact={compact}
            />
          </div>
        </>
      ) : (
        <div className={cx(styles.splitView, compact && styles.splitStacked)}>
          <div className={styles.splitPane} data-testid="comparison-pane-before">
            <div className={styles.paneHeader}>
              <span className={styles.paneBadgeBefore}>Current (stored)</span>
              <span className={styles.paneName}>{artifact.name}</span>
            </div>
            <ComparisonEntityBody
              kind={artifact.entityKind}
              spec={artifact.before}
              compact={compact}
            />
          </div>
          <div className={styles.splitPane} data-testid="comparison-pane-after">
            <div className={styles.paneHeader}>
              <span className={styles.paneBadgeAfter}>Proposed (edit)</span>
              <span className={styles.paneName}>{artifact.name}</span>
            </div>
            <ComparisonEntityBody
              kind={artifact.entityKind}
              spec={artifact.after}
              compact={compact}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export default EntityComparisonDesign;
