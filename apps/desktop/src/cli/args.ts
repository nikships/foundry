/**
 * Pure argv and environment resolution for the helper binary.
 *
 * Split out of `foundry-cli.ts` so it can be unit tested: nothing here reads a
 * file, opens a socket, writes to stdout, or exits. Failures come back as data
 * and the binary turns them into an exit code. Stdlib + type-only imports only,
 * the same constraint the binary itself is under.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CliRequest } from '../main/smith/protocol.js';

export type Kind = CliRequest['kind'];

/** Every kind the CLI accepts. `project` is list-only (see `parseArgs`). */
export const KINDS: readonly Kind[] = ['agent', 'pipeline', 'envelope', 'project'];

/** Exit codes, kept next to the parser that produces them. */
export const EXIT = {
  ok: 0,
  /** Validation failure, rejection, or an error from the app. */
  failed: 1,
  /** Foundry is not running. */
  notRunning: 2,
  /** The command line itself was wrong. */
  usage: 3,
} as const;

/**
 * Where the app's socket lives when nothing overrides it: under the packaged
 * app's support dir (`userData/foundry` + `smith/foundry.sock`). The path is
 * hardcoded rather than discovered because the CLI must answer "is Foundry
 * running?" without the app's help — a dev instance launched with a custom
 * `--user-data-dir` needs `$FOUNDRY_SMITH_SOCKET` instead.
 */
export function defaultSocketPath(home: string = homedir()): string {
  return join(
    home,
    'Library',
    'Application Support',
    'foundry',
    'foundry',
    'smith',
    'foundry.sock',
  );
}

/** The socket to connect to: the env override, else the default path. */
export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.FOUNDRY_SMITH_SOCKET || defaultSocketPath();
}

/**
 * A parsed invocation. `specFile` is the `--file` path for a write, left unread
 * so this stays pure; the binary reads it and attaches `spec` to the request.
 */
export interface ParsedInvocation {
  request: CliRequest;
  specFile?: string;
}

export type ParseResult =
  ({ ok: true } & ParsedInvocation) | { ok: false; message: string; code: number };

function usage(message: string): ParseResult {
  return { ok: false, message, code: EXIT.usage };
}

/**
 * Pulls the global `--project <id>` (or `--project=<id>`) flag out of the args,
 * wherever it appears, and returns the remaining positional args.
 */
function extractProject(argv: string[]): { rest: string[]; projectId?: string; error?: string } {
  const rest: string[] = [];
  let projectId: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--project') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) return { rest, error: '--project needs a project id' };
      projectId = value;
      i++;
      continue;
    }
    if (arg.startsWith('--project=')) {
      const value = arg.slice('--project='.length);
      if (!value) return { rest, error: '--project needs a project id' };
      projectId = value;
      continue;
    }
    rest.push(arg);
  }

  return { rest, projectId };
}

/** Finds `--file <path>` in a write's trailing args. */
function specFileFrom(args: string[]): { path?: string; error?: string } {
  const at = args.indexOf('--file');
  const path = at < 0 ? undefined : args[at + 1];
  if (!path || path.startsWith('--')) return { error: 'create/edit needs --file <spec.json>' };
  return { path };
}

/**
 * Turns `foundry-cli <kind> <op> [...]` into a protocol request.
 *
 * Scope comes from `--project <id>` first, then `$FOUNDRY_SMITH_PROJECT`;
 * neither means global scope. `project` is read-only here as well as in the app,
 * so `project` with anything but `list` is a usage error rather than a round
 * trip that is guaranteed to fail.
 */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): ParseResult {
  const { rest: args, projectId: flagProject, error: flagError } = extractProject(argv);
  if (flagError) return usage(flagError);

  const [kind, op, ...rest] = args;
  if (!kind || !KINDS.includes(kind as Kind)) {
    return usage(`first argument must be one of ${KINDS.join(', ')}`);
  }

  const projectId = flagProject || env.FOUNDRY_SMITH_PROJECT || undefined;
  const base = { kind: kind as Kind, projectId };

  if (kind === 'project' && op !== 'list') {
    return usage('projects are read-only — the only project command is "project list"');
  }

  switch (op) {
    case 'list':
      return { ok: true, request: { op: 'list', ...base } };
    case 'show': {
      const name = rest[0];
      if (!name) return usage('show needs a name');
      return { ok: true, request: { op: 'show', name, ...base } };
    }
    case 'create': {
      const { path, error } = specFileFrom(rest);
      if (error) return usage(error);
      return { ok: true, request: { op: 'create', ...base }, specFile: path };
    }
    case 'edit': {
      const name = rest[0];
      if (!name || name.startsWith('--')) return usage('edit needs a name before --file');
      const { path, error } = specFileFrom(rest.slice(1));
      if (error) return usage(error);
      return { ok: true, request: { op: 'edit', name, ...base }, specFile: path };
    }
    default:
      return usage(`unknown command "${op ?? ''}" — use list, show, create, or edit`);
  }
}
