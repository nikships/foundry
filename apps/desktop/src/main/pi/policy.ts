/**
 * The zero-interrupt permission policy, in transport-neutral terms.
 *
 * Once a pipeline starts it settles without a human, so `evaluate()` always
 * returns a decision — there is no "ask someone" outcome to fall back on. That
 * is only safe because the real guard is post-hoc and code-owned: the write
 * boundary is enforced by diffing git after the call and reverting what was not
 * allowed, and protected paths fail the phase outright. Ruling on a call before
 * it runs is an early warning, not the enforcement.
 *
 * The boundary rules themselves live in `engine/boundary.ts` and are shared
 * with that post-hoc pass, so an in-turn allow and a post-hoc revert can never
 * disagree about what the boundary said.
 *
 * Denials are traced as an `interrupt` event with `auto: true` and the
 * reason, so observability replaces interruption. Allows are not: they pair
 * 1:1 with the tool_call already in the transcript.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { WriteBoundary } from '@shared/types.js';
import { isAllowed, isProtected } from '../engine/boundary.js';
import type { PermissionAsk, PermissionDecision } from './transport.js';

export interface PolicyContext {
  worktree: string;
  writes: WriteBoundary;
  protectedPaths: string[];
}

export interface PolicyOutcome {
  /** Never null: a started run never waits for a person. */
  decision: PermissionDecision;
  /** Why: recorded on the interrupt event whichever way it goes. */
  reason: string;
  /** The command, when this was a command-running call. */
  command?: string;
}

/**
 * What a tool does, as far as the policy cares. `unknown` is the fail-closed
 * bucket: a tool this build does not recognise is denied rather than waved
 * through, because the write boundary can only see inside the worktree and a
 * tool nobody classified could act outside it.
 */
export type ToolCategory = 'read' | 'write' | 'command' | 'foundry' | 'unknown';

/** Pi's read-only built-ins. None of them can change the worktree. */
const READ_TOOLS = new Set(['read', 'grep', 'find', 'ls']);
/** Pi's mutating built-ins. Both name their target in `path`. */
const WRITE_TOOLS = new Set(['edit', 'write']);
/** Pi's command runner. */
const COMMAND_TOOLS = new Set(['bash']);

export function categorize(tool: string, foundryTools: readonly string[] = []): ToolCategory {
  if (READ_TOOLS.has(tool)) return 'read';
  if (WRITE_TOOLS.has(tool)) return 'write';
  if (COMMAND_TOOLS.has(tool)) return 'command';
  if (foundryTools.includes(tool)) return 'foundry';
  return 'unknown';
}

export function evaluate(
  ask: PermissionAsk,
  ctx: PolicyContext,
  foundryTools: readonly string[] = [],
): PolicyOutcome {
  const tool = ask.tool;
  const category = categorize(tool, foundryTools);

  switch (category) {
    case 'read':
      return allow(`${tool} is read-only`);

    case 'foundry':
      // Foundry's own tools read the run (envelopes, its own diff) and write
      // only the trace, which is the app's record of the run rather than
      // anything the write boundary governs.
      return allow(`${tool} is a Foundry tool and writes nothing but the trace`);

    case 'command': {
      const command = ask.command ?? pickString(ask.input, ['command']);
      if (!command) return deny(`${tool} asked with no command to run`);
      // Commands run unattended: the post-hoc git diff is what catches a
      // command that wrote where it should not have.
      return { ...allow('commands run unattended'), command };
    }

    case 'write': {
      const path = ask.path ?? pickString(ask.input, ['path', 'file_path', 'filePath']);
      // A write whose target cannot be read is the one case that must fail
      // closed: the post-hoc git diff only sees inside the worktree, so an
      // unreadable path could be a base-checkout write with nothing to revert it.
      if (!path) {
        return deny(`${tool} asked with no target path; a write must name where it lands`);
      }
      const rel = toRelative(ctx.worktree, path);
      // The base checkout and everything else on the machine are off limits,
      // and the git-diff enforcement only sees inside the worktree, so this is
      // the one place an out-of-worktree write can still be stopped.
      if (rel === null) return deny(`${tool} targets ${path}, outside the run worktree`);
      if (isProtected(rel, ctx.protectedPaths)) return deny(`${rel} is a protected path`);
      if (!isAllowed(rel, ctx.writes, ctx.protectedPaths)) {
        return deny(`${rel} is outside this agent's write boundary`);
      }
      return allow(`${rel} is in boundary and inside the worktree`);
    }

    case 'unknown':
      return deny(`${tool} is not a tool this policy recognises`);
  }
}

function allow(reason: string): PolicyOutcome {
  return { decision: { outcome: 'allow' }, reason };
}

function deny(reason: string): PolicyOutcome {
  return { decision: { outcome: 'deny', reason }, reason };
}

function toRelative(worktree: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(worktree, path);
  const rel = relative(worktree, abs);
  if (rel.startsWith('..')) return null;
  return rel;
}

function pickString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
