/**
 * Read-only diagnostics design body for Smith's chat:
 * displays doctor checklist, orphan worktree deletion targets, maintenance metrics,
 * update stage/progress, and lifecycle warnings.
 */

import type { DiagnosticsDef } from '@shared/types.js';
import { diagnosticsSummary, formatBytes } from '../../view-models/smith-artifact-view.js';
import { ChecklistDesign } from './SmithChecklistDesign.js';
import { cx } from '../ui/cx.js';
import styles from './SmithDiagnosticsDesign.module.css';

export function DiagnosticsDesign({
  diagnostics,
  compact,
}: {
  diagnostics: DiagnosticsDef;
  compact?: boolean;
}): React.JSX.Element {
  const summary = diagnosticsSummary(diagnostics);

  return (
    <div
      className={cx(styles.diagnostics, compact && styles.compact)}
      data-testid="smith-diagnostics-design"
    >
      <div className={styles.summaryBar}>
        <span className={styles.summaryText}>{summary}</span>
        {diagnostics.category && <span className={styles.categoryTag}>{diagnostics.category}</span>}
      </div>

      {diagnostics.lifecycleWarning && (
        <div className={styles.lifecycleWarning} data-testid="diagnostics-lifecycle-warning">
          <span className={styles.warningIcon} aria-hidden="true">
            ⚠
          </span>
          <span className={styles.warningText}>{diagnostics.lifecycleWarning}</span>
        </div>
      )}

      {diagnostics.doctor && diagnostics.doctor.length > 0 && (
        <div className={styles.section} data-testid="diagnostics-doctor-section">
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Doctor Checks</span>
          </div>
          <ul className={styles.checkList}>
            {diagnostics.doctor.map((check) => (
              <li
                key={check.id}
                className={styles.checkItem}
                data-testid={`doctor-check-${check.id}`}
              >
                <div className={styles.checkItemHead}>
                  <div className={styles.checkTitleRow}>
                    <span
                      className={cx(
                        styles.checkGlyph,
                        check.ok ? styles.checkGlyphPass : styles.checkGlyphFail,
                      )}
                      aria-hidden="true"
                    >
                      {check.ok ? '✓' : '✕'}
                    </span>
                    <span className={styles.checkLabel}>{check.label}</span>
                  </div>
                  {check.blocking && !check.ok && (
                    <span className={styles.blockingTag}>Blocking</span>
                  )}
                </div>
                {check.detail && <span className={styles.checkDetail}>{check.detail}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {diagnostics.orphans && diagnostics.orphans.length > 0 && (
        <div className={styles.section} data-testid="diagnostics-orphans-section">
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>
              Orphan Worktrees ({diagnostics.orphans.length})
            </span>
          </div>
          <ul className={styles.orphanList}>
            {diagnostics.orphans.map((orphan, i) => (
              <li key={`${orphan.path}-${i}`} className={styles.orphanItem}>
                <span className={styles.orphanPath}>{orphan.path}</span>
                <div className={styles.orphanMeta}>
                  <span className={styles.orphanBadge}>Branch: {orphan.branch}</span>
                  {orphan.runId && <span className={styles.orphanBadge}>Run: {orphan.runId}</span>}
                  <span className={styles.orphanBadge}>Project: {orphan.projectId}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {diagnostics.maintenance && (
        <div className={styles.section} data-testid="diagnostics-maintenance-section">
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>Maintenance Result</span>
          </div>
          <div className={styles.metricsGrid}>
            <div className={styles.metricCard}>
              <span className={styles.metricValue}>{diagnostics.maintenance.runsDeleted}</span>
              <span className={styles.metricLabel}>Runs cleared</span>
            </div>
            <div className={styles.metricCard}>
              <span className={styles.metricValue}>
                {formatBytes(diagnostics.maintenance.bytesReclaimed)}
              </span>
              <span className={styles.metricLabel}>Space reclaimed</span>
            </div>
            <div className={styles.metricCard}>
              <span className={styles.metricValue}>{diagnostics.maintenance.worktreesRemoved}</span>
              <span className={styles.metricLabel}>Worktrees removed</span>
            </div>
          </div>
        </div>
      )}

      {diagnostics.update && (
        <div className={styles.section} data-testid="diagnostics-update-section">
          <div className={styles.sectionHeader}>
            <span className={styles.sectionTitle}>App Update</span>
          </div>
          <div className={styles.updateBox}>
            <div className={styles.updateHeader}>
              <span className={styles.stageBadge}>{diagnostics.update.stage}</span>
              {diagnostics.update.version && (
                <span className={styles.metricLabel}>v{diagnostics.update.version}</span>
              )}
            </div>
            {diagnostics.update.message && (
              <span className={styles.checkDetail}>{diagnostics.update.message}</span>
            )}
            {diagnostics.update.percent !== undefined && diagnostics.update.percent > 0 && (
              <div className={styles.progressBar}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${Math.min(100, Math.max(0, diagnostics.update.percent))}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {diagnostics.items && diagnostics.items.length > 0 && (
        <ChecklistDesign
          checklist={{ title: 'Checks', items: diagnostics.items }}
          compact={compact}
        />
      )}
    </div>
  );
}
