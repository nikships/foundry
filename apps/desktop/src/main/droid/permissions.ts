/**
 * Permission policy: why the raw JSON-RPC surface exists.
 *
 * Too much auto-approve and autonomy is theater; too little and unattended
 * runs stall. Rule is conservative: file ops inside the worktree and write
 * boundary auto-approve at medium+, allowlisted commands auto-approve, and
 * everything else becomes a human interrupt. Every decision is traced.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { AutonomyLevel, WriteBoundary } from '@shared/types.js';
import { isAllowed } from '../engine/boundary.js';
import type { PermissionAsk, PermissionDecision } from './client.js';

export interface PolicyContext {
  autonomy: AutonomyLevel;
  worktree: string;
  writes: WriteBoundary;
  protectedPaths: string[];
  allowedCommands: string[];
}

export interface PolicyOutcome {
  decision: PermissionDecision | null;
  /** Why: recorded on the interrupt event whichever way it goes. */
  reason: string;
  /** What the sheet shows when the policy declines to decide. */
  title: string;
  body: string;
  command?: string;
}

const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'TodoWrite',
  'WebSearch',
  'FetchUrl',
]);
const WRITE_TOOLS = new Set(['Create', 'Edit', 'ApplyPatch', 'apply-patch-cli']);

export function evaluate(ask: PermissionAsk, ctx: PolicyContext): PolicyOutcome {
  const params = ask.params;

  if (ask.method === 'droid.ask_user') {
    return {
      decision: null,
      reason: 'agent asked a question: only a human can answer it',
      title: 'The agent has a question',
      body: describeQuestion(params),
    };
  }

  const tool = pickString(params, ['toolName', 'tool', 'name']) ?? 'unknown';
  const command = pickString(params, ['command']) ?? extractCommand(params);
  const path = pickString(params, ['file_path', 'path', 'filePath']) ?? extractPath(params);

  if (READ_ONLY_TOOLS.has(tool)) {
    return allow(`${tool} is read-only`);
  }

  if (WRITE_TOOLS.has(tool) && path) {
    const rel = toRelative(ctx.worktree, path);
    if (rel === null) {
      return {
        decision: null,
        reason: `${tool} targets ${path}, outside the run worktree`,
        title: 'Write outside the worktree',
        body: `${tool} wants to write ${path}, which is not inside ${ctx.worktree}.`,
      };
    }
    if (!isAllowed(rel, ctx.writes, ctx.protectedPaths)) {
      return {
        decision: { outcome: 'deny', reason: `${rel} is outside this agent's write boundary` },
        reason: `${rel} is outside the write boundary`,
        title: '',
        body: '',
      };
    }
    if (ctx.autonomy === 'low') {
      return {
        decision: null,
        reason: 'autonomy is low: every write is confirmed',
        title: 'Approve a file write',
        body: `${tool} wants to write ${rel}.`,
      };
    }
    return allow(`${rel} is in boundary and inside the worktree`);
  }

  if (command) {
    if (ctx.allowedCommands.some((allowed) => commandMatchesAllow(command, allowed))) {
      return allow('command is on the project allowlist');
    }
    if (ctx.autonomy === 'high') {
      return allow('autonomy is high: commands run without confirmation');
    }
    return {
      decision: null,
      reason: `command is not on the allowlist at autonomy ${ctx.autonomy}`,
      title: 'Approve a command',
      body: command,
      command,
    };
  }

  return {
    decision: null,
    reason: `${tool} does not match any policy rule`,
    title: `Approve ${tool}`,
    body: JSON.stringify(params).slice(0, 1200),
  };
}

function allow(reason: string): PolicyOutcome {
  return { decision: { outcome: 'allow' }, reason, title: '', body: '' };
}

/** Allowlist entries match a command's head, so `bun test -x` matches `bun test`. */
export function commandMatchesAllow(command: string, allowed: string): boolean {
  const c = command.trim();
  const a = allowed.trim();
  if (!a) return false;
  return c === a || c.startsWith(`${a} `);
}

function toRelative(worktree: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(worktree, path);
  const rel = relative(worktree, abs);
  if (rel.startsWith('..')) return null;
  return rel;
}

function pickString(params: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = params[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function nestedFields(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const nested = (params.toolUse ?? params.input ?? params.tool_input) as
    | Record<string, unknown>
    | undefined;
  if (!nested) return undefined;
  return (nested.input ?? nested) as Record<string, unknown>;
}

function extractCommand(params: Record<string, unknown>): string | undefined {
  return pickString(nestedFields(params) ?? {}, ['command']);
}

function extractPath(params: Record<string, unknown>): string | undefined {
  return pickString(nestedFields(params) ?? {}, ['file_path', 'path', 'filePath']);
}

function describeQuestion(params: Record<string, unknown>): string {
  return (
    pickString(params, ['question', 'questionnaire', 'prompt', 'message']) ??
    JSON.stringify(params).slice(0, 1500)
  );
}
