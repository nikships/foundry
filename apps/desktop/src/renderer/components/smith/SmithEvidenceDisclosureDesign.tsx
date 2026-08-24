/**
 * Read-only context and evidence disclosure design body for Smith's chat:
 * displays context occupancy meter, phase prompt breakdown, and capped lazy excerpts.
 */

import type { EvidenceDisclosureDef, EvidenceItemDef } from '@shared/types.js';
import { evidenceSummary, occupancyStatus } from '../../view-models/smith-artifact-view.js';
import MarkdownText from '../common/MarkdownText.js';
import { cx } from '../ui/cx.js';
import styles from './SmithEvidenceDisclosureDesign.module.css';

function EvidenceItemRow({ item }: { item: EvidenceItemDef }): React.JSX.Element {
  return (
    <details className={styles.itemDetails} data-testid={`evidence-item-${item.kind}`}>
      <summary className={styles.itemSummary}>
        <span>{item.label}</span>
        <div className={styles.itemMeta}>
          <span className={styles.kindBadge}>{item.kind.replace('_', ' ')}</span>
          {item.durationMs !== undefined && (
            <span className={styles.kindBadge}>{item.durationMs}ms</span>
          )}
          {item.exitCode !== undefined && item.exitCode !== null && (
            <span className={styles.kindBadge}>exit {item.exitCode}</span>
          )}
        </div>
      </summary>
      <pre className={cx(styles.itemContent, 'selectable')}>{item.content}</pre>
    </details>
  );
}

export function EvidenceDisclosureDesign({
  evidence,
  compact,
}: {
  evidence: EvidenceDisclosureDef;
  compact?: boolean;
}): React.JSX.Element {
  const summary = evidenceSummary(evidence);

  const occPercent =
    evidence.occupancy?.percent ??
    (evidence.occupancy?.usedTokens && evidence.occupancy?.maxTokens
      ? (evidence.occupancy.usedTokens / evidence.occupancy.maxTokens) * 100
      : undefined);

  const occStatus = occPercent !== undefined ? occupancyStatus(occPercent) : 'ok';

  return (
    <div
      className={cx(styles.evidenceDisclosure, compact && styles.compact)}
      data-testid="smith-evidence-disclosure-design"
    >
      <div className={styles.summaryBar}>
        <span className={styles.summaryText}>{summary}</span>
        {evidence.phaseName && <span className={styles.phaseTag}>Phase: {evidence.phaseName}</span>}
      </div>

      {evidence.occupancy && occPercent !== undefined && (
        <div className={styles.occupancyBox} data-testid="evidence-occupancy">
          <div className={styles.occupancyHeader}>
            <span className={styles.occupancyTitle}>Context Occupancy</span>
            <span className={styles.occupancyStats}>
              {evidence.occupancy.usedTokens !== undefined &&
              evidence.occupancy.maxTokens !== undefined
                ? `${evidence.occupancy.usedTokens.toLocaleString()} / ${evidence.occupancy.maxTokens.toLocaleString()} tokens (${Math.round(occPercent)}%)`
                : `${Math.round(occPercent)}%`}
              {evidence.occupancy.model && ` · ${evidence.occupancy.model}`}
            </span>
          </div>
          <div className={styles.meterTrack}>
            <div
              className={cx(styles.meterFill, styles[`meterFill_${occStatus}`])}
              style={{ width: `${Math.min(100, Math.max(0, occPercent))}%` }}
            />
          </div>
        </div>
      )}

      {evidence.phasePrompt && (
        <details className={styles.promptDetails} data-testid="evidence-phase-prompt">
          <summary className={styles.promptSummary}>Phase Prompt</summary>
          <div className={styles.promptBody}>
            {evidence.phasePrompt.systemPrompt && (
              <div className={styles.promptField}>
                <span className={styles.promptLabel}>System Prompt</span>
                <div className={cx(styles.promptMarkdown, 'selectable')}>
                  <MarkdownText text={evidence.phasePrompt.systemPrompt} />
                </div>
              </div>
            )}
            {evidence.phasePrompt.userPrompt && (
              <div className={styles.promptField}>
                <span className={styles.promptLabel}>User Prompt</span>
                <div className={cx(styles.promptMarkdown, 'selectable')}>
                  <MarkdownText text={evidence.phasePrompt.userPrompt} />
                </div>
              </div>
            )}
          </div>
        </details>
      )}

      {evidence.items.length > 0 && (
        <div className={styles.itemsList}>
          {evidence.items.map((item, index) => (
            <EvidenceItemRow key={item.id ?? `${item.kind}-${index}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
