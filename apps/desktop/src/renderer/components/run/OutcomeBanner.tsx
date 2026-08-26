import { useState } from 'react';
import type { EnvelopeRow, GhStatus, PhaseRow, RunRow } from '@shared/types.js';
import { useBrandedAsset } from '../../hooks/useBrandedAsset.js';
import { manualPrDraft } from '../../view-models/pr-draft.js';
import {
  outcomeExplanation,
  outcomeHeadline,
  resumeTitleFor,
} from '../../view-models/outcome-view.js';
import type { RestoreAvailability } from '../../view-models/restore-view.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import styles from './OutcomeBanner.module.css';

function colorFor(status: RunRow['status']): string {
  if (status === 'accepted') return 'var(--green)';
  if (status === 'rejected') return 'var(--amber)';
  return 'var(--red)';
}

function artFor(status: RunRow['status']): string {
  if (status === 'accepted') return 'scenes/run-accepted.png';
  if (status === 'rejected') return 'scenes/run-rejected.png';
  return 'scenes/run-failed.png';
}

/** The GitHub issue this run filed, when it filed one. */
function IssueLink({
  run,
  onOpenUrl,
}: {
  run: RunRow;
  onOpenUrl: (url: string) => void;
}): React.JSX.Element | null {
  if (!run.issueUrl) return null;
  const url = run.issueUrl;
  return (
    <Button
      variant="ghost"
      size="sm"
      title="Open the GitHub issue this run filed"
      onClick={() => onOpenUrl(url)}
    >
      Issue #{run.issueNumber ?? '?'} ↗
    </Button>
  );
}

/**
 * Restore, kept visible and disabled rather than hidden when it cannot be
 * used: a run with no recorded checkpoints is the common case for a while
 * yet, and an absent button teaches an operator nothing about why.
 */
function RestoreAction({
  restore,
  busy,
  onRestore,
}: {
  restore?: RestoreAvailability;
  busy: boolean;
  onRestore?: () => void;
}): React.JSX.Element | null {
  if (!restore?.offered || !onRestore) return null;
  const reason = restore.enabled ? '' : restore.reason;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !restore.enabled}
        title={
          reason ||
          'Put this run’s worktree back to the start of a recorded phase, without resuming it'
        }
        onClick={onRestore}
        data-testid="outcome-restore"
      >
        Restore…
      </Button>
      {reason && (
        <span className={styles.restoreReason} data-testid="outcome-restore-reason">
          {reason}
        </span>
      )}
    </>
  );
}

export default function OutcomeBanner({
  run,
  phases,
  envelopes = [],
  worktreeBusy,
  worktreeMessage,
  worktreeError = false,
  gh,
  canResume = false,
  canFix = false,
  restore,
  onRestore,
  onResume,
  onMerge,
  onFixMerge,
  onDiscard,
  onCreatePr,
  onOpenUrl,
  onExport,
}: {
  run: RunRow;
  phases: PhaseRow[];
  /** Successful `pr` envelopes prefill the manual form when auto-create failed. */
  envelopes?: EnvelopeRow[];
  worktreeBusy: boolean;
  worktreeMessage: string;
  worktreeError?: boolean;
  /** null while the gh probe is still in flight. */
  gh: GhStatus | null;
  /** A failed phase and its isolated worktree are both still available. */
  canResume?: boolean;
  /** True after a refused merge, which is when the agent repair applies. */
  canFix?: boolean;
  /** Whether restoring is offered, and why it is not usable. */
  restore?: RestoreAvailability;
  onRestore?: () => void;
  onResume?: () => void;
  onMerge: () => void;
  onFixMerge?: () => void;
  onDiscard: () => void;
  onCreatePr: (title: string, body: string) => void;
  onOpenUrl: (url: string) => void;
  /** Present only for an orchestrated run whose persisted plan loaded. */
  onExport?: () => void;
}): React.JSX.Element {
  const art = useBrandedAsset(artFor(run.status));
  const color = colorFor(run.status);
  const hasWorktree = !!run.worktreePath && !run.merged;
  const prUrl = run.prUrl ?? '';
  const [prFormOpen, setPrFormOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');

  const openPrForm = (): void => {
    const draft = manualPrDraft(run, envelopes, phases);
    setPrTitle(draft.title);
    setPrBody(draft.body);
    setPrFormOpen(true);
  };

  const submitPr = (): void => {
    setPrFormOpen(false);
    onCreatePr(prTitle.trim(), prBody);
  };

  const ghReady = !!gh?.available;
  const ghHint = gh === null ? 'Checking the GitHub CLI…' : gh.available ? '' : gh.detail;

  return (
    <section
      className={styles.banner}
      style={{
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        background: `color-mix(in srgb, ${color} 8%, var(--bg-panel))`,
      }}
    >
      {art && <img src={art} alt="" />}
      <div className={styles.text}>
        <h2 style={{ color }}>{outcomeHeadline(run.status)}</h2>
        <p>{outcomeExplanation(run, phases, { canResume })}</p>
        {worktreeMessage && (
          <p
            className={cx(styles.note, 'mono', worktreeError ? styles.bad : 'faint')}
            role={worktreeError ? 'alert' : undefined}
          >
            {worktreeBusy ? 'Working… ' : ''}
            {worktreeMessage}
          </p>
        )}
        {worktreeBusy && !worktreeMessage && (
          <p className={`faint ${styles.note}`}>Working on the worktree…</p>
        )}
      </div>
      {hasWorktree ? (
        <div className={styles.actions}>
          {onExport && (
            <Button variant="ghost" size="sm" onClick={onExport}>
              Export…
            </Button>
          )}
          {canResume && onResume && (
            <Button
              variant="primary"
              size="sm"
              disabled={worktreeBusy}
              title={resumeTitleFor(run, phases)}
              onClick={onResume}
              data-testid="outcome-resume"
            >
              {worktreeBusy ? 'Continuing…' : 'Continue run'}
            </Button>
          )}
          {canFix && onFixMerge && (
            <Button
              variant="primary"
              size="sm"
              disabled={worktreeBusy}
              title="An agent rebases the run branch onto the base inside its worktree; Foundry verifies the result and merges it"
              onClick={onFixMerge}
              data-testid="outcome-fix-merge"
            >
              {worktreeBusy ? 'Working…' : 'Fix & merge with agent'}
            </Button>
          )}
          <RestoreAction restore={restore} busy={worktreeBusy} onRestore={onRestore} />
          <IssueLink run={run} onOpenUrl={onOpenUrl} />
          {run.prUrl ? (
            <Button
              size="sm"
              disabled={worktreeBusy}
              title="Open this run's pull request on GitHub"
              onClick={() => onOpenUrl(prUrl)}
            >
              PR #{run.prNumber ?? '?'} ↗
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={worktreeBusy || !ghReady}
              title={ghHint || 'Push the run branch and open a pull request on GitHub'}
              onClick={() => (prFormOpen ? setPrFormOpen(false) : openPrForm())}
              data-testid="outcome-open-pr"
            >
              Open PR…
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={worktreeBusy}
            title="Merge the run branch into the project base ref locally, without a PR"
            onClick={onMerge}
            data-testid="outcome-merge"
          >
            {worktreeBusy ? 'Working…' : 'Merge branch'}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={worktreeBusy}
            title="Delete the run worktree and branch"
            onClick={onDiscard}
            data-testid="outcome-discard"
          >
            Discard
          </Button>
        </div>
      ) : run.merged ? (
        <div className={styles.actions}>
          {onExport && (
            <Button variant="ghost" size="sm" onClick={onExport}>
              Export…
            </Button>
          )}
          <IssueLink run={run} onOpenUrl={onOpenUrl} />
          {run.prUrl && (
            <Button
              variant="ghost"
              size="sm"
              title="Open this run's pull request on GitHub"
              onClick={() => onOpenUrl(prUrl)}
            >
              PR #{run.prNumber ?? '?'} ↗
            </Button>
          )}
          <span className={`badge ${styles.merged}`}>merged</span>
        </div>
      ) : onExport ? (
        <div className={styles.actions}>
          <Button variant="ghost" size="sm" onClick={onExport}>
            Export…
          </Button>
        </div>
      ) : null}
      {prFormOpen && hasWorktree && !run.prUrl && (
        <div className={styles.prForm}>
          <input
            className="input"
            value={prTitle}
            placeholder="Pull request title"
            onChange={(e) => setPrTitle(e.target.value)}
            data-testid="pr-title"
          />
          <textarea
            className={`input ${styles.prBody}`}
            value={prBody}
            placeholder="Pull request description"
            rows={5}
            onChange={(e) => setPrBody(e.target.value)}
            data-testid="pr-body"
          />
          <div className={styles.prFormActions}>
            <span className="faint">
              Pushes <span className="mono">{run.branch}</span> and opens a PR against{' '}
              <span className="mono">{run.baseRef ?? 'the base ref'}</span>
              {gh?.repo ? (
                <>
                  {' '}
                  on <span className="mono">{gh.repo}</span>
                </>
              ) : null}
              .
            </span>
            <div className={styles.prFormButtons}>
              <Button variant="ghost" size="sm" onClick={() => setPrFormOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={worktreeBusy || !prTitle.trim()}
                onClick={submitPr}
                data-testid="pr-create"
              >
                Create PR
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
