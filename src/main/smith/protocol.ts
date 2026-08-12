/**
 * The newline-delimited JSON protocol spoken over the Smith unix domain socket.
 *
 * Both the running app (`socket-server.ts`) and the standalone helper binary
 * (`src/cli/foundry-cli.ts`) import these shapes. The CLI must stay
 * dependency-free stdlib Node, so this module imports only the shared entity
 * types — no store, no electron, nothing that would drag the app into the
 * binary.
 */

import type { ValidationIssue } from '@shared/types.js';

/** One request line from the CLI to the app. */
export interface CliRequest {
  op: 'list' | 'show' | 'create' | 'edit';
  /**
   * What the request is about. `project` is **read-only and list-only**: Smith
   * runs in the user's own terminal, so it has to discover the app's projects
   * to scope itself, but it may never write one. Every other op on `project`
   * comes back as an error.
   */
  kind: 'agent' | 'pipeline' | 'envelope' | 'project';
  /** Required for `show`/`edit`; ignored for `list`/`create`. */
  name?: string;
  /** The entity JSON for `create`/`edit`. */
  spec?: unknown;
  /**
   * The project whose scope the request resolves against. The CLI reads it from
   * `--project <id>` or `$FOUNDRY_SMITH_PROJECT`; absent means global scope.
   */
  projectId?: string;
}

/**
 * The only shape of a project the CLI ever sees: enough to scope a session and
 * name it to a human, and nothing else. `ProjectDef` carries commands, merge
 * policy, protected paths and setup scripts — none of which Smith may read.
 */
export interface CliProject {
  id: string;
  name: string;
  path: string;
}

/** One response line from the app to the CLI. */
export type CliResponse =
  /** `list`/`show` answered from the store. */
  | { ok: true; kind: string; entities?: unknown[]; entity?: unknown }
  /** `create`/`edit` approved and saved. */
  | { ok: true; entity: unknown }
  /** Validation failed before any card was raised. */
  | { ok: false; validation: ValidationIssue[] }
  /** The human rejected the proposal; `note` is their revision guidance. */
  | { ok: false; rejected: true; note?: string }
  /** A protocol or state error (unknown op, concurrent proposal, missing name). */
  | { ok: false; error: string };

/** Splits a growing socket buffer into complete JSON lines, keeping the tail. */
export function drainLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((l) => l.length > 0), rest };
}

/** Encodes a message as one protocol line. */
export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
