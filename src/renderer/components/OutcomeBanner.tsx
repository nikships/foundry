import { useState } from 'react';
import type { EnvelopeRow, GhStatus, PhaseRow, RunRow } from '@shared/types.js';
import { useBrandedAsset } from '../hooks/useBrandedAsset.js';
import { manualPrDraft } from '../pr-draft.js';
import { Button } from './ui/Button.js';
import styles from './OutcomeBanner.module.css';

function headlineFor(status: RunRow['status']): string {
  switch (status) {
    case 'accepted':
      return 'Accepted';
    case 'rejected':
      return 'Not accepted';
    case 'killed':
      return 'Killed';
    default:
      return 'Failed';
  }
}

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

function explanationFor(run: RunRow, phases: PhaseRow[]): string {
  const failed = phases.filter((p) => p.status === 'fail');
  switch (run.status) {
    case 'accepted':
      return run.outcomeDetail || 'Every phase passed and the acceptance criterion was met.';
    case 'rejected': {
      const failNote = failed.length ? ` (${failed.map((p) => p.name).join(', ')} failed)` : '';
      return (
        run.outcomeDetail ||
        `The pipeline ran to the end, but its acceptance criterion was not met${failNote}.`
      );
    }
    case 'killed':
      return 'Stopped by hand. Anything the run had already committed is still on its branch.';
    default:
      return run.outcomeDetail || 'The engine could not finish this run.';
  }
}

export default function OutcomeBanner({
  run,
  phases,
  envelopes = [],
  worktreeBusy,
  worktreeMessage,
  worktreeError = false,
  gh,
  canFix = false,
  onMerge,
  onFixMerge,
  onDiscard,
  onCreatePr,
  onOpenUrl,
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
  /** True after a refused merge, which is when the agent repair applies. */
  canFix?: boolean;
  onMerge: () => void;
  onFixMerge?: () => void;
  onDiscard: () => void;
  onCreatePr: (title: string, body: string) => void;
  onOpenUrl: (url: string) => void;
}): React.JSX.Element {
  const art = useBrandedAsset(artFor(run.status));
  const color = colorFor(run.status);
  const hasWorktree = !!run.worktreePath && !run.merged;
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
        <h2 style={{ color }}>{headlineFor(run.status)}</h2>
        <p>{explanationFor(run, phases)}</p>
        {worktreeMessage && (
          <p
            className={`${styles.note} mono ${worktreeError ? styles.bad : 'faint'}`}
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
          {canFix && onFixMerge && (
            <Button
              variant="primary"
              size="sm"
              disabled={worktreeBusy}
              title="An agent rebases the run branch onto the base inside its worktree; Foundry verifies the result and merges it"
              onClick={onFixMerge}
            >
              {worktreeBusy ? 'Working…' : 'Fix & merge with agent'}
            </Button>
          )}
          {run.prUrl ? (
            <Button
              size="sm"
              disabled={worktreeBusy}
              title="Open this run's pull request on GitHub"
              onClick={() => onOpenUrl(run.prUrl!)}
            >
              PR #{run.prNumber ?? '?'} ↗
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={worktreeBusy || !ghReady}
              title={ghHint || 'Push the run branch and open a pull request on GitHub'}
              onClick={() => (prFormOpen ? setPrFormOpen(false) : openPrForm())}
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
          >
            {worktreeBusy ? 'Working…' : 'Merge branch'}
          </Button>
          <Button
            variant="danger"
            size="sm"
            disabled={worktreeBusy}
            title="Delete the run worktree and branch"
            onClick={onDiscard}
          >
            Discard
          </Button>
        </div>
      ) : run.merged ? (
        <div className={styles.actions}>
          {run.prUrl && (
            <Button
              variant="ghost"
              size="sm"
              title="Open this run's pull request on GitHub"
              onClick={() => onOpenUrl(run.prUrl!)}
            >
              PR #{run.prNumber ?? '?'} ↗
            </Button>
          )}
          <span className={`badge ${styles.merged}`}>merged</span>
        </div>
      ) : null}
      {prFormOpen && hasWorktree && !run.prUrl && (
        <div className={styles.prForm}>
          <input
            className="input"
            value={prTitle}
            placeholder="Pull request title"
            onChange={(e) => setPrTitle(e.target.value)}
          />
          <textarea
            className={`input ${styles.prBody}`}
            value={prBody}
            placeholder="Pull request description"
            rows={5}
            onChange={(e) => setPrBody(e.target.value)}
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
