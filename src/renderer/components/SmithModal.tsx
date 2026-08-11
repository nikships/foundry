/**
 * The Smith terminal modal: a near-fullscreen dialog around the embedded
 * Ghostty terminal for the active project. Escape/close only HIDE it — the
 * engine and its droid session live in the main process and keep working in
 * the background, so scrollback and any running turn survive a close.
 *
 * The terminal is a sandboxed <canvas data-ghostty> painted zero-copy by the
 * main-side engine via `sharedTexture`; input (keys, mouse, IME, paste) and
 * CSS-size-driven resizes are wired by `preload/ghostty.ts`, which discovers
 * the canvas when this modal mounts it. Nothing terminal-shaped crosses the
 * FoundryApi contract — `smith.open` just ensures the session exists and
 * carries the renderer's resolved theme for ghostty's config.
 *
 * When `smith.open` returns a blocked status (no project, unreachable repo
 * path, droid missing, engine missing) the modal renders doctor-style
 * guidance instead of a terminal.
 */

import { useEffect, useState } from 'react';
import { Terminal as TerminalIcon, X } from 'lucide-react';
import type { SmithBlockedReason, SmithStatus, SmithTheme } from '@shared/types.js';
import { smithSlot } from '@shared/ipc-contract.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { Button } from './ui/Button.js';
import { ModalShell } from './ui/ModalShell.js';
import styles from './SmithModal.module.css';

/** Reads the app's palette off the DOM so the terminal matches the Foundry theme. */
function themeFromCss(): SmithTheme {
  const root = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string =>
    root.getPropertyValue(name).trim() || fallback;
  return {
    colors: {
      background: v('--bg-void', '#020202'),
      foreground: v('--text', '#eeeeee'),
      cursor: v('--accent', '#ee6018'),
      selectionBackground: v('--line-strong', '#3a3a3a'),
      black: v('--bg-void', '#020202'),
      red: v('--red', '#ef4444'),
      green: v('--green', '#34d399'),
      yellow: v('--amber', '#f5a623'),
      blue: v('--blue', '#60a5fa'),
      magenta: '#c084fc',
      cyan: '#22d3ee',
      white: v('--text-dim', '#8c8c8c'),
      brightBlack: '#4a4a4a',
      brightWhite: v('--text', '#eeeeee'),
    },
    scale: window.devicePixelRatio || 2,
    fontSize: 13,
  };
}

const BLOCKED_TITLE: Record<SmithBlockedReason, string> = {
  'no-project': 'No project selected',
  'invalid-path': 'Project path is unreachable',
  'droid-missing': 'droid is not installed',
  'engine-missing': 'Terminal engine unavailable',
};

export default function SmithModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { project } = useApp();
  const projectId = project?.id ?? '';
  const [status, setStatus] = useState<SmithStatus | null>(null);

  useEffect(() => {
    if (!projectId) {
      setStatus({ projectId: '', state: 'blocked', blocked: 'no-project' });
      return;
    }
    let cancelled = false;

    // Ensures the session exists; the preload notices the canvas below and
    // reports `ready`, which kicks the engine to draw (repainting scrollback
    // on reopen). Frames and input never touch this component.
    void api.smith.open(projectId, themeFromCss()).then((next) => {
      if (cancelled) return;
      setStatus(next);
    });

    // Status transitions keep the header dot honest while the modal is open.
    const offStatus = api.on('smith-status-changed', (data) => {
      const next = data as SmithStatus | undefined;
      if (next && next.projectId === projectId) setStatus(next);
    });

    return () => {
      cancelled = true;
      offStatus();
    };
  }, [projectId]);

  const blocked = status?.state === 'blocked';
  const stateWord = status?.state ?? 'starting';
  const stateDotClass =
    stateWord === 'idle'
      ? styles.stateDotIdle
      : stateWord === 'busy'
        ? styles.stateDotBusy
        : stateWord === 'exited'
          ? styles.stateDotExited
          : '';

  return (
    <ModalShell
      dismissible
      onClose={onClose}
      ariaLabelledBy="smith-title"
      tabIndex={-1}
      className={styles.dialog}
    >
      <header className={styles.header}>
        <span className={styles.title} id="smith-title">
          <TerminalIcon size={15} strokeWidth={1.9} aria-hidden />
          Smith
          {project && <span className={styles.projectName}>· {project.name}</span>}
        </span>
        <span className={styles.spacer} />
        {!blocked && (
          <span className={styles.state}>
            <span className={`${styles.stateDot} ${stateDotClass}`} aria-hidden />
            {stateWord}
          </span>
        )}
        <button type="button" className={styles.close} onClick={onClose} aria-label="Close Smith">
          <X size={16} strokeWidth={1.9} aria-hidden />
        </button>
      </header>

      {blocked ? (
        <div className={styles.guidance} role="status">
          <TerminalIcon className={styles.guidanceIcon} size={32} strokeWidth={1.6} aria-hidden />
          <h2 className={styles.guidanceTitle}>
            {status?.blocked ? BLOCKED_TITLE[status.blocked] : 'Smith is unavailable'}
          </h2>
          <p className={styles.guidanceBody}>
            {status?.detail ??
              'Smith needs a project with a reachable repository and droid installed on your PATH.'}
          </p>
          {status?.blocked === 'droid-missing' && (
            <div className={styles.guidanceActions}>
              <Button
                variant="primary"
                onClick={() => void api.app.openExternal('https://docs.factory.ai/cli')}
              >
                Install droid
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className={styles.terminalWrap}>
          {projectId && (
            <canvas
              className={styles.terminalCanvas}
              data-ghostty={smithSlot(projectId)}
              tabIndex={0}
              aria-label="Smith terminal"
            />
          )}
        </div>
      )}
    </ModalShell>
  );
}
