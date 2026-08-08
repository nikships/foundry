import type { UpdateStatus } from '@shared/types.js';
import { Button } from './ui/Button.js';
import styles from './UpdateBanner.module.css';

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

  const toneClass =
    tone === 'green'
      ? styles.toneGreen
      : tone === 'cyan'
        ? styles.toneCyan
        : tone === 'red'
          ? styles.toneRed
          : '';

  return (
    <div className={`${styles.banner} ${toneClass}`} role="status" aria-live="polite">
      <div className={styles.head}>
        <div className={styles.titleRow}>
          {status.stage === 'checking' ? (
            <span className={`${styles.spinner} ${styles.sm}`} aria-hidden />
          ) : null}
          <strong className={styles.title}>{title}</strong>
        </div>
        <button className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss update banner">
          ✕
        </button>
      </div>
      <p className={styles.detail}>{detail}</p>

      {status.stage === 'downloading' && (
        <div className={styles.progress} aria-label={`Download ${status.percent ?? 0} percent`}>
          <div className={styles.track}>
            <div
              className={styles.fill}
              style={{ width: `${Math.min(100, Math.max(0, status.percent ?? 0))}%` }}
            />
          </div>
          <span className={`${styles.pct} mono`}>{Math.round(status.percent ?? 0)}%</span>
        </div>
      )}

      <div className={styles.actions}>
        {status.stage === 'available' && (
          <>
            <Button variant="primary" size="sm" onClick={onDownload}>
              Download
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Later
            </Button>
          </>
        )}
        {status.stage === 'downloading' && (
          <span className="hint faint">Keep Foundry open until the download finishes.</span>
        )}
        {status.stage === 'ready' && (
          <>
            <Button variant="primary" size="sm" onClick={onRestart}>
              Restart to install
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Later
            </Button>
          </>
        )}
        {status.stage === 'error' && (
          <>
            <Button variant="primary" size="sm" onClick={onRetry}>
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        )}
        {status.stage === 'checking' && (
          <span className="hint faint">This usually takes a few seconds.</span>
        )}
      </div>
    </div>
  );
}
