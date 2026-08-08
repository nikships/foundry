import type { DoctorCheck } from '@shared/types.js';
import { api } from '../api.js';

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
    <>
      <section className="doctor">
        <div className="spread head">
          <h3>{title}</h3>
          <button className="btn sm ghost" onClick={onRecheck}>
            Re-check
          </button>
        </div>
        <ul>
          {checks.map((check) => (
            <li key={check.id} className={check.ok ? '' : 'bad'}>
              <span className="mark">{check.ok ? '✓' : '✕'}</span>
              <span className="text">
                <strong>{check.label}</strong>
                <em className="faint">{check.detail}</em>
              </span>
              {!check.ok && check.fix && (check.fix.kind === 'open-url' || onOpenSettings) && (
                <button className="btn sm" onClick={() => openFix(check)}>
                  {check.fix.kind === 'open-url' ? 'Open docs' : 'Fix'}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <style>{`
        /* Flat: hairline-separated rows on the shared surface, no boxed card. */
        .doctor .head { margin-bottom: var(--s2); }
        .doctor h3 { font-size: var(--text-sm); font-weight: 500; margin: 0; }
        .doctor ul { list-style: none; display: flex; flex-direction: column; }
        .doctor li { display: flex; align-items: flex-start; gap: var(--s3); font-size: var(--text-sm); padding: var(--s2) 0; border-top: 1px solid var(--line-faint); }
        .doctor .mark { color: var(--green); flex: none; width: 14px; }
        .doctor li.bad .mark { color: var(--red); }
        .doctor .text { flex: 1; min-width: 0; }
        .doctor em { display: block; font-style: normal; font-size: var(--text-xs); line-height: var(--leading); margin-top: 1px; }
        .spread { display: flex; align-items: center; justify-content: space-between; }
      `}</style>
    </>
  );
}
