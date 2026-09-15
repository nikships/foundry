/**
 * GitLab CLI surface: detection/auth and a representative MR create path,
 * mirrored from gh.test.ts so the two forge CLIs stay in lockstep.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { makeFakeGlab } from '../../helpers/fake-glab.js';
import { glabStatus, openMr } from '../../../src/main/system/glab.js';
import * as worktree from '../../../src/main/engine/worktree.js';

const TOKEN_KEYS = ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN'] as const;
const saved: Record<string, string | undefined> = {};

function clearGitlabTokens(): void {
  for (const key of TOKEN_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreGitlabTokens(): void {
  for (const key of TOKEN_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(restoreGitlabTokens);

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchRepoWithOrigin(): { repo: string; bare: string } {
  const dir = tempDir('foundry-glab-');
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

async function runBranch(repo: string, runId: string) {
  const handle = await worktree.create({ repo, runId, baseRef: 'main' });
  writeFileSync(join(handle.path, 'work.txt'), `work in ${runId}\n`);
  sh(handle.path, ['git', 'add', '-A']);
  sh(handle.path, ['git', 'commit', '-qm', `work in ${runId}`]);
  return handle;
}

describe('glabStatus', () => {
  it('reports glab missing when the binary does not run', async () => {
    clearGitlabTokens();
    const { repo } = scratchRepoWithOrigin();
    const status = await glabStatus(repo, { bin: join(repo, 'no-such-glab') });
    expect(status.available).toBe(false);
    expect(status.detail).toContain('not installed');
    expect(status.cli).toBe('glab');
  });

  it('reports not signed in when neither login nor token is present', async () => {
    clearGitlabTokens();
    const { repo } = scratchRepoWithOrigin();
    const glab = makeFakeGlab({ authed: false });
    const status = await glabStatus(repo, { bin: glab.bin });
    expect(status.available).toBe(false);
    expect(status.detail).toContain('glab auth login');
  });

  it('passes auth when GITLAB_TOKEN is set even if auth status fails', async () => {
    clearGitlabTokens();
    const { repo } = scratchRepoWithOrigin();
    const glab = makeFakeGlab({
      authed: false,
      repoView: { path_with_namespace: 'acme/widgets' },
    });
    process.env.GITLAB_TOKEN = 'glpat-test-token';
    const status = await glabStatus(repo, { bin: glab.bin });
    expect(status.available).toBe(true);
    expect(status.repo).toBe('acme/widgets');
    expect(status.cli).toBe('glab');
  });

  it('resolves the project path when everything is in place', async () => {
    clearGitlabTokens();
    const { repo } = scratchRepoWithOrigin();
    const glab = makeFakeGlab({ repoView: { path_with_namespace: 'group/project' } });
    const status = await glabStatus(repo, { bin: glab.bin });
    expect(status.available).toBe(true);
    expect(status.repo).toBe('group/project');
  });
});

describe('openMr', () => {
  it('pushes the branch before asking glab to create', async () => {
    clearGitlabTokens();
    const { repo, bare } = scratchRepoWithOrigin();
    const handle = await runBranch(repo, 'run_mr1');
    const glab = makeFakeGlab({
      createUrl: 'https://gitlab.com/acme/widgets/-/merge_requests/7',
    });

    const result = await openMr(
      repo,
      { branch: handle.branch, baseRef: 'main', title: 'add work', body: 'body' },
      { bin: glab.bin },
    );

    expect(result.ok).toBe(true);
    expect(result.number).toBe(7);
    expect(result.url).toContain('/merge_requests/7');
    const remoteSha = sh(bare, ['git', 'rev-parse', `refs/heads/${handle.branch}`]).trim();
    expect(remoteSha).toBe(sh(handle.path, ['git', 'rev-parse', 'HEAD']).trim());
    const create = glab.calls().find((argv) => argv[0] === 'mr' && argv[1] === 'create');
    expect(create).toBeDefined();
    expect(create).toContain('--source-branch');
    expect(create).toContain(handle.branch);
    expect(create).toContain('--target-branch');
    expect(create).toContain('main');
  });
});
