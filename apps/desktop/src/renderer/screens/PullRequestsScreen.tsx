/**
 * Open PRs for the selected project, fetched through the operator's gh CLI.
 * Fetch happens on mount and on demand — gh calls shell out and hit the
 * network, so this screen never polls the way the trace views do. After a
 * successful Fix-with-agent, the card holds a local rechecking state so a
 * stale `conflicting` from GitHub cannot re-arm the button.
 */

import { useCallback, useEffect, useState } from 'react';
import type { GhStatus, PrMergeMethod, PullRequest } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { since } from '../utils/format.js';
import EmptyState from '../components/common/EmptyState.js';
import { Button } from '../components/ui/Button.js';
import { Dropdown } from '../components/ui/Dropdown.js';
import { usePrMergeabilityRecheck } from '../hooks/usePrMergeabilityRecheck.js';
import {
  prConflictBadge,
  prFixButton,
  prMergeBlocked,
  prMergeHint,
  prRepairPhase,
  type PrRepairPhase,
} from '../view-models/pr-repair-view.js';
import styles from './PullRequestsScreen.module.css';

const FOUNDRY_BRANCH = /^foundry\//;

function checksBadge(pr: PullRequest): { label: string; color: string } | null {
  switch (pr.checks) {
    case 'passing':
      return { label: 'checks passing', color: 'var(--green)' };
    case 'failing':
      return { label: 'checks failing', color: 'var(--red)' };
    case 'pending':
      return { label: 'checks running', color: 'var(--amber)' };
    default:
      return null;
  }
}

function reviewBadge(pr: PullRequest): { label: string; color: string } | null {
  switch (pr.reviewDecision) {
    case 'APPROVED':
      return { label: 'approved', color: 'var(--green)' };
    case 'CHANGES_REQUESTED':
      return { label: 'changes requested', color: 'var(--red)' };
    case 'REVIEW_REQUIRED':
      return { label: 'review required', color: 'var(--amber)' };
    default:
      return null;
  }
}

function PrCard({
  pr,
  busy,
  phase,
  note,
  noteIsError,
  onOpen,
  onMerge,
  onFix,
  onOpenRun,
}: {
  pr: PullRequest;
  busy: boolean;
  phase: PrRepairPhase;
  note: string;
  noteIsError: boolean;
  onOpen: () => void;
  onMerge: (method: PrMergeMethod) => void;
  /** Present only when a local worktree exists for this PR's foundry run. */
  onFix?: () => void;
  onOpenRun?: () => void;
}): React.JSX.Element {
  const [method, setMethod] = useState<PrMergeMethod>('merge');
  const checks = checksBadge(pr);
  const review = reviewBadge(pr);
  const conflicts = prConflictBadge(pr.mergeable, phase);
  const fix = prFixButton({ hasFixAction: !!onFix, mergeable: pr.mergeable, phase });
  const mergeBlocked = prMergeBlocked({
    busy,
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    phase,
  });
  const mergeHint = prMergeHint({
    isDraft: pr.isDraft,
    mergeable: pr.mergeable,
    phase,
    number: pr.number,
    baseRefName: pr.baseRefName,
  });

  return (
    <li className={styles.card}>
      <div className={styles.cardMain}>
        <div className={styles.titleRow}>
          <button className={styles.title} title="Open on GitHub" onClick={onOpen}>
            {pr.title}
          </button>
          {pr.isDraft && <span className={`badge ${styles.draft}`}>draft</span>}
          {onOpenRun && (
            <button
              className={`badge ${styles.runTag}`}
              title="This branch came from a Foundry run — open it"
              onClick={onOpenRun}
              data-testid={`prs-run-tag-${pr.number}`}
            >
              foundry run
            </button>
          )}
        </div>
        <div className={`${styles.meta} mono faint`}>
          <span>#{pr.number}</span>
          <span>
            {pr.headRefName} → {pr.baseRefName}
          </span>
          {pr.author && <span>{pr.author}</span>}
          <span>{since(pr.createdAt)}</span>
          <span>
            <span className={styles.additions}>+{pr.additions}</span>{' '}
            <span className={styles.deletions}>−{pr.deletions}</span>
          </span>
          {checks && (
            <span className="badge" style={{ color: checks.color }}>
              {checks.label}
            </span>
          )}
          {review && (
            <span className="badge" style={{ color: review.color }}>
              {review.label}
            </span>
          )}
          {conflicts && (
            <span className="badge" style={{ color: conflicts.color }}>
              {conflicts.label}
            </span>
          )}
        </div>
        {note && (
          <p className={`${styles.note} mono ${noteIsError ? styles.bad : 'faint'}`}>{note}</p>
        )}
      </div>
      <div className={styles.cardActions}>
        {fix && (
          <Button
            variant="primary"
            size="sm"
            disabled={fix.disabled}
            title={fix.title}
            onClick={() => onFix?.()}
            data-testid={`prs-fix-${pr.number}`}
          >
            {fix.label}
          </Button>
        )}
        <Dropdown
          className={styles.method}
          value={method}
          disabled={busy}
          aria-label="How gh merges this PR"
          data-testid={`prs-method-${pr.number}`}
          options={[
            { value: 'merge', label: 'merge commit' },
            { value: 'squash', label: 'squash' },
          ]}
          onChange={(next) => setMethod(next as PrMergeMethod)}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={mergeBlocked}
          title={mergeHint}
          onClick={() => onMerge(method)}
          data-testid={`prs-merge-${pr.number}`}
        >
          {busy ? 'Merging…' : 'Merge'}
        </Button>
      </div>
    </li>
  );
}

export default function PullRequestsScreen({
  onOpenRun,
}: {
  onOpenRun: (runId: string) => void;
}): React.JSX.Element {
  const { project, projectId } = useApp();
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [prs, setPrs] = useState<PullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [mergingNumber, setMergingNumber] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, { text: string; error: boolean }>>({});
  const { untilFor, holdAfterSuccessfulFix, pruneAgainst, reset } = usePrMergeabilityRecheck();

  const setNote = (number: number, text: string, error = false): void => {
    setNotes((n) => ({ ...n, [number]: { text, error } }));
  };

  const refresh = useCallback(async (): Promise<void> => {
    if (!projectId) {
      // A removed project must not strand `loading` at its initial true.
      setGh(null);
      setPrs([]);
      setListError('');
      setLoading(false);
      reset();
      return;
    }
    setLoading(true);
    setListError('');
    try {
      const status = await api.prs.status(projectId);
      setGh(status);
      if (!status.available) {
        setPrs([]);
        return;
      }
      const page = await api.prs.list(projectId);
      if (page.ok) {
        setPrs(page.prs);
        pruneAgainst(page.prs);
      } else setListError(page.detail);
    } catch (e) {
      setListError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, pruneAgainst, reset]);

  useEffect(() => {
    setGh(null);
    setPrs([]);
    setNotes({});
    reset();
    void refresh();
  }, [refresh, reset]);

  const merge = async (pr: PullRequest, method: PrMergeMethod): Promise<void> => {
    if (mergingNumber !== null) return;
    const what = method === 'squash' ? 'Squash-merge' : 'Merge';
    if (
      !window.confirm(
        `${what} #${pr.number} "${pr.title}" into ${pr.baseRefName} on GitHub? Foundry then tidies up locally — anything it can’t finish lands in the result note.`,
      )
    )
      return;
    setMergingNumber(pr.number);
    setNote(pr.number, '');
    try {
      const result = await api.prs.merge(projectId, pr.number, method);
      setNote(pr.number, result.detail, !result.ok);
      if (result.ok) setPrs((rows) => rows.filter((row) => row.number !== pr.number));
    } catch (e) {
      setNote(pr.number, (e as Error).message, true);
    } finally {
      setMergingNumber(null);
    }
  };

  /**
   * The managed answer to a conflicting foundry PR: an agent rebases the
   * branch in its worktree, code verifies and pushes. No confirm dialog —
   * nothing here is destructive, and a failed repair rolls itself back.
   * A successful push holds the button in a rechecking state so a second
   * click cannot fire while GitHub still reports the pre-push conflict.
   */
  const fixConflicts = async (pr: PullRequest): Promise<void> => {
    if (mergingNumber !== null) return;
    if (
      prRepairPhase({
        busy: false,
        mergeable: pr.mergeable,
        recheckUntil: untilFor(pr.number),
        now: Date.now(),
      }) !== 'idle'
    ) {
      return;
    }
    setMergingNumber(pr.number);
    setNote(pr.number, 'The agent is rebasing the branch onto the fetched base…');
    try {
      const result = await api.prs.fixConflicts(projectId, pr.number);
      setNote(pr.number, result.detail, !result.ok);
      if (result.ok) {
        holdAfterSuccessfulFix(pr.number);
        await refresh();
      }
    } catch (e) {
      setNote(pr.number, (e as Error).message, true);
    } finally {
      setMergingNumber(null);
    }
  };

  const openExternal = (url: string): void => {
    void api.app.openExternal(url);
  };

  const mergedNotes = Object.entries(notes).filter(
    ([number]) => !prs.some((pr) => pr.number === Number(number)),
  );

  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <p className="eyebrow">
          <span className="index">05</span>Pull Requests
        </p>
        <div className={styles.headRight}>
          {gh?.repo && <span className={`mono faint ${styles.repo}`}>{gh.repo}</span>}
          <Button
            size="sm"
            disabled={loading}
            onClick={() => void refresh()}
            data-testid="prs-refresh"
            data-loading={loading ? 'true' : 'false'}
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </header>

      {listError && (
        <p className={styles.error} role="alert">
          {listError}
        </p>
      )}

      <div className={`${styles.body} scroll`}>
        {!project ? (
          <EmptyState title="No project" body="Add a project to see its pull requests." />
        ) : gh && !gh.available ? (
          <EmptyState title="GitHub CLI not ready" body={gh.detail}>
            <Button size="sm" onClick={() => void refresh()}>
              Check again
            </Button>
          </EmptyState>
        ) : loading && prs.length === 0 ? (
          <p className={`faint ${styles.loading}`}>Asking gh for open pull requests…</p>
        ) : prs.length === 0 && !listError ? (
          <EmptyState
            title="No open pull requests"
            body="Accepted runs can open one from the run's outcome banner."
          />
        ) : (
          <ul className={styles.list}>
            {prs.map((pr) => {
              const runId = FOUNDRY_BRANCH.test(pr.headRefName)
                ? pr.headRefName.replace(FOUNDRY_BRANCH, '')
                : null;
              return (
                <PrCard
                  key={pr.number}
                  pr={pr}
                  busy={mergingNumber === pr.number}
                  phase={prRepairPhase({
                    busy: mergingNumber === pr.number,
                    mergeable: pr.mergeable,
                    recheckUntil: untilFor(pr.number),
                    now: Date.now(),
                  })}
                  note={notes[pr.number]?.text ?? ''}
                  noteIsError={notes[pr.number]?.error ?? false}
                  onOpen={() => openExternal(pr.url)}
                  onMerge={(method) => void merge(pr, method)}
                  onFix={runId ? () => void fixConflicts(pr) : undefined}
                  onOpenRun={runId ? () => onOpenRun(runId) : undefined}
                />
              );
            })}
          </ul>
        )}
        {mergedNotes.length > 0 && (
          <div className={styles.settled}>
            {mergedNotes.map(([number, note]) => (
              <p key={number} className={`mono ${note.error ? styles.bad : 'faint'}`}>
                #{number}: {note.text}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
