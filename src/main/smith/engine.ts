/**
 * The Smith terminal engine: headless Ghostty embedded via the vendored
 * prebuilt `vendor/electron-ghostty` package (spec §5). Ghostty owns
 * EVERYTHING — the PTY and the droid process, VT parsing, key/mouse encoding,
 * selection, fonts (Symbols Nerd Font is statically embedded in the addon for
 * glyph fallback), and Metal rendering. Frames reach the renderer's sandboxed
 * canvas zero-copy through Electron's `sharedTexture`; input flows back over
 * the package's own `electron-ghostty:*` IPC, wired in `preload/ghostty.ts`.
 *
 * There is deliberately NO fallback engine. If the addon cannot load (wrong
 * platform, missing binary) Smith reports a `blocked: 'engine-missing'`
 * status and the modal shows guidance — Foundry is a macOS app and the engine
 * ships in the repo.
 *
 * Engine placement is `utility` ONLY: the whole ghostty engine runs in an
 * Electron utilityProcess and each presented IOSurface crosses as a mach
 * send-right. Never use `engine: 'main'` — the current ghostty pin has a known
 * IOSurface size-mismatch bug in main-process mode (ghostty-electron CI).
 *
 * Config isolation (spec §5): the vendored addon builds its ghostty config
 * from `ghostty_config_new()` plus ONLY the config string passed here — it
 * never calls `ghostty_config_load_default_files`, so the user's own
 * `~/.config/ghostty` (or `$XDG_CONFIG_HOME`) is structurally unreadable, and
 * nothing is ever written there. Verified against the addon source
 * (nikships/ghostty-electron `src/addon.c`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { WebContents } from 'electron';
import { app } from 'electron';
import type { SmithTheme } from '@shared/types.js';
import { ghosttyCommand, ghosttyConfig, RESUME_FAILURE_WINDOW_MS } from './engine-config.js';

/** What the session registry drives, independent of the terminal internals. */
export interface TerminalEngine {
  /** Cooked text into the terminal (typing-equivalent; ghostty encodes it). */
  text(data: string): void;
  /** Ghostty presented a frame — the closest thing to "output happened". */
  onActivity(handler: () => void): void;
  onExit(handler: (event: { exitCode: number }) => void): void;
  /** Force a fresh frame so a remounted canvas repaints from live state. */
  redraw(): void;
  kill(): void;
}

export interface GhosttySpawnOptions {
  /** Absolute path to the droid binary. */
  file: string;
  args: string[];
  cwd: string;
  /**
   * Env vars the spawned droid needs (`FOUNDRY_SMITH_SOCKET`, `FOUNDRY_CLI`,
   * …). The engine runs in a utilityProcess whose environment is fixed at
   * fork, so per-session vars travel as assignments in the command line.
   */
  extraEnv: Record<string, string>;
  /** The renderer window whose canvas this terminal paints into. */
  webContents: WebContents;
  /** The canvas's `data-ghostty` attribute value; one terminal per slot. */
  slot: string;
  theme?: SmithTheme;
}

/* ── vendored package loading ───────────────────────────────────────────── */

interface GhosttyTerminalLike {
  attach(webContents: WebContents, opts?: { slot?: string }): GhosttyTerminalLike;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  text(data: string): void;
  draw(): void;
  destroy(): void;
}

interface ElectronGhosttyModule {
  GhosttyTerminal: new (opts: Record<string, unknown>) => GhosttyTerminalLike;
  available(): boolean;
}

const requireCjs = createRequire(import.meta.url);
let cached: ElectronGhosttyModule | null | undefined;

/**
 * Dev runs from the repo (`<appRoot>/vendor/electron-ghostty`); a packaged app
 * ships the same directory asar-unpacked (electron-builder `asarUnpack`), so
 * the native addon and the utilityProcess host stay real files on disk.
 */
export function ghosttyVendorDir(): string {
  const inApp = join(app.getAppPath(), 'vendor', 'electron-ghostty');
  return inApp.replace(join('app.asar', 'vendor'), join('app.asar.unpacked', 'vendor'));
}

function loadGhostty(): ElectronGhosttyModule | null {
  if (cached !== undefined) return cached;
  try {
    const dir = ghosttyVendorDir();
    if (!existsSync(join(dir, 'index.js'))) {
      cached = null;
      return cached;
    }
    const mod = requireCjs(join(dir, 'index.js')) as ElectronGhosttyModule;
    cached = mod.available() ? mod : null;
  } catch {
    cached = null;
  }
  return cached;
}

/** True when the vendored addon can actually run here (darwin + binary). */
export function ghosttyAvailable(): boolean {
  return loadGhostty() !== null;
}

/* ── the engine ─────────────────────────────────────────────────────────── */

/**
 * Spawns droid inside a headless Ghostty and returns the registry-facing
 * engine. Throws when the vendored addon is unavailable — the registry maps
 * that to a `blocked: 'engine-missing'` status before ever calling this.
 */
export function spawnGhosttyEngine(opts: GhosttySpawnOptions): TerminalEngine {
  const mod = loadGhostty();
  if (!mod) throw new Error('smith: electron-ghostty addon unavailable');

  const term = new mod.GhosttyTerminal({
    // utility ONLY — main-process mode has a known IOSurface size bug at the
    // current ghostty pin (see module doc).
    engine: 'utility',
    scale: opts.theme?.scale ?? 2,
    fontSize: opts.theme?.fontSize ?? 13,
    command: ghosttyCommand(opts.file, opts.args, opts.extraEnv),
    cwd: opts.cwd,
    config: ghosttyConfig(opts.theme),
  });
  term.attach(opts.webContents, { slot: opts.slot });

  const spawnedAt = Date.now();
  let exited = false;

  return {
    text: (data) => {
      if (!exited) term.text(data);
    },
    onActivity: (handler) => {
      term.on('frame', handler);
    },
    onExit: (handler) => {
      term.on('exit', () => {
        if (exited) return;
        exited = true;
        const fastDeath = Date.now() - spawnedAt < RESUME_FAILURE_WINDOW_MS;
        handler({ exitCode: fastDeath ? 1 : 0 });
      });
    },
    redraw: () => {
      if (!exited) term.draw();
    },
    kill: () => {
      exited = true;
      try {
        term.destroy();
      } catch {
        // Already dead; nothing to do.
      }
    },
  };
}
