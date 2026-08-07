import type { UpdateStatus } from '@shared/types.js';

interface Props {
  status: UpdateStatus;
  onDownload: () => void;
  onRestart: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

export default function UpdateBanner({
  status,
  onDownload,
  onRestart,
  onRetry,
  onDismiss,
}: Props): React.JSX.Element | null {
  // Idle is handled as a transient toast by the shell, not as a persistent banner.
  if (status.stage === 'idle') return null;

  let title = '';
  let detail = '';
  let tone: 'cyan' | 'green' | 'red' | 'default' = 'default';

  if (status.stage === 'checking') {
    title = 'Checking for updates…';
    detail = 'Looking for the latest version of Foundry.';
  } else if (status.stage === 'available') {
    title = status.version ? `Foundry v${status.version} is available` : 'Update available';
    detail = 'Download now and restart when the install finishes.';
    tone = 'cyan';
  } else if (status.stage === 'downloading') {
    const pct = Math.round(status.percent ?? 0);
    title = `Downloading update… ${pct}%`;
    detail = status.version
      ? `Foundry v${status.version} is downloading.`
      : 'Your update is on its way.';
    tone = 'cyan';
  } else if (status.stage === 'ready') {
    title = status.version ? `Foundry v${status.version} is ready` : 'Update ready to install';
    detail = 'Restart Foundry now to apply the update.';
    tone = 'green';
  } else if (status.stage === 'error') {
    title = 'Update failed';
    detail = status.message || 'Something went wrong while checking for updates.';
    tone = 'red';
  }

  return (
    <>
      <div className={`banner tone-${tone}`} role="status" aria-live="polite">
        <div className="head">
          <div className="title-row">
            {status.stage === 'checking' ? <span className="spinner sm" aria-hidden /> : null}
            <strong className="title">{title}</strong>
          </div>
          <button className="dismiss" onClick={onDismiss} aria-label="Dismiss update banner">
            ✕
          </button>
        </div>
        <p className="detail">{detail}</p>

        {status.stage === 'downloading' && (
          <div className="progress" aria-label={`Download ${status.percent ?? 0} percent`}>
            <div className="track">
              <div
                className="fill"
                style={{ width: `${Math.min(100, Math.max(0, status.percent ?? 0))}%` }}
              />
            </div>
            <span className="pct mono">{Math.round(status.percent ?? 0)}%</span>
          </div>
        )}

        <div className="actions">
          {status.stage === 'available' && (
            <>
              <button className="btn primary sm" onClick={onDownload}>
                Download
              </button>
              <button className="btn sm ghost" onClick={onDismiss}>
                Later
              </button>
            </>
          )}
          {status.stage === 'downloading' && (
            <span className="hint faint">Keep Foundry open until the download finishes.</span>
          )}
          {status.stage === 'ready' && (
            <>
              <button className="btn primary sm" onClick={onRestart}>
                Restart to install
              </button>
              <button className="btn sm ghost" onClick={onDismiss}>
                Later
              </button>
            </>
          )}
          {status.stage === 'error' && (
            <>
              <button className="btn primary sm" onClick={onRetry}>
                Try again
              </button>
              <button className="btn sm ghost" onClick={onDismiss}>
                Dismiss
              </button>
            </>
          )}
          {status.stage === 'checking' && (
            <span className="hint faint">This usually takes a few seconds.</span>
          )}
        </div>
      </div>
      <style>{`
        .banner {
          position: fixed;
          bottom: 18px;
          left: 50%;
          transform: translateX(-50%);
          width: min(460px, calc(100vw - 32px));
          padding: var(--s4);
          border-radius: var(--r-lg);
          background: var(--bg-raised);
          border: 1px solid var(--line);
          box-shadow: var(--shadow-lg);
          z-index: 80;
          animation: fade-in 180ms var(--ease);
        }
        .head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s3); margin-bottom: var(--s1); }
        .title-row { display: flex; align-items: center; gap: var(--s2); min-width: 0; }
        .title { font-size: var(--text-sm); font-weight: 600; line-height: var(--leading-tight); }
        .dismiss {
          flex: none;
          width: 24px; height: 24px;
          display: grid; place-items: center;
          border: none; border-radius: var(--r-sm);
          background: transparent; color: var(--text-faint);
          font-size: 13px; cursor: default;
        }
        .dismiss:hover { background: var(--bg-hover); color: var(--text); }
        .detail { font-size: var(--text-xs); color: var(--text-dim); line-height: var(--leading); margin-bottom: var(--s3); }
        .progress { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s3); }
        .track {
          flex: 1; height: 6px; border-radius: var(--r-full);
          background: var(--bg-void); border: 1px solid var(--line-faint);
          overflow: hidden;
        }
        .fill { height: 100%; background: var(--cyan); border-radius: var(--r-full); transition: width 260ms var(--ease); }
        .tone-green .fill { background: var(--green); }
        .tone-red .fill { background: var(--red); }
        .pct { font-size: var(--text-xs); color: var(--text-dim); min-width: 36px; text-align: right; }
        .actions { display: flex; align-items: center; gap: var(--s2); }
        .actions .hint { font-size: var(--text-xs); }
        .spinner.sm { width: 14px; height: 14px; border: 2px solid var(--line-strong); border-top-color: var(--cyan); border-radius: var(--r-full); animation: spin 700ms linear infinite; flex: none; }
        .tone-green { border-color: var(--green-dim); }
        .tone-cyan { border-color: var(--cyan-dim); }
        .tone-red { border-color: var(--red-dim); }
      `}</style>
    </>
  );
}
