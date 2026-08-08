import type { DoctorCheck } from '@shared/types.js';
import { api } from '../api.js';
import { Button } from './ui/Button.js';
import styles from './DoctorList.module.css';

export default function DoctorList({
  checks,
  onRecheck,
  onOpenSettings,
  title = 'Checks',
}: {
  checks: DoctorCheck[];
  onRecheck: () => void;
  onOpenSettings?: (pane: string) => void;
  /** Head row label; settings panes pass a more specific one. */
  title?: string;
}): React.JSX.Element {
  const openFix = (check: DoctorCheck): void => {
    if (!check.fix) return;
    if (check.fix.kind === 'open-url') {
      void api.app.openExternal(check.fix.value);
      return;
    }
    if (check.fix.kind === 'open-settings') {
      // project-commands is a deep link into the Project pane.
      const pane = check.fix.value === 'project-commands' ? 'project' : check.fix.value;
      onOpenSettings?.(pane);
    }
  };

  return (
    <section className={styles.doctor}>
      <div className={`spread ${styles.head}`}>
        <h3>{title}</h3>
        <Button variant="ghost" size="sm" onClick={onRecheck}>
          Re-check
        </Button>
      </div>
      <ul>
        {checks.map((check) => (
          <li key={check.id} className={check.ok ? '' : styles.bad}>
            <span className={styles.mark}>{check.ok ? '✓' : '✕'}</span>
            <span className={styles.text}>
              <strong>{check.label}</strong>
              <em className="faint">{check.detail}</em>
            </span>
            {!check.ok && check.fix && (check.fix.kind === 'open-url' || onOpenSettings) && (
              <Button size="sm" onClick={() => openFix(check)}>
                {check.fix.kind === 'open-url' ? 'Open docs' : 'Fix'}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
