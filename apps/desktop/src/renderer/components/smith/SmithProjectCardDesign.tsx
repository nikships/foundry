/**
 * Read-only project card design body for Smith's chat.
 *
 * Communicates project path, base branch, GitHub integration, base divergence,
 * command/setup readiness, scopes, and repository health.
 */

import type { ProjectCardDef } from '@shared/types.js';
import {
  projectCardDivergenceLabel,
  projectCardHealthLabel,
  projectCardScopesLabel,
  projectCardSummary,
} from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithProjectCardDesign.module.css';

export function GitBranchIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
      <circle cx="5" cy="4" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="5" cy="12" r="2" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11" cy="6" r="2" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5 6 V10 M5 8 C5 6 11 8 11 8" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function HealthStatusIcon({ ok }: { ok: boolean }): React.JSX.Element {
  if (ok) {
    return (
      <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
        <polyline
          points="3.2 8.2 6.4 11.4 12.8 4.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" aria-hidden="true">
      <path
        d="M8 2.5 L14.5 13.5 H1.5 Z M8 6.5 V9.5 M8 11.5 V12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ProjectCardDesign({
  project,
  compact,
}: {
  project: ProjectCardDef;
  compact?: boolean;
}): React.JSX.Element {
  const summary = projectCardSummary(project);
  const divergenceLabel = projectCardDivergenceLabel(project.divergence);
  const healthLabel = projectCardHealthLabel(project.health);
  const scopesLabel = projectCardScopesLabel(project.scopes);
  const isHealthy = project.health ? project.health.ok : true;

  return (
    <div
      className={cx(styles.projectCard, compact && styles.compact)}
      data-testid="project-card-design"
    >
      <div className={styles.headerBar}>
        <div className={styles.pathRow} data-testid="project-card-path">
          <span className={styles.pathText}>{project.path}</span>
        </div>
        <div className={styles.badges}>
          <span
            className={styles.branchBadge}
            aria-label={`Base ref: ${project.baseRef}`}
            data-testid="project-card-baseref"
          >
            <GitBranchIcon />
            {project.baseRef}
          </span>
          {project.health && (
            <span
              className={cx(
                styles.healthBadge,
                isHealthy ? styles.healthBadge_ok : styles.healthBadge_warn,
              )}
              aria-label={`Health: ${healthLabel}`}
              data-testid="project-card-health"
            >
              <HealthStatusIcon ok={isHealthy} />
              {healthLabel}
            </span>
          )}
        </div>
      </div>

      {!compact && (
        <span className={styles.summaryText} data-testid="project-card-summary">
          {summary}
        </span>
      )}

      <div className={styles.grid}>
        {project.github && (
          <div className={styles.section} data-testid="project-card-github">
            <span className={styles.sectionTitle}>GitHub</span>
            <span className={styles.sectionValue}>
              {project.github.repo ?? (project.github.available ? 'Connected' : 'Not configured')}
            </span>
          </div>
        )}

        {project.divergence && (
          <div className={styles.section} data-testid="project-card-divergence">
            <span className={styles.sectionTitle}>Sync state</span>
            <span className={styles.sectionValue}>{divergenceLabel}</span>
          </div>
        )}

        {project.scopes && (
          <div className={styles.section} data-testid="project-card-scopes">
            <span className={styles.sectionTitle}>Entity scope</span>
            <span className={styles.sectionValue}>{scopesLabel}</span>
          </div>
        )}

        {project.commands !== undefined && (
          <div className={styles.section} data-testid="project-card-commands">
            <span className={styles.sectionTitle}>Commands ({project.commands.length})</span>
            {project.commands.length > 0 ? (
              <div className={styles.chipList}>
                {project.commands.map((cmd) => (
                  <span key={cmd.name} className={styles.chip}>
                    {cmd.name}
                  </span>
                ))}
              </div>
            ) : (
              <span className={styles.sectionValue}>
                {project.scaffold ? 'Scaffold project' : 'None configured'}
              </span>
            )}
          </div>
        )}
      </div>

      {project.contextSummary && !compact && (
        <details className={styles.disclosure} data-testid="project-card-context">
          <summary className={styles.disclosureSummary}>Project context</summary>
          <pre className={cx(styles.disclosurePre, 'selectable')}>{project.contextSummary}</pre>
        </details>
      )}
    </div>
  );
}
