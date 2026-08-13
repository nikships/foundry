/**
 * Which set the Design tab in front of you is editing, and the control to
 * change it.
 *
 * The scope flags have always existed on `ProjectDef`, but only in Settings, so
 * an operator editing an agent could not tell whether the edit was landing
 * globally or in one project. The badge answers that where the editing happens.
 *
 * The toggle is deliberately behind a click rather than inline: turning a copy
 * on forks this project away from the global set permanently, which is not an
 * action to put one stray click away from a text field.
 */

import { useEffect, useRef, useState } from 'react';
import type { ProjectDef } from '@shared/types.js';
import { api, plain } from '../api.js';
import type { DesignTab } from '../navigation.js';
import { forkNotice, resolveDesignScope, revertNotice, scopeFieldFor } from '../design-scope.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { Button } from './ui/Button.js';
import styles from './DesignScopeControl.module.css';

export default function DesignScopeControl({
  tab,
  project,
  onChanged,
}: {
  tab: DesignTab;
  project: ProjectDef | null;
  /** Re-read the visible list after a scope change — same path Settings uses. */
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copies, setCopies] = useState<{ roster: boolean; pipelines: boolean } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const scope = resolveDesignScope(tab, project);
  const field = scopeFieldFor(tab);
  const isProjectScoped = scope.level === 'project';

  useEscapeToClose(() => setOpen(false), open);

  // Close on an outside click so the popover behaves like the rest of the app.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Whether a project copy is already on disk decides which sentence is true,
  // so it is read when the panel opens rather than assumed.
  useEffect(() => {
    if (!open || !project) return;
    let cancelled = false;
    void api.projects.scopeCopies(project.id).then((next) => {
      if (!cancelled) setCopies(next);
    });
    return () => {
      cancelled = true;
    };
  }, [open, project]);

  const apply = async (next: boolean): Promise<void> => {
    if (!project || !field) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.projects.save(plain({ ...project, [field]: next }));
      if (!result.ok) {
        setError(result.issues.map((i) => i.message).join(' ') || 'Could not change scope.');
        return;
      }
      await onChanged();
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const hasExistingCopy = tab === 'agents' ? !!copies?.roster : !!copies?.pipelines;

  return (
    <div className={styles.scope} ref={popRef}>
      <button
        type="button"
        className={`${styles.badge} ${isProjectScoped ? styles.project : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!scope.toggleable}
        title={scope.detail}
        onClick={() => scope.toggleable && setOpen((v) => !v)}
      >
        {project && <span className={styles.badgeProject}>{project.name}</span>}
        <span className={styles.badgeDot} aria-hidden />
        <span className={styles.badgeLabel}>{scope.label}</span>
      </button>

      {open && scope.toggleable && project && (
        <div className={styles.pop} role="dialog" aria-label={`Scope for ${tab}`}>
          <p className={styles.popNow}>{scope.detail}</p>
          <p className={styles.popNote}>
            {isProjectScoped ? revertNotice(tab) : forkNotice(tab, hasExistingCopy)}
          </p>
          {error && <p className={styles.popError}>{error}</p>}
          <div className={styles.popActions}>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void apply(!isProjectScoped)} disabled={busy}>
              {isProjectScoped ? 'Use the global set' : 'Keep a copy in this project'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
