/**
 * The zero-interrupt permission policy.
 *
 * Once a pipeline starts it settles without a human, so `evaluate()` always
 * returns a decision — there is no "ask someone" outcome to fall back on.
 * That is only safe because the real guard is post-hoc and code-owned: the
 * write boundary is enforced by diffing git after the call and reverting what
 * was not allowed, and protected paths fail the phase outright. Asking mid-turn
 * is an early warning, not the enforcement.
 *
 * Every branch is traced as an `interrupt` event with `auto: true` and the
 * reason, so observability replaces interruption.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { WriteBoundary } from '@shared/types.js';
import { isAllowed, isProtected } from '../engine/boundary.js';
import type { PermissionDecision } from './turn.js';

export interface PolicyContext {
  worktree: string;
  writes: WriteBoundary;
  protectedPaths: string[];
}

/** One auto-answer for a `droid.ask_user` question, in the CLI's own shape. */
export interface QuestionAnswer {
  index: number;
  question: string;
  answer: string;
}

export interface PolicyOutcome {
  /** Never null: a started run never waits for a person. */
  decision: PermissionDecision;
  /** Why: recorded on the interrupt event whichever way it goes. */
  reason: string;
  /** Set for `droid.ask_user` only, one entry per question asked. */
  answers?: QuestionAnswer[];
  command?: string;
}

/** What an agent is told when its question has no options to choose from. */
export const OPEN_QUESTION_ANSWER = 'Proceed with your best judgment; do not ask again.';

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

interface AskUserQuestion {
  index?: number;
  question?: string;
  options?: unknown;
}

export function evaluate(
  ask: { method: 'droid.request_permission' | 'droid.ask_user'; params: Record<string, unknown> },
  ctx: PolicyContext,
): PolicyOutcome {
  const params = ask.params;

  if (ask.method === 'droid.ask_user') {
    const answers = autoAnswer(params);
    return {
      decision: { outcome: 'allow' },
      reason: `auto-answered ${answers.length} question(s): runs never wait for a person`,
      answers,
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
    // The base checkout and everything else on the machine are off limits, and
    // the git-diff enforcement only sees inside the worktree, so this ask is
    // the one place an out-of-worktree write can still be stopped.
    if (rel === null) {
      return deny(`${tool} targets ${path}, outside the run worktree`);
    }
    if (isProtected(rel, ctx.protectedPaths)) {
      return deny(`${rel} is a protected path`);
    }
    if (!isAllowed(rel, ctx.writes, ctx.protectedPaths)) {
      return deny(`${rel} is outside this agent's write boundary`);
    }
    return allow(`${rel} is in boundary and inside the worktree`);
  }

  if (command) {
    return { ...allow('commands run unattended'), command };
  }

  return allow(`${tool} matches no policy rule; the write boundary is the guard`);
}

function allow(reason: string): PolicyOutcome {
  return { decision: { outcome: 'allow' }, reason };
}

function deny(reason: string): PolicyOutcome {
  return { decision: { outcome: 'deny', reason }, reason };
}

/**
 * Each question takes its first option, which is the CLI's own recommended
 * choice. A question with no options gets prose instead: an empty answer reads
 * to the agent as a refusal and it asks again.
 */
function autoAnswer(params: Record<string, unknown>): QuestionAnswer[] {
  const raw = Array.isArray(params.questions) ? (params.questions as AskUserQuestion[]) : [];
  const questions = raw.length ? raw : [{}];
  return questions.map((q, i) => {
    const options = Array.isArray(q.options) ? (q.options as unknown[]) : [];
    const first = options.find((o) => typeof o === 'string' && o.trim());
    return {
      index: typeof q.index === 'number' ? q.index : i,
      question: typeof q.question === 'string' ? q.question : '',
      answer: typeof first === 'string' ? first : OPEN_QUESTION_ANSWER,
    };
  });
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
    Record<string, unknown> | undefined;
  if (!nested) return undefined;
  return (nested.input ?? nested) as Record<string, unknown>;
}

function extractCommand(params: Record<string, unknown>): string | undefined {
  return pickString(nestedFields(params) ?? {}, ['command']);
}

function extractPath(params: Record<string, unknown>): string | undefined {
  return pickString(nestedFields(params) ?? {}, ['file_path', 'path', 'filePath']);
}
