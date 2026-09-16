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
 * Forge token env vars (`GH_TOKEN`, `GITLAB_TOKEN`, …) have the same gap: a
 * Dock-launched Electron process never sees values set only in `~/.zshrc`, so
 * create-project and PR flows look signed-out even when the operator's shell
 * profile already exports a token the CLI would honor.
 *
 * The login shell is asked once, at startup, because it is the only thing that
 * knows what the user's profile actually sets. The answer is cached for the
 * life of the process: a shell that sources nvm can take hundreds of
 * milliseconds, and no spawn should pay that.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FORGE_TOKEN_ENV_VARS } from './scm-token-vars.js';

const exec = promisify(execFile);

/**
 * Marker around the shell's answer. A login shell prints motd, version banners
 * and whatever the user's rc files echo, so PATH and token values are fenced
 * rather than assumed to be the whole of stdout.
 */
const PATH_BEGIN = '__FOUNDRY_PATH_BEGIN__';
const PATH_END = '__FOUNDRY_PATH_END__';
const ENV_BEGIN = '__FOUNDRY_ENV_BEGIN__';
const ENV_END = '__FOUNDRY_ENV_END__';

/** A profile that never returns would hang startup; the fallback is fine. */
const SHELL_TIMEOUT_MS = 5_000;

/** Relative to `$HOME`; the rest of the common install dirs are absolute. */
const HOME_BIN_DIRS = [
  '.npm-global/bin',
  '.local/bin',
  '.local/share/mise/shims',
  '.local/share/pnpm',
  '.cargo/bin',
  '.bun/bin',
  'go/bin',
  '.volta/bin',
  '.asdf/shims',
  '.nodenv/shims',
  '.pyenv/shims',
  '.rbenv/shims',
  'Library/pnpm',
];

const SYSTEM_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
];

/**
 * Where developer tooling actually installs on macOS. Used to repair a PATH the
 * login shell could not supply, and never to replace one it did.
 */
function commonBinDirs(): string[] {
  const home = homedir();
  return [...HOME_BIN_DIRS.map((dir) => join(home, dir)), ...SYSTEM_BIN_DIRS];
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
  /** Token env var names imported from the login shell (never overwriting existing). */
  importedTokenVars?: string[];
}

let resolved: ResolvedEnv | null = null;

interface LoginShellAnswer {
  path: string | null;
  /** Non-empty forge token values from the login shell, keyed by env var name. */
  tokens: Record<string, string>;
}

/**
 * `-i` (interactive) matters as much as `-l`: many people put their PATH in
 * `.zshrc`, which a non-interactive login shell never reads. stdin is closed so
 * a profile that prompts cannot block startup.
 */
function loginShell(): string | null {
  const candidates = [process.env.SHELL, userInfo().shell];
  return (
    candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate)) ??
    null
  );
}

/**
 * One login-shell ask for PATH plus selected forge token env vars. Each value
 * is fenced so motd / rc echo cannot corrupt parsing.
 */
function loginShellScript(): string {
  const tokenPrints = FORGE_TOKEN_ENV_VARS.map(
    (name) => `printf '%s%s=%s%s' '${ENV_BEGIN}' '${name}' "\${${name}-}" '${ENV_END}'`,
  ).join('; ');
  return `printf '%s%s%s' '${PATH_BEGIN}' "$PATH" '${PATH_END}'; ${tokenPrints}`;
}

function parseLoginShellStdout(stdout: string): LoginShellAnswer {
  const pathStart = stdout.indexOf(PATH_BEGIN);
  const pathEnd = stdout.indexOf(PATH_END);
  const path =
    pathStart >= 0 && pathEnd > pathStart
      ? stdout.slice(pathStart + PATH_BEGIN.length, pathEnd).trim() || null
      : null;

  const tokens: Record<string, string> = {};
  let cursor = 0;
  while (cursor < stdout.length) {
    const start = stdout.indexOf(ENV_BEGIN, cursor);
    if (start < 0) break;
    const end = stdout.indexOf(ENV_END, start + ENV_BEGIN.length);
    if (end < 0) break;
    const payload = stdout.slice(start + ENV_BEGIN.length, end);
    const eq = payload.indexOf('=');
    if (eq > 0) {
      const name = payload.slice(0, eq);
      const value = payload.slice(eq + 1);
      if (
        (FORGE_TOKEN_ENV_VARS as readonly string[]).includes(name) &&
        typeof value === 'string' &&
        value.trim()
      ) {
        tokens[name] = value;
      }
    }
    cursor = end + ENV_END.length;
  }
  return { path, tokens };
}

async function askLoginShell(): Promise<LoginShellAnswer> {
  const shell = loginShell();
  if (!shell || !existsSync(shell)) return { path: null, tokens: {} };
  try {
    const { stdout } = await exec(shell, ['-ilc', loginShellScript()], {
      timeout: SHELL_TIMEOUT_MS,
      encoding: 'utf8',
      // A profile that prints a lot must not be able to overflow the buffer and
      // take the resolution down with it.
      maxBuffer: 4 * 1024 * 1024,
    });
    return parseLoginShellStdout(stdout);
  } catch {
    // A shell that fails, times out, or does not accept -ilc is not fatal.
    return { path: null, tokens: {} };
  }
}

/**
 * Install non-empty forge token env vars from the login shell into this
 * process. Never overwrites a value already present in `process.env` (Dock
 * launchers, CI, and explicit shell exports win).
 */
export function importForgeTokensFromShell(
  tokens: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const imported: string[] = [];
  for (const name of FORGE_TOKEN_ENV_VARS) {
    const incoming = tokens[name];
    if (typeof incoming !== 'string' || !incoming.trim()) continue;
    const existing = env[name];
    if (typeof existing === 'string' && existing.trim()) continue;
    env[name] = incoming;
    imported.push(name);
  }
  return imported;
}

/**
 * Resolves the PATH once (and imports forge token env vars from the same login
 * shell). Safe to call repeatedly; only the first call spawns a shell. Must be
 * awaited during startup, before anything spawns a child.
 */
export async function resolveEnv(): Promise<ResolvedEnv> {
  if (resolved) return resolved;

  const fromShell = await askLoginShell();
  const importedTokenVars = importForgeTokensFromShell(fromShell.tokens);
  const installed = commonBinDirs().filter((dir) => existsSync(dir));

  // The shell is authoritative, but a GUI launch can still miss a directory the
  // user installed after their last profile edit, so known-good dirs are
  // appended rather than prepended: they never outrank the user's own order.
  resolved = fromShell.path
    ? {
        path: mergePath(fromShell.path, installed),
        via: 'login-shell',
        importedTokenVars: importedTokenVars.length ? importedTokenVars : undefined,
      }
    : {
        path: mergePath(process.env.PATH ?? '', installed),
        via: 'fallback',
        detail: `${process.env.SHELL ? `${process.env.SHELL} did not answer` : 'no SHELL in the environment'}; using the inherited PATH plus known install dirs`,
        importedTokenVars: importedTokenVars.length ? importedTokenVars : undefined,
      };
  // Pi is embedded in this Electron process. Its native bash tool builds the
  // child environment from process.env directly, rather than going through
  // spawnEnv(). Installing the resolved PATH here therefore gives in-process
  // agent shells the exact same machine tooling as engine-owned spawns.
  process.env.PATH = resolved.path;
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
 * Credentials exported into this process for in-process agent extensions.
 * They exist so pi extensions running here can read them; no child has any
 * business inheriting one, so `spawnEnv` strips them.
 */
const IN_PROCESS_SECRET_VARS = ['TAVILY_API_KEY'] as const;

/**
 * The env every child process should be spawned with. Callers merge their own
 * overrides on top; PATH is replaced with the resolved one, forge tokens
 * already live on `process.env` after `resolveEnv`, and in-process extension
 * credentials are the only ones removed.
 */
export function spawnEnv(
  overrides?: Record<string, string | undefined>,
): NodeJS.ProcessEnv & Record<string, string | undefined> {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: resolvedEnv().path };
  for (const name of IN_PROCESS_SECRET_VARS) delete env[name];
  return { ...env, ...overrides };
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
export function setResolvedEnvForTest(value: ResolvedEnv | null): void {
  resolved = value;
}

/** Test seam: parse fenced login-shell stdout without spawning. */
export function parseLoginShellStdoutForTest(stdout: string): LoginShellAnswer {
  return parseLoginShellStdout(stdout);
}
