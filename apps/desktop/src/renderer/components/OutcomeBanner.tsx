import type { PhaseRow, RunRow } from '@shared/types.js';
import { useBrandedAsset } from '../hooks/useBrandedAsset.js';
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
  worktreeBusy,
  worktreeMessage,
  worktreeError = false,
  onMerge,
  onDiscard,
}: {
  run: RunRow;
  phases: PhaseRow[];
  worktreeBusy: boolean;
  worktreeMessage: string;
  worktreeError?: boolean;
  onMerge: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  const art = useBrandedAsset(artFor(run.status));
  const color = colorFor(run.status);
  const hasWorktree = !!run.worktreePath && !run.merged;

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
          <button
            className="btn sm"
            disabled={worktreeBusy}
            title="Merge the run branch into the project base ref"
            onClick={onMerge}
          >
            {worktreeBusy ? 'Working…' : 'Merge branch'}
          </button>
          <button
            className="btn sm danger"
            disabled={worktreeBusy}
            title="Delete the run worktree and branch"
            onClick={onDiscard}
          >
            Discard
          </button>
        </div>
      ) : run.merged ? (
        <span className={`badge ${styles.merged}`}>merged</span>
      ) : null}
    </section>
  );
}
