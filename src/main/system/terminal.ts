/**
 * Handing a directory to the user's terminal emulator.
 *
 * Foundry no longer embeds a terminal — Smith runs in the user's own — so the
 * app's job is to open one, in the right place, in the emulator they prefer.
 * That is `open -a <App> <dir>`, and nothing more: the app does not own the
 * process, the PTY, or the session.
 *
 * Deliberately not attempted: injecting a command into the new window. Doing
 * that means AppleScript for Terminal/iTerm and a different flag for every other
 * emulator, all of it silently breakable by an app update. The launcher hands the
 * user a copyable bootstrap line instead, which works in all six.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { TERMINAL_APPS, type TerminalAppId, type TerminalAppInfo } from '@shared/types.js';

/**
 * `open` lives in `/usr/bin`, which is present even in the minimal PATH a
 * packaged launch inherits from launchd — so this needs no `resolveEnv()`.
 */
const OPEN = '/usr/bin/open';

/** The chosen terminal, falling back to Terminal.app, which always exists. */
export function terminalFor(id: TerminalAppId): TerminalAppInfo {
  return TERMINAL_APPS.find((t) => t.id === id) ?? TERMINAL_APPS[0]!;
}

/**
 * Whether the emulator is actually installed, so the picker can say so before a
 * click fails. Checks the three places macOS puts applications.
 */
export function terminalInstalled(appName: string): boolean {
  const roots = ['/Applications', '/System/Applications', join(homedir(), 'Applications')];
  return roots.some((root) => existsSync(join(root, `${appName}.app`)));
}

/**
 * Opens `directoryPath` in the given terminal application.
 *
 * Rejects rather than throwing synchronously so the IPC layer can turn a missing
 * directory or an uninstalled emulator into a message on screen. `execFile` takes
 * its arguments as an array, so neither value is ever shell-interpreted.
 */
export function openDirectoryInTerminal(
  directoryPath: string,
  appName = 'Terminal',
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!directoryPath) return reject(new Error('No directory to open'));
    if (!existsSync(directoryPath)) {
      return reject(new Error(`Directory does not exist: ${directoryPath}`));
    }
    execFile(OPEN, ['-a', appName, directoryPath], (error) => {
      if (error) {
        // `open` says "Unable to find application named 'X'" for a missing app;
        // pass its own words through rather than guessing at the cause.
        reject(new Error(error.message.trim() || `Could not open ${appName}`));
      } else {
        resolve();
      }
    });
  });
}
