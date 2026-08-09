/**
 * Agent-assisted rebase repair against real git, with the agent replaced by a
 * function that manipulates the worktree directly. What these pin down: the
 * verdict comes from git, not from the agent's claim — a clean rebase counts,
 * and a lazy, abandoned, or work-destroying turn is rolled back to exactly
 * where the run left off.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headSha, isAncestor, resolveRef, status } from '../src/main/engine/git.js';
import { rebaseOntoBase, type RepairAgent } from '../src/main/engine/repair.js';
import * as worktree from '../src/main/engine/worktree.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function trySh(cwd: string, argv: string[]): void {
  try {
    sh(cwd, argv);
  } catch {
    // The fake agent giving up mid-command is part of the scenario.
  }
}

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-repair-'));
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'shared.txt'), 'line one\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

/**
 * The repair scenario: a run committed work on its branch, then the base
 * moved. `conflicting` makes both sides edit the same file.
 */
async function divergedRun(conflicting: boolean) {
  const repo = scratchRepo();
  const handle = await worktree.create({ repo, runId: 'run_fix', baseRef: 'main' });
  writeFileSync(join(handle.path, conflicting ? 'shared.txt' : 'run.txt'), 'the run side\n');
  sh(handle.path, ['git', 'add', '-A']);
  sh(handle.path, ['git', 'commit', '-qm', 'run work']);

  writeFileSync(join(repo, conflicting ? 'shared.txt' : 'base.txt'), 'the base side\n');
  sh(repo, ['git', 'add', '-A']);
  sh(repo, ['git', 'commit', '-qm', 'base moved']);

  const ontoSha = await headSha(repo);
  return { repo, handle, ontoSha };
}

const agentThat = (work: () => void): RepairAgent => ({
  send: async () => {
    work();
    return { text: 'Resolved by keeping both sides.' };
  },
});

describe('rebaseOntoBase', () => {
  it('accepts a clean rebase and reports the movement', async () => {
    const { handle, ontoSha } = await divergedRun(false);
    const before = await headSha(handle.path);

    const outcome = await rebaseOntoBase({
      worktreePath: handle.path,
      branch: handle.branch,
      ontoSha,
      ontoLabel: 'main',
      agent: agentThat(() => sh(handle.path, ['git', 'rebase', ontoSha])),
      timeoutMs: 60_000,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain(`rebased ${handle.branch} onto main`);
    const after = await headSha(handle.path);
    expect(after).not.toBe(before);
    expect(await isAncestor(handle.path, ontoSha, after)).toBe(true);
    // Both sides of the divergence survived.
    expect(sh(handle.path, ['git', 'ls-files'])).toContain('run.txt');
    expect(sh(handle.path, ['git', 'ls-files'])).toContain('base.txt');
  });

  it('rejects a turn that changed nothing', async () => {
    const { handle, ontoSha } = await divergedRun(false);
    const before = await headSha(handle.path);

    const outcome = await rebaseOntoBase({
      worktreePath: handle.path,
      branch: handle.branch,
      ontoSha,
      ontoLabel: 'main',
      agent: agentThat(() => {}),
      timeoutMs: 60_000,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('does not sit on main');
    expect(await headSha(handle.path)).toBe(before);
  });

  it('aborts a rebase the agent abandoned mid-conflict', async () => {
    const { handle, ontoSha } = await divergedRun(true);
    const before = await headSha(handle.path);

    const outcome = await rebaseOntoBase({
      worktreePath: handle.path,
      branch: handle.branch,
      ontoSha,
      ontoLabel: 'main',
      // Starts the rebase, hits the conflict, walks away.
      agent: agentThat(() => trySh(handle.path, ['git', 'rebase', ontoSha])),
      timeoutMs: 60_000,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('rebase aborted');
    // Rolled back to where the run left off: clean tree, original head.
    expect(await status(handle.path)).toEqual([]);
    expect(await headSha(handle.path)).toBe(before);
  });

  it('rejects a "fix" that erased the run’s own commits', async () => {
    const { handle, ontoSha } = await divergedRun(false);

    const outcome = await rebaseOntoBase({
      worktreePath: handle.path,
      branch: handle.branch,
      ontoSha,
      ontoLabel: 'main',
      agent: agentThat(() => sh(handle.path, ['git', 'reset', '--hard', ontoSha])),
      timeoutMs: 60_000,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('work would be lost');
  });

  it('reports an agent that threw, without wrecking the worktree', async () => {
    const { handle, ontoSha } = await divergedRun(false);
    const before = await headSha(handle.path);

    const outcome = await rebaseOntoBase({
      worktreePath: handle.path,
      branch: handle.branch,
      ontoSha,
      ontoLabel: 'main',
      agent: {
        send: async () => {
          throw new Error('one-shot turn timed out after 60000ms');
        },
      },
      timeoutMs: 60_000,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('timed out');
    expect(await headSha(handle.path)).toBe(before);
    expect(await resolveRef(handle.path, 'HEAD')).toBe(before);
  });
});
