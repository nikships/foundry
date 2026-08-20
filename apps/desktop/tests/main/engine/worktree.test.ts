/**
 * Worktree lifecycle against real git. The bug these cover: a run's own
 * `.foundry-worktrees/` directory reported as untracked in the base checkout,
 * and merge refusing on that self-inflicted dirt.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import { changedPaths, currentBranch, excludeLocally } from '../../../src/main/engine/git.js';
import * as worktree from '../../../src/main/engine/worktree.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchRepo(): string {
  const dir = tempDir('foundry-worktree-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  writeFileSync(join(dir, 'untouched.txt'), 'base\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

function emptyScratchRepo(): string {
  const dir = tempDir('foundry-empty-worktree-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  return dir;
}

/** A run that changed one file and committed it on its own branch. */
async function runWith(repo: string, runId: string, file: string, body: string) {
  const handle = await worktree.create({ repo, runId, baseRef: 'main' });
  writeFileSync(join(handle.path, file), body);
  sh(handle.path, ['git', 'add', '-A']);
  sh(handle.path, ['git', 'commit', '-qm', `work in ${runId}`]);
  return handle;
}

describe('worktree isolation', () => {
  it('keeps its own directory out of the base checkout status', async () => {
    const repo = scratchRepo();
    await worktree.create({ repo, runId: 'run_a', baseRef: 'main' });
    expect(await changedPaths(repo)).toEqual([]);
  });

  it('records the exclude in .git/info/exclude and not in .gitignore', async () => {
    const repo = scratchRepo();
    await worktree.create({ repo, runId: 'run_a', baseRef: 'main' });
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain(worktree.WORKTREE_EXCLUDE);
    expect(sh(repo, ['git', 'status', '--porcelain'])).toBe('');
  });

  it('does not duplicate the entry across runs', async () => {
    const repo = scratchRepo();
    await worktree.create({ repo, runId: 'run_a', baseRef: 'main' });
    await worktree.create({ repo, runId: 'run_b', baseRef: 'main' });
    const lines = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === worktree.WORKTREE_EXCLUDE);
    expect(lines).toHaveLength(1);
  });

  it('leaves an existing .gitignore rule alone', async () => {
    const repo = scratchRepo();
    writeFileSync(join(repo, '.gitignore'), '.foundry-worktrees/\n');
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'ignore worktrees']);
    await worktree.create({ repo, runId: 'run_a', baseRef: 'main' });
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).not.toContain(worktree.WORKTREE_EXCLUDE);
  });

  it('is idempotent when called directly', async () => {
    const repo = scratchRepo();
    expect(await excludeLocally(repo, 'scratch')).toBe(true);
    expect(await excludeLocally(repo, 'scratch')).toBe(true);
    const lines = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() === '/scratch/');
    expect(lines).toHaveLength(1);
  });

  it('works from a linked worktree, whose .git is a file', async () => {
    const repo = scratchRepo();
    const handle = await worktree.create({ repo, runId: 'run_a', baseRef: 'main' });
    expect(await excludeLocally(handle.path, 'scratch')).toBe(true);
    // --git-common-dir points back at the main repo, so the rule lands there.
    expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/scratch/');
  });

  it('works on an empty repository with no commits', async () => {
    const repo = emptyScratchRepo();
    const handle = await worktree.create({ repo, runId: 'run_empty', baseRef: 'main' });
    expect(handle.branchPointSha).toBe('');
    expect(handle.branch).toBe('foundry/run_empty');
    expect(await changedPaths(repo)).toEqual([]);
  });
});

describe('merge', () => {
  it('merges a finished run into the base', async () => {
    const repo = scratchRepo();
    const handle = await runWith(repo, 'run_a', 'feature.ts', 'export const a = 1;\n');
    const outcome = await worktree.merge(repo, handle);
    expect(outcome.merged).toBe(true);
    expect(readFileSync(join(repo, 'feature.ts'), 'utf8')).toContain('export const a = 1;');
  });

  it('merges work on an initially empty repository back into the base', async () => {
    const repo = emptyScratchRepo();
    const handle = await worktree.create({ repo, runId: 'run_empty', baseRef: 'main' });
    writeFileSync(join(handle.path, 'index.ts'), 'export const first = 1;\n');
    sh(handle.path, ['git', 'add', '-A']);
    sh(handle.path, ['git', 'commit', '-qm', 'initial commit in run']);

    const outcome = await worktree.merge(repo, handle);
    expect(outcome.merged).toBe(true);
    expect(readFileSync(join(repo, 'index.ts'), 'utf8')).toContain('export const first = 1;');
    expect(await currentBranch(repo)).toBe('main');
  });

  it('merges even when the base has unrelated uncommitted work', async () => {
    const repo = scratchRepo();
    const handle = await runWith(repo, 'run_a', 'feature.ts', 'export const a = 1;\n');
    writeFileSync(join(repo, 'untouched.txt'), 'operator was mid-edit\n');
    writeFileSync(join(repo, 'scratch.md'), 'notes\n');

    const outcome = await worktree.merge(repo, handle);
    expect(outcome.merged).toBe(true);
    // The operator's work survives the merge untouched.
    expect(readFileSync(join(repo, 'untouched.txt'), 'utf8')).toBe('operator was mid-edit\n');
    expect(readFileSync(join(repo, 'scratch.md'), 'utf8')).toBe('notes\n');
  });

  it('refuses and preserves local work when the merge would overwrite it', async () => {
    const repo = scratchRepo();
    const handle = await runWith(repo, 'run_a', 'untouched.txt', 'run rewrote this\n');
    writeFileSync(join(repo, 'untouched.txt'), 'operator rewrote this\n');

    const outcome = await worktree.merge(repo, handle);
    expect(outcome.merged).toBe(false);
    expect(outcome.detail).not.toBe('');
    expect(readFileSync(join(repo, 'untouched.txt'), 'utf8')).toBe('operator rewrote this\n');
    expect(await currentBranch(repo)).toBe('main');
  });

  it('refuses when the base moved since the run branched', async () => {
    const repo = scratchRepo();
    const handle = await runWith(repo, 'run_a', 'feature.ts', 'export const a = 1;\n');
    writeFileSync(join(repo, 'other.ts'), 'export const b = 2;\n');
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'base moved']);

    const outcome = await worktree.merge(repo, handle);
    expect(outcome.merged).toBe(false);
    expect(outcome.detail).toContain('rebase before merging');
  });
});
