import { AlertTriangle, SearchX } from 'lucide-react';
import type { LinearIssueSnapshot } from '@shared/types.js';
import { since } from '../../utils/format.js';
import { Button } from '../ui/Button.js';
import { linearStateColor } from './linear-state-view.js';
import styles from './LinearComposer.module.css';

export default function LinearIssueResults({
  issues,
  query,
  loading,
  error,
  activeIndex,
  onActiveIndex,
  onSelect,
  onRetry,
  onClearSearch,
}: {
  issues: LinearIssueSnapshot[];
  query: string;
  loading: boolean;
  error: string;
  activeIndex: number;
  onActiveIndex: (index: number) => void;
  onSelect: (issue: LinearIssueSnapshot) => void;
  onRetry: () => void;
  onClearSearch: () => void;
}): React.JSX.Element {
  const label = loading
    ? 'Loading issues'
    : error
      ? 'Linear'
      : query.trim()
        ? `${issues.length} result${issues.length === 1 ? '' : 's'} for “${query.trim()}”`
        : 'Recent issues';

  return (
    <div className={styles.results}>
      <div className={styles.resultsHead}>
        <span>{label}</span>
        {!loading && !error && issues.length > 0 && <span>↑↓ move · ⏎ select</span>}
      </div>

      {error ? (
        <div className={`${styles.resultsState} ${styles.resultsError}`} role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : loading ? (
        <div className={styles.issueList} aria-label="Loading Linear issues" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className={styles.skeletonRow}>
              <span className={styles.skeletonDot} />
              <span className={styles.skeletonKey} />
              <span className={styles.skeletonTitle} style={{ width: `${52 - row * 6}%` }} />
            </div>
          ))}
        </div>
      ) : issues.length === 0 ? (
        <div className={styles.resultsState}>
          <SearchX size={15} aria-hidden="true" />
          <div>
            <strong>No accessible Linear issues matched.</strong>
            <span>Try an issue key, or clear the search to browse recent issues.</span>
          </div>
          <Button size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        </div>
      ) : (
        <div className={styles.issueList} role="listbox" aria-label="Linear issues">
          {issues.map((issue, index) => {
            const active = index === activeIndex;
            return (
              <div
                key={issue.id}
                role="option"
                aria-selected={active}
                data-active={active ? 'true' : 'false'}
                data-testid={`linear-issue-${issue.id}`}
                className={`${styles.issueRow} ${active ? styles.issueRowActive : ''}`}
                onMouseEnter={() => onActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(issue)}
              >
                <span
                  className={styles.issueStateDot}
                  style={{ background: linearStateColor(issue.state.type) }}
                />
                <span className={styles.issueKey}>{issue.identifier}</span>
                <span className={styles.issueTitle}>{issue.title}</span>
                <span className={styles.issueTeam}>{issue.team.name}</span>
                <span
                  className={styles.issueState}
                  style={{ color: linearStateColor(issue.state.type) }}
                >
                  {issue.state.name}
                </span>
                <span className={styles.issueUpdated}>{since(issue.updatedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
