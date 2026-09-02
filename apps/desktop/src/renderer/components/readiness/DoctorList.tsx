import type { CSSProperties } from 'react';
import type { DoctorCheck } from '@shared/types.js';
import { api } from '../../api.js';
import { Button } from '../ui/Button.js';
import { cx } from '../ui/cx.js';
import styles from './DoctorList.module.css';

export function DoctorCheckbox({
  ok,
  index = 0,
  animate = true,
  checking = false,
}: {
  ok: boolean;
  index?: number;
  animate?: boolean;
  checking?: boolean;
}): React.JSX.Element {
  return (
    <span
      className={cx(
        styles.checkbox,
        ok ? styles.checkboxOk : styles.checkboxBad,
        checking && styles.checkboxChecking,
        animate && styles.checkboxAnimated,
      )}
      style={{ '--check-delay': `${index * 110 + 120}ms` } as CSSProperties}
      aria-hidden="true"
    >
      <svg
        className={ok ? styles.checkIcon : styles.crossIcon}
        viewBox="0 0 16 16"
        width="11"
        height="11"
        fill="none"
        aria-hidden="true"
      >
        {ok ? (
          <polyline
            points="3.2 8.2 6.4 11.4 12.8 4.6"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M4.5 4.5 L11.5 11.5 M11.5 4.5 L4.5 11.5"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        )}
      </svg>
    </span>
  );
}

export default function DoctorList({
  checks,
  onRecheck,
  onOpenSettings,
  title = 'Checks',
  hideHeader = false,
  animate = true,
  checking = false,
}: {
  checks: DoctorCheck[];
  onRecheck: () => void;
  onOpenSettings?: (pane: string) => void;
  /** Head row label; settings panes pass a more specific one. */
  title?: string;
  /** Hide internal header when parent panel already has one. */
  hideHeader?: boolean;
  /** Whether to animate checkboxes sequentially. */
  animate?: boolean;
  /** Whether a recheck is currently in progress. */
  checking?: boolean;
}): React.JSX.Element {
  const openFix = (fix: NonNullable<DoctorCheck['fix']>): void => {
    if (fix.kind === 'open-url') void api.app.openExternal(fix.value);
    // project-commands is a deep link into the Project pane.
    else if (fix.kind === 'open-settings')
      onOpenSettings?.(fix.value === 'project-commands' ? 'project' : fix.value);
  };

  return (
    <section className={styles.doctor}>
      {!hideHeader && (
        <div className={`spread ${styles.head}`}>
          <h3>{title}</h3>
          <Button variant="ghost" size="sm" onClick={onRecheck} disabled={checking}>
            Re-check
          </Button>
        </div>
      )}
      <ul>
        {checks.map((check, idx) => {
          const fix = check.ok ? undefined : check.fix;
          const showFix = fix && (fix.kind === 'open-url' || Boolean(onOpenSettings));
          return (
            <li
              key={check.id}
              className={check.ok ? '' : styles.bad}
              data-testid={`doctor-check-${check.id}`}
            >
              <DoctorCheckbox ok={check.ok} index={idx} animate={animate} checking={checking} />
              <span className={styles.text}>
                <strong>{check.label}</strong>
                <em className="faint">{check.detail}</em>
              </span>
              {showFix && (
                <Button size="sm" onClick={() => openFix(fix)}>
                  {fix.kind === 'open-url' ? 'Open docs' : 'Fix'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
