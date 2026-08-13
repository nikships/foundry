/**
 * Resolving what a user needs to start a Smith session in their own terminal.
 *
 * The app does not own the agent — that is the point of the skill — but it knows
 * three things the user cannot guess: where the helper binary ended up, where the
 * skill shipped, and which socket to talk to. This module resolves those and
 * formats the shell that wires them together, for both handoffs: the bootstrap
 * line a user pastes, and the session script a prepared terminal is handed.
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

/**
 * The `foundry-cli` shim written into the session directory.
 *
 * The bootstrap's shell *function* is the right shape for a human pasting into
 * their own shell, and the wrong shape here: the agent runs each command in a
 * shell it spawns itself, which inherits the environment but not a function
 * defined in the shell that launched it. An executable on PATH is inherited by
 * every descendant, which is exactly the reach the agent needs.
 */
export function smithShimScript(cliPath: string): string {
  return `#!/bin/sh\nexec node ${shellQuote(cliPath)} "$@"\n`;
}

/**
 * The opening instruction the agent is started with.
 *
 * It names the skill by absolute path rather than by name because the user's
 * agent may not have it installed — reading the copy that shipped inside the app
 * is the one route that always exists. Scope is stated as already-settled, since
 * the launcher exported it; without that the skill's own rule ("confirm scope
 * before your first write") sends the agent asking a question the app already
 * answered.
 */
export function smithPrompt(input: { skillDir: string; projectName?: string }): string {
  const scope = input.projectName
    ? `You are scoped to the "${input.projectName}" project; FOUNDRY_SMITH_PROJECT is already exported, so do not ask which project to use.`
    : `No project is selected, so you are in global scope.`;
  return [
    `Read ${join(input.skillDir, 'SKILL.md')} and take on the Smith persona it describes.`,
    `Foundry is running and foundry-cli is already on your PATH. ${scope}`,
    `Then run agent list, pipeline list, and envelope list so you know what exists,`,
    `give me a one-line summary of what you found, and wait for what I need.`,
  ].join(' ');
}

/**
 * The script the prepared terminal runs: put the shim on PATH, pin the scope and
 * socket, then hand the window to the agent.
 *
 * The trailing `exec <shell> -i` is not decoration. Without it the window closes
 * the instant the agent exits, so an agent that fails to start takes its own
 * error message with it; with it, the user is left in a shell in the right
 * directory with the scope still exported.
 */
export function smithSessionScript(input: {
  binDir: string;
  projectPath: string;
  socketPath: string;
  agentPath: string;
  prompt: string;
  shell: string;
  projectId?: string;
}): string {
  const lines = [
    `export PATH=${shellQuote(input.binDir)}:"$PATH"`,
    `export FOUNDRY_SMITH_SOCKET=${shellQuote(input.socketPath)}`,
  ];
  if (input.projectId) {
    lines.push(`export FOUNDRY_SMITH_PROJECT=${shellQuote(input.projectId)}`);
  }
  lines.push(
    `cd ${shellQuote(input.projectPath)} || exit 1`,
    `${shellQuote(input.agentPath)} ${shellQuote(input.prompt)}`,
    `exec ${shellQuote(input.shell)} -i`,
  );
  return lines.join('\n');
}
