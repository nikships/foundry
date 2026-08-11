import { api } from '../api.js';
import styles from './WindowTrafficLights.module.css';

export default function WindowTrafficLights({
  collapsed = false,
}: {
  collapsed?: boolean;
}): React.JSX.Element {
  return (
    <div className={`${styles.rail} ${collapsed ? styles.railCollapsed : ''}`}>
      <div className={styles.housing} role="group" aria-label="Window controls">
        <button
          type="button"
          className={`${styles.dot} ${styles.close}`}
          aria-label="Close window"
          onClick={() => void api.app.windowClose()}
        >
          <span className={styles.glyph} aria-hidden>
            ×
          </span>
        </button>
        <button
          type="button"
          className={`${styles.dot} ${styles.minimize}`}
          aria-label="Minimize window"
          onClick={() => void api.app.windowMinimize()}
        >
          <span className={styles.glyph} aria-hidden>
            –
          </span>
        </button>
        <button
          type="button"
          className={`${styles.dot} ${styles.maximize}`}
          aria-label="Zoom window"
          onClick={() => void api.app.windowMaximize()}
        >
          <span className={styles.glyph} aria-hidden>
            +
          </span>
        </button>
      </div>
    </div>
  );
}
