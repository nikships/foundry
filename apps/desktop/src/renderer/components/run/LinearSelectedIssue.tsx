import { ChevronDown, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import type { LinearIssueSnapshot } from '@shared/types.js';
import { linearStateColor } from './linear-state-view.js';
import styles from './LinearComposer.module.css';

export default function LinearSelectedIssue({
  issue,
  onChange,
  onOpen,
  locked = false,
}: {
  issue: LinearIssueSnapshot;
  onChange: () => void;
  onOpen: () => void;
  locked?: boolean;
}): React.JSX.Element {
  const [detailOpen, setDetailOpen] = useState(false);

  return (
    <div className={styles.selectedIssue} data-testid="linear-issue-detail">
      <div className={styles.selectedIssueRow}>
        <span
          className={styles.issueStateDot}
          style={{ background: linearStateColor(issue.state.type) }}
        />
        <span className={styles.issueKey}>{issue.identifier}</span>
        <span className={styles.issueTitle}>{issue.title}</span>
        <span className={styles.issueTeam}>{issue.team.name}</span>
        <span
          className={styles.selectedIssueState}
          style={{ color: linearStateColor(issue.state.type) }}
        >
          {issue.state.name}
        </span>
        <div className={styles.selectedActions}>
          <button
            type="button"
            className={styles.detailButton}
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((open) => !open)}
          >
            <ChevronDown
              size={12}
              className={detailOpen ? styles.detailChevronOpen : undefined}
              aria-hidden="true"
            />
            Detail
          </button>
          <button type="button" className={styles.detailButton} onClick={onOpen}>
            <ExternalLink size={12} aria-hidden="true" />
            Linear
          </button>
          <button
            type="button"
            className={styles.changeButton}
            disabled={locked}
            title={locked ? 'Discard the plan to pick another issue' : undefined}
            onClick={onChange}
          >
            Change
          </button>
        </div>
      </div>
      {detailOpen && (
        <p className={`${styles.issueDescription} selectable`}>
          {issue.description || 'No description.'}
        </p>
      )}
    </div>
  );
}
