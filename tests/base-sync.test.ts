/**
 * Local base ref vs the preferred remote. Inspect must not move the operator's
 * branch; sync only fast-forwards.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectBase, syncBase } from '../src/main/engine/base-sync.js';
import { currentBranch, headSha } from '../src/main/engine/git.js';
import { tempDir } from './tmp.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchRepoWithOrigin(): { repo: string; bare: string } {
  const dir = tempDir('foundry-base-sync-');
  const bare = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  sh(dir, ['git', 'init', '-q', '--bare', '-b', 'main', 'origin.git']);
  sh(dir, ['git', 'init', '-q', '-b', 'main', 'repo']);
  sh(repo, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(repo, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  sh(repo, ['git', 'add', '-A']);
  sh(repo, ['git', 'commit', '-qm', 'initial']);
  sh(repo, ['git', 'remote', 'add', 'origin', bare]);
  sh(repo, ['git', 'push', '-qu', 'origin', 'main']);
  return { repo, bare };
}

function twoClones(): { behind: string; ahead: string } {
  const { repo: ahead, bare } = scratchRepoWithOrigin();
  const dir = tempDir('foundry-base-sync-clone-');
  sh(dir, ['git', 'clone', '-q', bare, 'behind']);
  const behind = join(dir, 'behind');
  sh(behind, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(behind, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(ahead, 'ahead.txt'), 'moved\n');
  sh(ahead, ['git', 'add', '-A']);
  sh(ahead, ['git', 'commit', '-qm', 'advance main']);
  sh(ahead, ['git', 'push', '-q', 'origin', 'main']);
  return { behind, ahead };
}

describe('inspectBase', () => {
  it('reports no_remote when the repo has nowhere to fetch', async () => {
    const dir = tempDir('foundry-base-sync-local-');
    sh(dir, ['git', 'init', '-q', '-b', 'main']);
    sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
    sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    sh(dir, ['git', 'add', '-A']);
    sh(dir, ['git', 'commit', '-qm', 'initial']);

    const status = await inspectBase(dir, 'main');
    expect(status.state).toBe('no_remote');
    expect(status.remote).toBeNull();
  });

  it('reports current when local main matches origin', async () => {
    const { repo } = scratchRepoWithOrigin();
    const status = await inspectBase(repo, 'main');
    expect(status.state).toBe('current');
    expect(status.fetched).toBe(true);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    expect(status.localSha).toBe(status.remoteSha);
  });

  it('reports behind after origin moves, without moving local main', async () => {
    const { behind, ahead } = twoClones();
    const before = await headSha(behind);
    const status = await inspectBase(behind, 'main');
    expect(status.state).toBe('behind');
    expect(status.behind).toBe(1);
    expect(status.ahead).toBe(0);
    expect(status.remoteSha).toBe(await headSha(ahead));
    expect(await headSha(behind)).toBe(before);
    expect(await currentBranch(behind)).toBe('main');
  });

  it('reports ahead when the local base has unpushed commits', async () => {
    const { repo } = scratchRepoWithOrigin();
    writeFileSync(join(repo, 'local.txt'), 'only here\n');
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'local only']);
    const status = await inspectBase(repo, 'main');
    expect(status.state).toBe('ahead');
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(0);
  });

  it('does not change the checked-out branch when inspecting from elsewhere', async () => {
    const { behind } = twoClones();
    sh(behind, ['git', 'checkout', '-qb', 'elsewhere']);
    const before = await headSha(behind);
    const status = await inspectBase(behind, 'main');
    expect(status.state).toBe('behind');
    expect(await currentBranch(behind)).toBe('elsewhere');
    expect(await headSha(behind)).toBe(before);
  });

  it('reports diverged when both sides have unique commits', async () => {
    const { behind } = twoClones();
    writeFileSync(join(behind, 'local.txt'), 'also here\n');
    sh(behind, ['git', 'add', '-A']);
    sh(behind, ['git', 'commit', '-qm', 'local only']);
    const status = await inspectBase(behind, 'main');
    expect(status.state).toBe('diverged');
    expect(status.ahead).toBe(1);
    expect(status.behind).toBe(1);
  });
});

describe('syncBase', () => {
  it('fast-forwards a behind main while standing on it', async () => {
    const { behind, ahead } = twoClones();
    const result = await syncBase(behind, 'main');
    expect(result.ok).toBe(true);
    expect(result.status.state).toBe('current');
    expect(await headSha(behind)).toBe(await headSha(ahead));
  });

  it('updates main without leaving the branch the operator is on', async () => {
    const { behind, ahead } = twoClones();
    sh(behind, ['git', 'checkout', '-qb', 'elsewhere']);
    const before = await headSha(behind);

    const result = await syncBase(behind, 'main');
    expect(result.ok).toBe(true);
    expect(result.status.state).toBe('current');
    expect(sh(behind, ['git', 'rev-parse', 'main']).trim()).toBe(await headSha(ahead));
    expect(await currentBranch(behind)).toBe('elsewhere');
    expect(await headSha(behind)).toBe(before);
  });

  it('is a no-op when already current', async () => {
    const { repo } = scratchRepoWithOrigin();
    const before = await headSha(repo);
    const result = await syncBase(repo, 'main');
    expect(result.ok).toBe(true);
    expect(result.status.state).toBe('current');
    expect(await headSha(repo)).toBe(before);
  });

  it('refuses to rewrite a diverged base', async () => {
    const { behind } = twoClones();
    writeFileSync(join(behind, 'local.txt'), 'also here\n');
    sh(behind, ['git', 'add', '-A']);
    sh(behind, ['git', 'commit', '-qm', 'local only']);
    const before = await headSha(behind);

    const result = await syncBase(behind, 'main');
    expect(result.ok).toBe(false);
    expect(result.status.state).toBe('diverged');
    expect(result.status.detail).toMatch(/only fast-forwards/);
    expect(await headSha(behind)).toBe(before);
  });
});
