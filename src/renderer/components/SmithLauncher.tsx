/**
 * The Smith launcher. Sits where the embedded terminal's modal used to, and does
 * the one job the app still has in starting a session: get the user into their
 * own terminal, in the right directory, holding the three things they cannot
 * guess — the helper CLI's resolved path, where the skill shipped, and the
 * project scope.
 *
 * Deliberately not a terminal, and deliberately not a wizard. One button that
 * opens the emulator, two copyable blocks, and a note about where to change the
 * emulator. Everything it shows is resolved fresh by main on open, because the
 * app can be moved and the preference can change between opens.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, TerminalSquare } from 'lucide-react';
import type { SmithLaunchInfo } from '@shared/types.js';
import { api } from '../api.js';
import { Button } from './ui/Button.js';
import { ModalShell } from './ui/ModalShell.js';
import styles from './SmithLauncher.module.css';

/** A labelled, copyable block. The copy confirmation resets itself. */
function CopyRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    void navigator.clipboard.writeText(value).then(() => setCopied(true));
  };

  return (
    <div className={styles.block}>
      <div className={styles.blockHead}>
        <span className={styles.label}>{label}</span>
        <Button size="sm" variant="ghost" onClick={copy} disabled={!value}>
          {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className={`${styles.code} selectable`}>{value || '—'}</pre>
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}

export default function SmithLauncher({
  projectId,
  onClose,
  onOpenSettings,
}: {
  /** The active project. Empty means nothing is selected. */
  projectId: string;
  onClose: () => void;
  /** Opens the settings pane holding the terminal preference. */
  onOpenSettings?: (pane: string) => void;
}): React.JSX.Element {
  const [info, setInfo] = useState<SmithLaunchInfo | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.smith.launchInfo(projectId).then((next) => {
      if (!cancelled) setInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const openTerminal = useCallback(async (): Promise<void> => {
    setOpening(true);
    setError('');
    const result = await api.smith.openTerminal(projectId);
    setOpening(false);
    if (!result.ok) setError(result.error ?? 'Could not open the terminal.');
  }, [projectId]);

  const project = info?.project ?? null;
  const terminal = info?.terminal;
  const blocked = !project ? 'no-project' : !project.exists ? 'missing-path' : '';

  return (
    <ModalShell onClose={onClose} ariaLabelledBy="smith-launcher-title" className={styles.dialog}>
      <header className={styles.header}>
        <TerminalSquare size={18} strokeWidth={1.9} aria-hidden className={styles.headerIcon} />
        <div>
          <h2 className={styles.title} id="smith-launcher-title">
            Start a Smith session
          </h2>
          <p className={styles.subtitle}>
            Smith runs in your terminal, on whichever agent you like. Foundry stays listening and
            approves every write.
          </p>
        </div>
      </header>

      {blocked === 'no-project' && (
        <p className={styles.notice}>
          Select a project first — Smith scopes its agents and pipelines to one.
        </p>
      )}
      {blocked === 'missing-path' && project && (
        <p className={styles.notice}>
          <code>{project.path}</code> is not on disk any more. Fix the project&apos;s path in
          Settings, then reopen this.
        </p>
      )}

      <div className={styles.launchRow}>
        <Button
          variant="primary"
          onClick={() => void openTerminal()}
          disabled={!!blocked || opening}
        >
          <TerminalSquare size={14} aria-hidden />
          {opening ? 'Opening…' : `Open ${terminal?.label ?? 'Terminal'}`}
        </Button>
        {project && <span className={styles.path}>{project.path}</span>}
      </div>

      {terminal && !terminal.installed && (
        <p className={styles.notice}>
          {terminal.label} does not look installed.{' '}
          <button type="button" className={styles.link} onClick={() => onOpenSettings?.('general')}>
            Pick another terminal
          </button>
          .
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <ol className={styles.steps}>
        <li>
          <span className={styles.stepText}>Paste this into the new shell.</span>
          <CopyRow
            label="Bootstrap"
            value={info?.bootstrap ?? ''}
            hint="Defines foundry-cli and scopes it to this project."
          />
        </li>
        <li>
          <span className={styles.stepText}>
            Point your agent at the skill, or copy the folder into your harness&apos;s skills
            directory.
          </span>
          <CopyRow
            label="Skill"
            value={info ? `${info.skillDir}/SKILL.md` : ''}
            hint="Loading it turns any agent into Smith."
          />
        </li>
        <li>
          <span className={styles.stepText}>
            Ask it to create or edit an agent, pipeline, or envelope. Each write raises an approval
            card here.
          </span>
        </li>
      </ol>

      <footer className={styles.footer}>
        <span className={styles.footNote}>
          Terminal preference lives in{' '}
          <button type="button" className={styles.link} onClick={() => onOpenSettings?.('general')}>
            Settings → General
          </button>
          .
        </span>
        <span className={styles.spacer} />
        <Button onClick={onClose}>Done</Button>
      </footer>
    </ModalShell>
  );
}
