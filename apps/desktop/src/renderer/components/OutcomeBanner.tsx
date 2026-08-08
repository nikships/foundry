import type { PhaseRow, RunRow } from '@shared/types.js';
import { useBrandedAsset } from '../hooks/useBrandedAsset.js';

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
    <>
      <section
        className="banner"
        style={{
          borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
          background: `color-mix(in srgb, ${color} 8%, var(--bg-panel))`,
        }}
      >
        {art && <img src={art} alt="" />}
        <div className="text">
          <h2 style={{ color }}>{headlineFor(run.status)}</h2>
          <p>{explanationFor(run, phases)}</p>
          {worktreeMessage && (
            <p
              className={`note mono ${worktreeError ? 'bad' : 'faint'}`}
              role={worktreeError ? 'alert' : undefined}
            >
              {worktreeBusy ? 'Working… ' : ''}
              {worktreeMessage}
            </p>
          )}
          {worktreeBusy && !worktreeMessage && (
            <p className="faint note">Working on the worktree…</p>
          )}
        </div>
        {hasWorktree ? (
          <div className="actions">
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
          <span className="badge merged">merged</span>
        ) : null}
      </section>
      <style>{`
        .banner { display: flex; align-items: center; gap: var(--s4); margin: var(--s4) var(--s6) 0; padding: var(--s3) var(--s4); border: 1px solid; border-radius: var(--r-lg); animation: fade-in var(--normal) var(--ease); }
        .banner img { width: 64px; height: 64px; object-fit: contain; flex: none; }
        .banner .text { flex: 1; min-width: 0; }
        .banner h2 { font-size: var(--text-base); font-weight: 600; margin-bottom: 2px; }
        .banner p { font-size: var(--text-sm); color: var(--text-dim); line-height: var(--leading); }
        .banner .note { font-size: var(--text-xs); margin-top: var(--s2); }
        .banner .note.bad { color: var(--red); }
        .actions { display: flex; gap: var(--s2); flex: none; }
        .merged { background: var(--green-dim); color: var(--green); padding: 2px 8px; border-radius: var(--r-full); font-size: var(--text-xs); }
      `}</style>
    </>
  );
}
