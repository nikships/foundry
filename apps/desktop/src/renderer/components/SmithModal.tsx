/**
 * The Smith terminal modal: a near-fullscreen dialog wrapping an embedded droid
 * session for the active project. Escape/close only HIDE it — the PTY lives in
 * the main process and keeps working in the background, so scrollback and any
 * running turn survive a close.
 *
 * The xterm instance is cached per project at module scope (`terminals`), so
 * reopening the modal reattaches the same terminal rather than building a fresh
 * one and losing its scrollback. On open we call `smith.open`, repaint the ring
 * buffer the main-side registry exposes, subscribe to the `smith-data`
 * broadcast, wire input/resize back over IPC, and focus.
 *
 * When `smith.open` returns a blocked status (no project, unreachable repo path,
 * droid missing) the modal renders doctor-style guidance instead of a terminal.
 *
 * The fallback engine (spec §5) streams PTY bytes, which is exactly what xterm
 * consumes here. The Ghostty engine would swap the view for a canvas; this modal
 * is where that branch lands, keyed off the eventual engine descriptor.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Terminal as TerminalIcon, X } from 'lucide-react';
import type { SmithBlockedReason, SmithStatus } from '@shared/types.js';
import { api } from '../api.js';
import { useApp } from '../stores/app.js';
import { Button } from './ui/Button.js';
import { ModalShell } from './ui/ModalShell.js';
import styles from './SmithModal.module.css';

/** One live xterm per project, kept alive across modal open/close for scrollback. */
interface CachedTerminal {
  term: Terminal;
  fit: FitAddon;
  /** True once the current ring buffer has been repainted, so reopen does not double-paint. */
  painted: boolean;
}
const terminals = new Map<string, CachedTerminal>();

/** Reads the app's palette off the DOM so the terminal matches the Foundry theme. */
function themeFromCss(): Record<string, string> {
  const root = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string): string => root.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--bg-void', '#020202'),
    foreground: v('--text', '#eeeeee'),
    cursor: v('--accent', '#ee6018'),
    cursorAccent: v('--bg-void', '#020202'),
    selectionBackground: v('--line-strong', 'rgba(255,255,255,0.18)'),
    black: v('--bg-void', '#020202'),
    red: v('--red', '#ef4444'),
    green: v('--green', '#34d399'),
    yellow: v('--amber', '#f5a623'),
    blue: v('--blue', '#60a5fa'),
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: v('--text-dim', '#8c8c8c'),
    brightBlack: v('--text-faint', 'rgba(255,255,255,0.32)'),
    brightWhite: v('--text', '#eeeeee'),
  };
}

/** Builds (or reuses) the cached terminal for a project and wires its input. */
function ensureTerminal(projectId: string): CachedTerminal {
  const existing = terminals.get(projectId);
  if (existing) return existing;
  const fontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-mono')
    .trim();
  const term = new Terminal({
    fontFamily: fontFamily || 'ui-monospace, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    theme: themeFromCss(),
    scrollback: 10_000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // Input flows renderer → main PTY; output arrives on the smith-data broadcast.
  term.onData((data) => void api.smith.write(projectId, data));
  const cached: CachedTerminal = { term, fit, painted: false };
  terminals.set(projectId, cached);
  return cached;
}

const BLOCKED_TITLE: Record<SmithBlockedReason, string> = {
  'no-project': 'No project selected',
  'invalid-path': 'Project path is unreachable',
  'droid-missing': 'droid is not installed',
};

export default function SmithModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { project } = useApp();
  const projectId = project?.id ?? '';
  const mountRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [status, setStatus] = useState<SmithStatus | null>(null);

  // Resize the PTY to the terminal's measured grid, then tell main.
  const syncSize = useCallback(
    (cached: CachedTerminal): void => {
      try {
        cached.fit.fit();
      } catch {
        // A zero-sized container (mid-transition) throws; the next tick retries.
        return;
      }
      const { cols, rows } = cached.term;
      if (cols > 0 && rows > 0) void api.smith.resize(projectId, cols, rows);
    },
    [projectId],
  );

  useEffect(() => {
    if (!projectId) {
      setStatus({ projectId: '', state: 'blocked', blocked: 'no-project' });
      return;
    }
    let cancelled = false;

    void api.smith.open(projectId).then((next) => {
      if (cancelled) return;
      setStatus(next);
      if (next.state === 'blocked') return;

      const cached = ensureTerminal(projectId);
      const mount = mountRef.current;
      if (mount && cached.term.element?.parentElement !== mount) {
        mount.replaceChildren();
        cached.term.open(mount);
      }
      // Repaint scrollback from the ring buffer exactly once per cached terminal.
      if (!cached.painted) {
        void api.smith.buffer(projectId).then((buffer) => {
          if (cancelled) return;
          if (buffer) cached.term.write(buffer);
          cached.painted = true;
        });
      }
      // Two frames: one for layout, one after xterm has sized its rows.
      requestAnimationFrame(() => {
        if (cancelled) return;
        syncSize(cached);
        cached.term.focus();
      });
    });

    // Live output for this project's session.
    const off = api.on('smith-data', (data) => {
      const payload = data as { projectId: string; data: string } | undefined;
      if (!payload || payload.projectId !== projectId) return;
      terminals.get(projectId)?.term.write(payload.data);
    });
    // Status transitions keep the header dot honest while the modal is open.
    const offStatus = api.on('smith-status-changed', (data) => {
      const next = data as SmithStatus | undefined;
      if (next && next.projectId === projectId) setStatus(next);
    });

    return () => {
      cancelled = true;
      off();
      offStatus();
    };
  }, [projectId, syncSize]);

  // Keep the grid matched to the window while the modal is open.
  useEffect(() => {
    if (!projectId) return;
    const onResize = (): void => {
      const cached = terminals.get(projectId);
      if (cached) syncSize(cached);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [projectId, syncSize]);

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
      modalRef={dialogRef}
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
          <div className={styles.terminal} ref={mountRef} />
        </div>
      )}
    </ModalShell>
  );
}
