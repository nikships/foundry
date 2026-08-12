/**
 * Resolving what a user needs to start a Smith session in their own terminal.
 *
 * The app cannot start the agent for them any more — that is the point of the
 * skill — but it does know three things they cannot guess: where the helper
 * binary ended up, where the skill shipped, and which socket to talk to. This
 * module resolves those and formats the shell line that wires them together.
 *
 * The string builders are pure so the quoting is testable; only the path
 * resolvers touch `import.meta.url`.
 */

import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Both resolvers below hang off the running main bundle's own location. Every
 * main-process module bundles into `out/main/main.js`, so `import.meta.url` is
 * that file regardless of which source file this code lives in.
 *
 * A packaged main.js runs from inside `app.asar`, which is a single opaque file:
 * paths into it are not real files on disk. Both the helper CLI and the skill are
 * read from *outside* the app — by `node`, and by the user's agent — so both are
 * `asarUnpack`ed in `electron-builder.yml`, and the path segment is rewritten
 * here to match. A no-op in dev, where there is no asar.
 */
export function resolveFromMainDir(mainDir: string, ...segments: string[]): string {
  const raw = join(mainDir, ...segments);
  return raw.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

/** Where the running main bundle sits: `out/main/`, packaged or not. */
function mainDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** The helper binary, built alongside main as `out/main/foundry-cli.js`. */
export function foundryCliPath(): string {
  return resolveFromMainDir(mainDir(), 'foundry-cli.js');
}

/**
 * The skill directory shipped inside the app bundle. `out/main/` → repo root in
 * dev, and → the packaged app root when packaged: two levels up either way.
 */
export function smithSkillDir(): string {
  return resolveFromMainDir(mainDir(), '..', '..', 'skills', 'foundry-smith');
}

/**
 * Single-quotes a value for `sh`. A literal single quote has to close the quoted
 * run, escape itself, and reopen it — the only correct way to do this, and the
 * reason this is a function rather than a template literal at the call site.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shell block the launcher offers for copying. It defines the `foundry-cli`
 * command the skill's examples assume, and exports the project scope so the agent
 * need not pass `--project` on every call.
 *
 * A function rather than an alias: it takes arguments naturally, works in
 * non-interactive shells, and — unlike an alias — needs no nested quoting, so
 * what the user pastes is legible. `node <path>` rather than executing the file
 * directly is what makes the asar exec-bit question moot.
 */
export function smithBootstrap(input: { cliPath: string; projectId?: string }): string {
  const lines = [`foundry-cli() { node ${shellQuote(input.cliPath)} "$@"; }`];
  if (input.projectId) {
    lines.push(`export FOUNDRY_SMITH_PROJECT=${shellQuote(input.projectId)}`);
  }
  return lines.join('\n');
}
