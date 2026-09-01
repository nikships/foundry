/**
 * The zero-interrupt policy, per tool.
 *
 * A run settles without a human, so every branch here is load-bearing: an
 * allow that should have been a deny is a write outside the worktree, and a
 * deny that should have been an allow is a phase that cannot do its job.
 *
 * The rule this suite exists to pin is the fail-closed one. The post-hoc
 * enforcement (a `git diff` of the worktree) can only see inside the worktree,
 * so a tool nobody classified could act where nothing would catch it — an
 * unrecognised tool is denied rather than waved through.
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { categorize, evaluate, type PolicyContext } from '../../../src/main/pi/policy.js';
import { FOUNDRY_TOOL_NAMES, ONESHOT_OUTPUT_TOOL_NAME } from '../../../src/main/pi/tool-names.js';
import type { PermissionAsk } from '../../../src/main/pi/transport.js';

const WORKTREE = '/tmp/foundry-worktree';

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    worktree: WORKTREE,
    writes: null,
    protectedPaths: ['.foundry/', '.git/'],
    ...over,
  };
}

function ask(tool: string, input: Record<string, unknown> = {}): PermissionAsk {
  return { tool, input };
}

function decide(a: PermissionAsk, over: Partial<PolicyContext> = {}) {
  return evaluate(a, ctx(over), FOUNDRY_TOOL_NAMES);
}

describe('tool categories', () => {
  it('classifies the runtime built-ins the transport actually enables', () => {
    expect(categorize('read')).toBe('read');
    expect(categorize('grep')).toBe('read');
    expect(categorize('find')).toBe('read');
    expect(categorize('ls')).toBe('read');
    expect(categorize('edit')).toBe('write');
    expect(categorize('write')).toBe('write');
    expect(categorize('bash')).toBe('command');
  });

  it('classifies Foundry’s own tools only when they are named', () => {
    expect(categorize('submit_envelope', FOUNDRY_TOOL_NAMES)).toBe('foundry');
    // Without the list they are indistinguishable from anything else, which is
    // why the session passes it rather than the policy hard-coding names.
    expect(categorize('submit_envelope')).toBe('unknown');
    expect(categorize(ONESHOT_OUTPUT_TOOL_NAME, [ONESHOT_OUTPUT_TOOL_NAME])).toBe('foundry');
  });

  it('classifies anything it does not recognise as unknown', () => {
    expect(categorize('some_future_tool')).toBe('unknown');
    expect(categorize('')).toBe('unknown');
  });
});

describe('read-only and Foundry tools', () => {
  it('allows every read tool without inspecting its arguments', () => {
    for (const tool of ['read', 'grep', 'find', 'ls']) {
      const outcome = decide(ask(tool, { path: '/etc/passwd' }));
      expect(outcome.decision.outcome, tool).toBe('allow');
      expect(outcome.reason).toContain('read-only');
    }
  });

  it('allows explicitly named Foundry tools that cannot write the worktree', () => {
    for (const tool of FOUNDRY_TOOL_NAMES) {
      expect(decide(ask(tool)).decision.outcome, tool).toBe('allow');
    }
    expect(
      evaluate(ask(ONESHOT_OUTPUT_TOOL_NAME), ctx(), [ONESHOT_OUTPUT_TOOL_NAME]).decision.outcome,
    ).toBe('allow');
  });
});

describe('commands', () => {
  it('allows a command and records what it was', () => {
    const outcome = decide(ask('bash', { command: 'npm test' }));
    expect(outcome.decision.outcome).toBe('allow');
    expect(outcome.command).toBe('npm test');
  });

  it('reads the command off the ask when the transport lifted it out', () => {
    const outcome = evaluate(
      { tool: 'bash', input: {}, command: 'ls -la' },
      ctx(),
      FOUNDRY_TOOL_NAMES,
    );
    expect(outcome.decision.outcome).toBe('allow');
    expect(outcome.command).toBe('ls -la');
  });

  it('denies a command call that names no command', () => {
    // Nothing to run means nothing to record, and an allow would put an
    // unattended call in the trace with no evidence of what it did.
    expect(decide(ask('bash', {})).decision).toEqual({
      outcome: 'deny',
      reason: 'bash asked with no command to run',
    });
  });
});

describe('writes', () => {
  it('allows a write inside the worktree and inside the boundary', () => {
    const outcome = decide(ask('write', { path: join(WORKTREE, 'src/app.ts') }), {
      writes: ['src/'],
    });
    expect(outcome.decision.outcome).toBe('allow');
  });

  it('resolves a relative path against the worktree, not the process cwd', () => {
    const outcome = decide(ask('edit', { path: 'src/app.ts' }), { writes: ['src/'] });
    expect(outcome.decision.outcome).toBe('allow');
    expect(outcome.reason).toContain('src/app.ts');
  });

  it('denies a write outside the worktree', () => {
    // This is the one out-of-worktree write that can still be stopped: the
    // post-hoc git diff never sees the base checkout or the rest of the disk.
    const outcome = decide(ask('write', { path: '/tmp/elsewhere/escaped.txt' }));
    expect(outcome.decision.outcome).toBe('deny');
    expect(outcome.reason).toContain('outside the run worktree');
  });

  it('denies a write to a protected path however wide the boundary is', () => {
    const outcome = decide(ask('write', { path: join(WORKTREE, '.foundry/stash.json') }), {
      writes: null,
    });
    expect(outcome.decision.outcome).toBe('deny');
    expect(outcome.reason).toContain('protected path');
  });

  it('denies a write outside the agent’s own boundary', () => {
    const outcome = decide(ask('edit', { path: join(WORKTREE, 'docs/readme.md') }), {
      writes: ['src/'],
    });
    expect(outcome.decision.outcome).toBe('deny');
    expect(outcome.reason).toContain("outside this agent's write boundary");
  });

  it('denies a write that names no path at all', () => {
    const outcome = decide(ask('write', { content: 'anything' }));
    expect(outcome.decision.outcome).toBe('deny');
    expect(outcome.reason).toContain('must name where it lands');
  });

  it('reads the target from whichever key the tool used', () => {
    for (const key of ['path', 'file_path', 'filePath']) {
      const outcome = decide(ask('write', { [key]: join(WORKTREE, 'src/app.ts') }), {
        writes: ['src/'],
      });
      expect(outcome.decision.outcome, key).toBe('allow');
    }
  });
});

describe('an unrecognised tool', () => {
  it('is denied, so a tool this build never classified cannot act unwatched', () => {
    const outcome = decide(ask('some_future_tool', { path: join(WORKTREE, 'src/app.ts') }));
    expect(outcome.decision).toEqual({
      outcome: 'deny',
      reason: 'some_future_tool is not a tool this policy recognises',
    });
  });

  it('is denied even when its arguments look harmless', () => {
    expect(decide(ask('mcp__something__read', {})).decision.outcome).toBe('deny');
  });
});
