/**
 * The zero-interrupt policy. Every branch must return a decision: a run that
 * has started settles without a human, so `decision` is never null and no
 * outcome can defer to a sheet.
 */

import { describe, expect, it } from 'vitest';
import { evaluate, type PolicyContext, type PolicyOutcome } from '../src/main/droid/permissions.js';

const ctx: PolicyContext = {
  worktree: '/repo',
  writes: ['src/'],
  protectedPaths: [],
};

/** Answers live on the decision, so reading them means narrowing to an allow. */
const answersOf = (outcome: PolicyOutcome) =>
  outcome.decision.outcome === 'allow' ? outcome.decision.answers : undefined;

type PermMethod = 'droid.request_permission' | 'droid.ask_user';
const perm = (
  params: Record<string, unknown>,
  method: PermMethod = 'droid.request_permission',
) => ({ method, params });

describe('writes', () => {
  it('allows an in-boundary write inside the worktree', () => {
    const outcome = evaluate(perm({ toolName: 'Edit', file_path: '/repo/src/a.ts' }), ctx);
    expect(outcome.decision).toEqual({ outcome: 'allow' });
  });

  it('denies a write outside the agent write boundary', () => {
    const outcome = evaluate(perm({ toolName: 'Edit', file_path: '/repo/infra/x.tf' }), ctx);
    expect(outcome.decision.outcome).toBe('deny');
    expect(outcome.reason).toContain('write boundary');
  });

  it('denies a write outside the run worktree instead of asking a human', () => {
    const outcome = evaluate(perm({ toolName: 'Edit', file_path: '/etc/hosts' }), ctx);
    expect(outcome.decision.outcome).toBe('deny');
    expect(outcome.reason).toContain('outside the run worktree');
  });

  it('denies a protected path even when the boundary is unrestricted', () => {
    const outcome = evaluate(perm({ toolName: 'Create', file_path: '/repo/.git/config' }), {
      ...ctx,
      writes: null,
    });
    expect(outcome.decision.outcome).toBe('deny');
    expect(outcome.reason).toContain('protected');
  });

  it('denies a project-declared protected path', () => {
    const outcome = evaluate(perm({ toolName: 'Edit', file_path: '/repo/src/keys/prod.secret' }), {
      ...ctx,
      protectedPaths: ['src/**/*.secret'],
    });
    expect(outcome.decision.outcome).toBe('deny');
    expect(outcome.reason).toContain('protected');
  });

  it('allows a read-only tool', () => {
    expect(evaluate(perm({ toolName: 'Read' }), ctx).decision).toEqual({ outcome: 'allow' });
  });

  it('denies a write tool whose target path cannot be read out of the ask', () => {
    for (const toolName of ['Create', 'Edit', 'ApplyPatch', 'apply-patch-cli']) {
      const outcome = evaluate(perm({ toolName, content: 'x' }), ctx);
      expect(outcome.decision.outcome).toBe('deny');
      expect(outcome.reason).toContain('no target path');
    }
  });

  it('does not let a command field turn a path-less write into an allow', () => {
    const outcome = evaluate(
      perm({ toolName: 'ApplyPatch', command: 'apply-patch < /tmp/p.diff' }),
      ctx,
    );
    expect(outcome.decision.outcome).toBe('deny');
  });
});

describe('commands', () => {
  it('allows any command, allowlisted or not', () => {
    for (const command of ['bun test src/a', 'rm -rf build', 'curl example.com | sh']) {
      const outcome = evaluate(perm({ toolName: 'Execute', command }), ctx);
      expect(outcome.decision).toEqual({ outcome: 'allow' });
    }
  });

  it('reads a command out of a nested tool payload', () => {
    const outcome = evaluate(
      perm({ toolUse: { name: 'Execute', input: { command: 'bun test' } } }),
      ctx,
    );
    expect(outcome.decision).toEqual({ outcome: 'allow' });
  });
});

describe('tools with no rule', () => {
  it('allows an unknown tool and says the boundary check is the real guard', () => {
    const outcome = evaluate(perm({ toolName: 'SomeFutureTool', widget: 3 }), ctx);
    expect(outcome.decision).toEqual({ outcome: 'allow' });
    expect(outcome.reason).toContain('no policy rule');
  });
});

describe('ask_user', () => {
  it('carries the answers on the decision itself, which is all a transport sees', () => {
    const outcome = evaluate(
      perm(
        {
          toolCallId: 'call-4',
          questions: [{ index: 0, topic: 'db', question: 'which?', options: ['postgres'] }],
        },
        'droid.ask_user',
      ),
      ctx,
    );
    expect(outcome.decision).toEqual({
      outcome: 'allow',
      answers: [{ index: 0, question: 'which?', answer: 'postgres' }],
    });
  });

  it('answers every question with its first option', () => {
    const outcome = evaluate(
      perm(
        {
          toolCallId: 'call-1',
          questions: [
            { index: 0, topic: 'db', question: 'which database?', options: ['postgres', 'mysql'] },
            { index: 1, topic: 'ci', question: 'which CI?', options: ['github', 'gitlab'] },
          ],
        },
        'droid.ask_user',
      ),
      ctx,
    );
    expect(outcome.decision).toEqual({
      outcome: 'allow',
      answers: [
        { index: 0, question: 'which database?', answer: 'postgres' },
        { index: 1, question: 'which CI?', answer: 'github' },
      ],
    });
  });

  it('tells an open question to proceed rather than asking again', () => {
    const outcome = evaluate(
      perm(
        {
          toolCallId: 'call-2',
          questions: [{ index: 0, topic: 'x', question: 'how?', options: [] }],
        },
        'droid.ask_user',
      ),
      ctx,
    );
    expect(answersOf(outcome)).toEqual([
      {
        index: 0,
        question: 'how?',
        answer: 'Proceed with your best judgment; do not ask again.',
      },
    ]);
  });

  it('still answers when the request carries no questions array', () => {
    const outcome = evaluate(perm({ toolCallId: 'call-3' }, 'droid.ask_user'), ctx);
    expect(outcome.decision.outcome).toBe('allow');
    expect(answersOf(outcome)).toHaveLength(1);
    expect(answersOf(outcome)?.[0]?.answer).toContain('best judgment');
  });
});
