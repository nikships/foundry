/**
 * Handing work to the user's terminal emulator.
 *
 * Foundry does not embed a terminal — Smith runs in the user's own — so the app's
 * job is to open one, in the right place. There are two ways to do that and the
 * split is deliberate:
 *
 * - `openDirectoryInTerminal` is the universal handoff: `open -a <App> <dir>`,
 *   and nothing more. The user pastes the bootstrap line themselves.
 * - `runCommandInTerminal` starts the session outright, and is offered only for
 *   emulators that take a command on their own command line. Today that is
 *   Ghostty, whose `open -na Ghostty.app --args -e <command>` is documented in
 *   its own `--help`. The alternative for Terminal/iTerm is AppleScript that
 *   types into a window, which is silently breakable by a vendor update and by
 *   the Automation permission prompt; the others have no macOS-side equivalent
 *   at all. Those keep the copyable line, which cannot break.
 *
 * Either way the app does not own the process, the PTY, or the session: `open`
 * exits immediately and nothing is tracked in `procs.ts`.
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

/** Resolve an explicit override, otherwise prefer a command-capable installed terminal. */
export function preferredTerminal(id: TerminalAppId | null): TerminalAppInfo {
  if (id) return terminalFor(id);
  return (
    TERMINAL_APPS.find((terminal) => terminal.prepared && terminalInstalled(terminal.appName)) ??
    TERMINAL_APPS.find((terminal) => terminalInstalled(terminal.appName)) ??
    TERMINAL_APPS[0]!
  );
}

/**
 * Whether the emulator is actually installed, so the picker can say so before a
 * click fails.
 *
 * `Utilities` is not decoration: Terminal.app is the one emulator guaranteed to
 * exist, and on current macOS it lives *only* in `/System/Applications/Utilities`
 * — so omitting that directory reports the default terminal as missing.
 */
export function terminalInstalled(appName: string): boolean {
  const roots = [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    join(homedir(), 'Applications'),
  ];
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

/**
 * The argv that opens `appName` at `directoryPath` running `command`.
 *
 * Split out from the spawn so the flag order is assertable without opening a
 * window. `-n` is what forces a *new* instance to read `--args` — without it a
 * running Ghostty ignores them and the user gets an ordinary window with no
 * session in it. `-e` must come last: Ghostty treats the rest of the line as the
 * command, so any flag after it is swallowed as an argument.
 */
export function preparedTerminalArgv(input: {
  appName: string;
  directoryPath: string;
  command: string[];
}): string[] {
  return [
    '-na',
    `${input.appName}.app`,
    '--args',
    `--working-directory=${input.directoryPath}`,
    '-e',
    ...input.command,
  ];
}

/**
 * Opens `appName` at `directoryPath` and runs `command` in it.
 *
 * Only for emulators flagged `prepared` in `TERMINAL_APPS`; callers check that
 * before choosing this over `openDirectoryInTerminal`. `command` is an argv
 * array handed to `execFile`, so nothing here is shell-interpreted by `open`
 * itself — the terminal is what starts a shell, with the argument as written.
 */
export function runCommandInTerminal(input: {
  appName: string;
  directoryPath: string;
  command: string[];
}): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!input.directoryPath) return reject(new Error('No directory to open'));
    if (!existsSync(input.directoryPath)) {
      return reject(new Error(`Directory does not exist: ${input.directoryPath}`));
    }
    if (input.command.length === 0) return reject(new Error('No command to run'));
    execFile(OPEN, preparedTerminalArgv(input), (error) => {
      if (error) {
        reject(new Error(error.message.trim() || `Could not open ${input.appName}`));
      } else {
        resolve();
      }
    });
  });
}
