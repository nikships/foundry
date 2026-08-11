/**
 * The terminal engine seam.
 *
 * A Smith session drives a real terminal; who owns the PTY and how frames reach
 * the renderer is the part that changes between engines. This file defines the
 * abstraction and ships the fallback engine (spec §5): xterm.js in the renderer
 * over a node-pty PTY owned here in main.
 *
 * The Ghostty engine (a later PR) implements the same `TerminalEngine` interface
 * backed by a headless Ghostty in a `utilityProcess`, importing frames zero-copy
 * into a sandboxed canvas. Because the registry only ever talks to this
 * interface — spawn, write, resize, onData, onExit, kill — it can swap engines
 * without the registry, IPC, or renderer changing shape. The PTY engine streams
 * bytes over `onData`; the Ghostty engine would stream frame handles the same
 * way, and the renderer picks its view accordingly.
 */

import { spawn as spawnPty, type IPty } from 'node-pty';

/** What the session registry drives, independent of the underlying terminal. */
export interface TerminalEngine {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Terminal output bytes (PTY engine) — the renderer feeds these to xterm. */
  onData(handler: (data: string) => void): void;
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): void;
  kill(): void;
}

export interface SpawnEngineOptions {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}

/** Sensible starting grid; the renderer resizes to its real measurement on open. */
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/** The fallback engine: a node-pty PTY whose bytes stream to the renderer. */
export function spawnPtyEngine(opts: SpawnEngineOptions): TerminalEngine {
  const pty: IPty = spawnPty(opts.file, opts.args, {
    name: 'xterm-color',
    cols: opts.cols ?? DEFAULT_COLS,
    rows: opts.rows ?? DEFAULT_ROWS,
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
  });

  return {
    write: (data) => pty.write(data),
    resize: (cols, rows) => {
      // A degenerate grid (0 columns) throws inside node-pty on some platforms.
      if (cols > 0 && rows > 0) pty.resize(cols, rows);
    },
    onData: (handler) => {
      pty.onData(handler);
    },
    onExit: (handler) => {
      pty.onExit(({ exitCode, signal }) => handler({ exitCode, signal }));
    },
    kill: () => {
      try {
        pty.kill();
      } catch {
        // Already dead; nothing to do.
      }
    },
  };
}
