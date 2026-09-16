import { useState, type CSSProperties } from 'react';
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
  collapsible = false,
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
  /** Whether checks are collapsible. When true, all checks default to collapsed. */
  collapsible?: boolean;
}): React.JSX.Element {
  const [expandedChecks, setExpandedChecks] = useState<Record<string, boolean>>({});

  const toggleCheck = (id: string): void => {
    setExpandedChecks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const anyExpanded = checks.some((c) => expandedChecks[c.id]);

  const toggleAll = (): void => {
    if (anyExpanded) {
      setExpandedChecks({});
    } else {
      const all: Record<string, boolean> = {};
      for (const check of checks) {
        all[check.id] = true;
      }
      setExpandedChecks(all);
    }
  };

  const openFix = (fix: NonNullable<DoctorCheck['fix']>): void => {
    if (fix.kind === 'open-url') {
      void api.app.openExternal(fix.value);
      return;
    }
    if (fix.kind === 'open-settings') {
      // project-commands is a deep link into the Project pane.
      onOpenSettings?.(fix.value === 'project-commands' ? 'project' : fix.value);
    }
  };

  return (
    <section className={styles.doctor}>
      {!hideHeader && (
        <div className={`spread ${styles.head}`}>
          <h3>{title}</h3>
          <div className={styles.headActions}>
            {collapsible && checks.length > 0 && (
              <Button variant="ghost" size="sm" onClick={toggleAll}>
                {anyExpanded ? 'Collapse all' : 'Expand all'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onRecheck} disabled={checking}>
              Re-check
            </Button>
          </div>
        </div>
      )}
      <ul>
        {checks.map((check, idx) => {
          const fix = check.ok ? undefined : check.fix;
          const showFix = fix && (fix.kind === 'open-url' || Boolean(onOpenSettings));
          const isOpen = Boolean(expandedChecks[check.id]);

          if (collapsible) {
            return (
              <li
                key={check.id}
                className={cx(styles.collapsibleItem, check.ok ? '' : styles.bad)}
                data-testid={`doctor-check-${check.id}`}
              >
                <button
                  type="button"
                  className={styles.checkHeadButton}
                  aria-expanded={isOpen}
                  aria-controls={`doctor-check-detail-${check.id}`}
                  onClick={() => toggleCheck(check.id)}
                >
                  <DoctorCheckbox ok={check.ok} index={idx} animate={animate} checking={checking} />
                  <strong className={styles.checkLabel}>{check.label}</strong>
                  <span
                    className={cx(styles.chevron, isOpen && styles.chevronOpen)}
                    aria-hidden="true"
                  >
                    ▾
                  </span>
                </button>
                <div
                  id={`doctor-check-detail-${check.id}`}
                  className={cx(styles.collapse, isOpen && styles.collapseOpen)}
                >
                  <div className={styles.collapseInner}>
                    <div className={styles.collapseBody}>
                      <em className="faint">{check.detail}</em>
                      {showFix && (
                        <div className={styles.fixAction}>
                          <Button size="sm" onClick={() => openFix(fix)}>
                            {fix.kind === 'open-url' ? 'Open docs' : 'Fix'}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </li>
            );
          }

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
