import type { UpdateStatus } from '@shared/types.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import styles from './UpdateBanner.module.css';

interface Props {
  status: UpdateStatus;
  onDownload: () => void;
  onRestart: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

const TONE_CLASS: Record<string, string> = {
  available: styles.toneCyan,
  downloading: styles.toneCyan,
  ready: styles.toneGreen,
  error: styles.toneRed,
};

function copyFor(status: UpdateStatus): { title: string; detail: string } {
  switch (status.stage) {
    case 'checking':
      return {
        title: 'Checking for updates…',
        detail: 'Looking for the latest version of Foundry.',
      };
    case 'available':
      return {
        title: status.version ? `Foundry v${status.version} is available` : 'Update available',
        detail: 'Download now and restart when the install finishes.',
      };
    case 'downloading':
      return {
        title: `Downloading update… ${Math.round(status.percent ?? 0)}%`,
        detail: status.version
          ? `Foundry v${status.version} is downloading.`
          : 'Your update is on its way.',
      };
    case 'ready':
      return {
        title: status.version ? `Foundry v${status.version} is ready` : 'Update ready to install',
        detail: 'Restart Foundry now to apply the update.',
      };
    case 'error':
      return {
        title: 'Update failed',
        detail: status.message || 'Something went wrong while checking for updates.',
      };
    default:
      return { title: '', detail: '' };
  }
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

  const { title, detail } = copyFor(status);
  const percent = Math.min(100, Math.max(0, status.percent ?? 0));

  return (
    <div className={cx(styles.banner, TONE_CLASS[status.stage])} role="status" aria-live="polite">
      <div className={styles.head}>
        <div className={styles.titleRow}>
          {status.stage === 'checking' && (
            <span className={cx(styles.spinner, styles.sm)} aria-hidden />
          )}
          <strong className={styles.title}>{title}</strong>
        </div>
        <button
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss update banner"
          data-testid="update-dismiss"
        >
          ✕
        </button>
      </div>
      <p className={styles.detail}>{detail}</p>

      {status.stage === 'downloading' && (
        <div className={styles.progress} aria-label={`Download ${status.percent ?? 0} percent`}>
          <div className={styles.track}>
            <div className={styles.fill} style={{ width: `${percent}%` }} />
          </div>
          <span className={`${styles.percent} mono`}>{percent}%</span>
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
