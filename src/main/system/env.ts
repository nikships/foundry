/**
 * The environment every child process gets.
 *
 * A macOS app launched from Finder or the Dock inherits launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one a terminal would have. Nothing
 * a developer installs lives there: node, npm, pnpm, yarn, bun, cargo, go, uv,
 * gradle and swiftlint are all invisible, so a detected `npm test` fails with
 * "No such file or directory" and reads as a wrong command rather than a
 * missing PATH. Every agent CLI has the same problem.
 *
 * The login shell is asked once, at startup, because it is the only thing that
 * knows what the user's profile actually sets. The answer is cached for the
 * life of the process: a shell that sources nvm can take hundreds of
 * milliseconds, and no spawn should pay that.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Marker around the shell's answer. A login shell prints motd, version banners
 * and whatever the user's rc files echo, so the PATH is fenced rather than
 * assumed to be the whole of stdout.
 */
const BEGIN = '__FOUNDRY_PATH_BEGIN__';
const END = '__FOUNDRY_PATH_END__';

/** A profile that never returns would hang startup; the fallback is fine. */
const SHELL_TIMEOUT_MS = 5_000;

/**
 * Where developer tooling actually installs on macOS. Used to repair a PATH the
 * login shell could not supply, and never to replace one it did.
 */
function commonBinDirs(): string[] {
  const home = homedir();
  return [
    join(home, '.npm-global/bin'),
    join(home, '.local/bin'),
    join(home, '.cargo/bin'),
    join(home, '.bun/bin'),
    join(home, 'go/bin'),
    join(home, '.volta/bin'),
    join(home, '.asdf/shims'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
  ];
}

/** Order-preserving dedupe, so the shell's own precedence is never reshuffled. */
function mergePath(primary: string, extras: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of [...primary.split(':'), ...extras]) {
    const trimmed = dir.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.join(':');
}

export interface ResolvedEnv {
  path: string;
  /** How the answer was obtained, reported by the doctor rather than guessed at. */
  via: 'login-shell' | 'fallback';
  /** Present only when the login shell could not be asked. */
  detail?: string;
}

let resolved: ResolvedEnv | null = null;

/**
 * Extra variables merged into every child env after PATH and before caller
 * overrides, so a credential can reach a child without mutating `process.env`.
 */
let spawnExtra: Record<string, string> = {};

/** Replace the extra env overlay. Pass `{}` to clear. */
export function setSpawnEnvExtra(vars: Record<string, string>): void {
  spawnExtra = { ...vars };
}

/**
 * `-i` (interactive) matters as much as `-l`: many people put their PATH in
 * `.zshrc`, which a non-interactive login shell never reads. stdin is closed so
 * a profile that prompts cannot block startup.
 */
async function askLoginShell(): Promise<string | null> {
  const shell = process.env.SHELL;
  if (!shell || !existsSync(shell)) return null;
  try {
    const { stdout } = await exec(shell, ['-ilc', `printf '%s%s%s' '${BEGIN}' "$PATH" '${END}'`], {
      timeout: SHELL_TIMEOUT_MS,
      encoding: 'utf8',
      // A profile that prints a lot must not be able to overflow the buffer and
      // take the resolution down with it.
      maxBuffer: 4 * 1024 * 1024,
    });
    const start = stdout.indexOf(BEGIN);
    const end = stdout.indexOf(END);
    if (start < 0 || end <= start) return null;
    const path = stdout.slice(start + BEGIN.length, end).trim();
    return path || null;
  } catch {
    // A shell that fails, times out, or does not accept -ilc is not fatal.
    return null;
  }
}

/**
 * Resolves the PATH once. Safe to call repeatedly; only the first call spawns a
 * shell. Must be awaited during startup, before anything spawns a child.
 */
export async function resolveEnv(): Promise<ResolvedEnv> {
  if (resolved) return resolved;

  const fromShell = await askLoginShell();
  const inherited = process.env.PATH ?? '';
  const missing = commonBinDirs().filter((dir) => existsSync(dir));

  if (fromShell) {
    // The shell is authoritative, but a GUI launch can still miss a directory
    // the user installed after their last profile edit, so known-good dirs are
    // appended rather than prepended: they never outrank the user's own order.
    resolved = { path: mergePath(fromShell, missing), via: 'login-shell' };
  } else {
    resolved = {
      path: mergePath(inherited, missing),
      via: 'fallback',
      detail: process.env.SHELL
        ? `${process.env.SHELL} did not answer; using the inherited PATH plus known install dirs`
        : 'no SHELL in the environment; using the inherited PATH plus known install dirs',
    };
  }
  return resolved;
}

/**
 * The resolved PATH, or the inherited one when `resolveEnv` has not finished.
 * Never throws: a spawn during startup gets today's behaviour rather than an
 * error.
 */
export function resolvedEnv(): ResolvedEnv {
  return resolved ?? { path: process.env.PATH ?? '', via: 'fallback', detail: 'not resolved yet' };
}

/**
 * The env every child process should be spawned with. Callers merge their own
 * overrides on top; PATH is the only variable this replaces.
 */
export function spawnEnv(
  overrides?: Record<string, string | undefined>,
): NodeJS.ProcessEnv & Record<string, string | undefined> {
  return { ...process.env, PATH: resolvedEnv().path, ...spawnExtra, ...overrides };
}

/**
 * The absolute path of a binary on the resolved PATH, or null.
 *
 * The resolved PATH is the point: a GUI launch inherits launchd's, where none
 * of a developer's tooling lives, so a plain `which` would report a binary the
 * user definitely has as missing.
 */
export function whichBinary(binary: string): string | null {
  try {
    const found = execFileSync('/usr/bin/which', [binary], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: spawnEnv(),
    }).trim();
    return found || null;
  } catch {
    return null;
  }
}

/** Test seam: lets a test pin a PATH without spawning the user's shell. */
export function __setResolvedEnvForTest(value: ResolvedEnv | null): void {
  resolved = value;
}
