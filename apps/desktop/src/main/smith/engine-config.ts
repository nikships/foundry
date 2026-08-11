/**
 * Pure builders for the Ghostty engine: the config string and the droid
 * command line. No electron imports, so tests exercise the exact strings the
 * engine hands to ghostty without an Electron runtime.
 */

import type { SmithTheme } from '@shared/types.js';

/**
 * A `--resume` against an expired/garbage-collected session id dies within a
 * couple of seconds; a real session that later ends (user types `exit`, droid
 * crashes mid-work) lives far longer. Ghostty reports no exit code across the
 * utilityProcess boundary, so "did the resume fail?" is inferred from how fast
 * the process died. Deaths inside this window report exitCode 1 (the registry
 * retries fresh once); later deaths report 0.
 */
export const RESUME_FAILURE_WINDOW_MS = 15_000;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** themeFromCss() names (renderer) -> ghostty config keys. */
const THEME_KEYS: Record<string, string> = {
  background: 'background',
  foreground: 'foreground',
  cursor: 'cursor-color',
  selectionBackground: 'selection-background',
};

/** themeFromCss() names (renderer) -> ANSI palette indexes. */
const PALETTE_INDEX: Record<string, number> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  brightBlack: 8,
  brightWhite: 15,
};

/**
 * Builds the ghostty config string for a Smith session. Only `#rrggbb` values
 * survive — CSS `rgba(...)` values (some Foundry variables) fall back to
 * ghostty defaults rather than risking a config parse error. Cursor blink is
 * off so presented frames mean real output, which is what drives the
 * busy/idle activity dot. Glyphs need no font setup: the vendored addon
 * statically embeds Symbols Nerd Font as a fallback.
 */
export function ghosttyConfig(theme?: SmithTheme): string {
  const lines: string[] = [
    'cursor-style-blink = false',
    'scrollback-limit = 10000000',
    // droid is not a shell; injecting shell integration into it is noise.
    'shell-integration = none',
  ];
  for (const [name, value] of Object.entries(theme?.colors ?? {})) {
    if (!HEX_COLOR.test(value)) continue;
    const key = THEME_KEYS[name];
    if (key) lines.push(`${key} = ${value}`);
    const index = PALETTE_INDEX[name];
    if (index !== undefined) lines.push(`palette = ${index}=${value}`);
  }
  return lines.join('\n');
}

/**
 * The droid invocation as a ghostty `command`. Ghostty runs the command
 * through a shell, and the vendored package's proven pattern for compound
 * commands is an explicit `/bin/sh -c '…'` (see its demo + e2e). Env
 * assignments prefix the exec because the engine's utilityProcess env is
 * fixed at fork — this is the only road per-session vars have into droid.
 * Values are double-quoted inside the single-quoted payload; a literal `'`
 * anywhere would break the outer quoting, so it is rejected loudly.
 */
export function ghosttyCommand(
  file: string,
  args: string[],
  extraEnv: Record<string, string>,
): string {
  const dq = (value: string): string => {
    if (value.includes("'")) {
      throw new Error(`smith: cannot quote value containing a single quote: ${value}`);
    }
    return `"${value.replace(/([\\"$`])/g, '\\$1')}"`;
  };
  const assignments = Object.entries(extraEnv)
    .map(([key, value]) => `${key}=${dq(value)}`)
    .join(' ');
  const argv = [file, ...args].map(dq).join(' ');
  return `/bin/sh -c '${assignments ? `${assignments} ` : ''}exec ${argv}'`;
}
