/**
 * The Smith launcher. Does the one job the app still has in starting a session:
 * get the user into their own terminal, in the right directory, holding the three
 * things they cannot guess — the helper CLI's resolved path, where the skill
 * shipped, and the project scope.
 *
 * This is the fallback, not the front door. The sidebar's Smith button starts the
 * session outright when the preferred terminal can be handed one, and only opens
 * this when it could not: no project, an emulator that takes no command, a
 * missing agent CLI, or a launch that failed. So it renders one of two shapes,
 * decided by main's `canAutoStart` — a retry button for the prepared case, and
 * the manual handoff (open the directory, paste the bootstrap) for the rest,
 * because typing into those emulators means AppleScript a vendor update can break.
 *
 * Deliberately not a terminal, and deliberately not a wizard. Everything it shows
 * is resolved fresh by main on open, because the app can be moved and the
 * preference can change between opens.
 */

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, TerminalSquare } from 'lucide-react';
import type { SmithLaunchInfo } from '@shared/types.js';
import { api } from '../../api.js';
import { Button } from '../ui/Button.js';
import { ModalShell } from '../ui/ModalShell.js';
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
  initialError = '',
  onClose,
  onOpenSettings,
}: {
  /** The active project. Empty means nothing is selected. */
  projectId: string;
  /** An error from the sidebar's one-click start, so the reason is not lost on the way here. */
  initialError?: string;
  onClose: () => void;
  /** Opens the settings pane holding the terminal preference. */
  onOpenSettings?: (pane: string) => void;
}): React.JSX.Element {
  const [info, setInfo] = useState<SmithLaunchInfo | null>(null);
  const [error, setError] = useState(initialError);
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
  const autoStart = !!info?.canAutoStart;

  return (
    <ModalShell onClose={onClose} ariaLabelledBy="smith-launcher-title" className={styles.dialog}>
      <header className={styles.header}>
        <TerminalSquare size={18} strokeWidth={1.9} aria-hidden className={styles.headerIcon} />
        <div>
          <h2 className={styles.title} id="smith-launcher-title">
            Start a Smith session
          </h2>
          <p className={styles.subtitle}>
            {autoStart
              ? `Foundry opens ${terminal?.label}, starts ${info?.agent.label ?? 'your agent'} in this project, and has it load the Smith skill. Foundry stays listening and approves every write.`
              : 'Smith runs in your terminal, on whichever agent you like. Foundry stays listening and approves every write.'}
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
          data-testid="smith-launch"
        >
          <TerminalSquare size={14} aria-hidden />
          {opening
            ? autoStart
              ? 'Starting…'
              : 'Opening…'
            : autoStart
              ? 'Start Smith'
              : `Open ${terminal?.label ?? 'Terminal'}`}
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

      {autoStart ? (
        <div className={styles.block}>
          <span className={styles.label}>Sent to your agent</span>
          <pre className={`${styles.code} selectable`}>{info?.prompt}</pre>
          <p className={styles.hint}>
            The window is left in a shell at the project root when the agent exits, with{' '}
            <code>foundry-cli</code> still on its PATH. Ask Smith to create or edit an agent,
            pipeline, or report — each write raises an approval card here.
          </p>
        </div>
      ) : (
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
            <span className={styles.stepText}>Need the skill?</span>
            <CopyRow label="Skill" value="npx skills add nikships/foundry" />
          </li>
          <li>
            <span className={styles.stepText}>
              Ask it to create or edit an agent, pipeline, or report. Each write raises an approval
              card here.
            </span>
          </li>
        </ol>
      )}

      <footer className={styles.footer}>
        <span className={styles.footNote}>
          {info?.autoStartBlocked === 'terminal' && (
            <>Only Ghostty can be handed a ready-made session; the rest get the manual handoff. </>
          )}
          {info?.autoStartBlocked === 'agent-cli' && (
            <>
              Foundry could not find {info.agent.label} ({info.agent.binary}) on your PATH, so it
              cannot start the session for you.{' '}
            </>
          )}
          Terminal and coding-agent preferences live in{' '}
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
