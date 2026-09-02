/**
 * Readiness-journey design body for Smith's chat.
 *
 * One card for the whole onboarding: the marker committed on the base ref
 * (the only readiness truth), the criteria grouped by status, the remediation
 * phase, the live sub-agent transcript, the PR and whether it merged, and the
 * `needs_continue` affordances.
 *
 * The verdict always names its source. The criteria explain what remediation
 * would fix and a merged PR is not proof, so neither may read as the answer:
 * only the committed marker decides.
 */

import { useMemo } from 'react';
import type {
  ReadinessCriterionStatus,
  ReadinessJourneyCriterion,
  ReadinessJourneyDef,
  ReadinessJourneyWorkEntry,
} from '@shared/types.js';
import {
  criterionLabel,
  criterionStatusLabel,
  groupJourneyCriteria,
  isJourneyPhaseLive,
  journeyActions,
  journeyMarkerVerdict,
  journeyNeedsContinue,
  journeySummary,
  readinessPhaseLabel,
} from '../../view-models/smith-artifact-view.js';
import { cx } from '../ui/cx.js';
import styles from './SmithReadinessJourneyDesign.module.css';

const STATUS_GROUPS: ReadonlyArray<{
  key: 'fail' | 'pass' | 'na';
  status: ReadinessCriterionStatus;
  title: string;
}> = [
  { key: 'fail', status: 'fail', title: 'Failing' },
  { key: 'pass', status: 'pass', title: 'Passing' },
  { key: 'na', status: 'n/a', title: 'Not applicable' },
];

function CriterionGroup({
  status,
  title,
  criteria,
}: {
  status: ReadinessCriterionStatus;
  title: string;
  criteria: ReadinessJourneyCriterion[];
}): React.JSX.Element | null {
  if (criteria.length === 0) return null;
  const statusKey = status === 'n/a' ? 'na' : status;
  return (
    <div className={styles.group} data-testid={`journey-group-${statusKey}`}>
      <div className={styles.groupHeader}>
        <span className={cx(styles.groupDot, styles[`groupDot_${statusKey}`])} aria-hidden="true" />
        <h4 className={styles.groupTitle}>
          {title} ({criteria.length})
        </h4>
      </div>
      <ul className={styles.criteriaList}>
        {criteria.map((criterion) => (
          <li
            key={criterion.id}
            className={styles.criterion}
            aria-label={`${criterionLabel(criterion.id)} (${criterionStatusLabel(criterion.status)})`}
          >
            <span className={styles.criterionName}>{criterionLabel(criterion.id)}</span>
            {criterion.notes && <span className={styles.criterionNotes}>{criterion.notes}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WorkRow({ entry }: { entry: ReadinessJourneyWorkEntry }): React.JSX.Element {
  return (
    <li
      className={cx(
        styles.workRow,
        entry.kind === 'error' && styles.workRowError,
        entry.failed && styles.workRowError,
      )}
      data-testid={`journey-work-${entry.kind}`}
    >
      <span className={styles.workKind}>
        {entry.kind === 'tool' ? (entry.toolKind ?? 'tool') : entry.kind}
      </span>
      <span className={styles.workText}>{entry.text}</span>
      {entry.kind === 'tool' && (
        <span className={styles.workState}>
          {entry.failed ? 'failed' : entry.done ? 'done' : 'running'}
        </span>
      )}
    </li>
  );
}

export function ReadinessJourneyDesign({
  journey,
  compact,
}: {
  journey: ReadinessJourneyDef;
  compact?: boolean;
}): React.JSX.Element {
  const groups = useMemo(() => groupJourneyCriteria(journey.criteria), [journey.criteria]);
  const summary = useMemo(() => journeySummary(journey), [journey]);
  const verdict = useMemo(() => journeyMarkerVerdict(journey), [journey]);
  const actions = useMemo(() => journeyActions(journey), [journey]);
  const live = isJourneyPhaseLive(journey.phase);
  const work = journey.work ?? [];

  return (
    <div
      className={cx(styles.journey, compact && styles.compact)}
      data-testid="readiness-journey-design"
    >
      <div
        className={cx(styles.markerBar, journey.marker.valid ? styles.markerOk : styles.markerBad)}
        data-testid="journey-marker"
      >
        <div className={styles.markerHead}>
          <span className={styles.markerBadge}>
            {journey.marker.valid ? 'Marker valid' : 'No valid marker'}
          </span>
          <span className={cx(styles.phaseBadge, live && styles.phaseBadgeLive)}>
            {readinessPhaseLabel(journey.phase)}
          </span>
        </div>
        <span className={styles.markerVerdict} data-testid="journey-verdict">
          {verdict}
        </span>
        <span className={styles.markerAuthority}>
          Readiness is decided by the marker committed on the base ref
          {journey.marker.ref ? ` (${journey.marker.ref})` : ''}. The criteria below explain what
          remediation would fix.
        </span>
      </div>

      <div className={styles.summaryBar} data-testid="journey-summary">
        <span className={styles.summaryText}>{summary}</span>
        {journey.checklistSummary && (
          <span className={styles.checklistNote}>{journey.checklistSummary}</span>
        )}
      </div>

      {journey.stack && (
        <div className={styles.stackRow} data-testid="journey-stack">
          <span className={styles.sectionTitle}>Stack</span>
          <span className={styles.stackText}>
            {[
              journey.stack.languages.join(', '),
              journey.stack.monorepo ? 'monorepo' : '',
              journey.stack.packages.length > 0 ? `${journey.stack.packages.length} packages` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      )}

      <div className={styles.groups}>
        {STATUS_GROUPS.map(({ key, status, title }) => (
          <CriterionGroup key={key} status={status} title={title} criteria={groups[key]} />
        ))}
      </div>

      {work.length > 0 && (
        <details
          className={styles.workDisclosure}
          open={live && !compact}
          data-testid="journey-work"
        >
          <summary className={styles.workSummary}>
            Remediation work ({work.length}
            {live ? ', in flight' : ''})
          </summary>
          <ul className={styles.workList}>
            {work.map((entry) => (
              <WorkRow key={entry.id} entry={entry} />
            ))}
          </ul>
        </details>
      )}

      {journey.pr && (
        <div className={styles.prRow} data-testid="journey-pr">
          <span className={styles.sectionTitle}>Pull request</span>
          <span className={styles.prText}>
            #{journey.pr.number} · {journey.pr.merged ? 'merged' : 'open'}
          </span>
          <span className={styles.prUrl}>{journey.pr.url}</span>
          {journey.pr.mergeDetail && (
            <span className={styles.prDetail}>{journey.pr.mergeDetail}</span>
          )}
          {journey.pr.merged && !journey.marker.valid && (
            <span className={styles.prCaveat}>
              A merged pull request is not readiness on its own — the marker on the base ref still
              has to verify.
            </span>
          )}
        </div>
      )}

      {actions.length > 0 && (
        <div className={styles.actionsRow} data-testid="journey-actions">
          <span className={styles.sectionTitle}>
            {journeyNeedsContinue(journey) ? 'Paused — next steps' : 'Next steps'}
          </span>
          <div className={styles.actions} role="group" aria-label="Readiness next steps">
            {actions.map((action) => (
              <span key={action} className={styles.action}>
                {action}
              </span>
            ))}
          </div>
          <span className={styles.gateNote}>
            These are labels: each one runs through the readiness approval card, not this card.
          </span>
        </div>
      )}
    </div>
  );
}
