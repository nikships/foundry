/**
 * Create-project forge routing: Auto/GitHub → gh, GitLab → glab, plus gitlab
 * account/create against fake glab (parallel to new-project gh coverage).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { makeFakeGh } from '../../helpers/fake-gh.js';
import { makeFakeGlab } from '../../helpers/fake-glab.js';
import { currentBranch, isRepo, refExists } from '../../../src/main/engine/git.js';
import { setForgePreferenceProvider } from '../../../src/main/system/forge.js';
import {
  createForgeRepo,
  createGitlabRepo,
  forgeAccount,
  gitlabAccount,
  resolveCreateForge,
} from '../../../src/main/system/forge-create.js';

afterEach(() => {
  setForgePreferenceProvider(null);
  delete process.env.GITLAB_TOKEN;
  delete process.env.GH_TOKEN;
});

function parentDir(): string {
  return tempDir('foundry-forge-create-');
}

describe('resolveCreateForge', () => {
  it('maps auto and github to github; gitlab stays gitlab', () => {
    expect(resolveCreateForge('auto')).toBe('github');
    expect(resolveCreateForge('github')).toBe('github');
    expect(resolveCreateForge('gitlab')).toBe('gitlab');
  });
});

describe('gitlabAccount', () => {
  it('reports glab missing before blaming the account', async () => {
    const account = await gitlabAccount({ bin: join(parentDir(), 'no-such-glab') });
    expect(account.available).toBe(false);
    expect(account.detail).toContain('not installed');
    expect(account.provider).toBe('gitlab');
  });

  it('reports signed out before asking who the user is', async () => {
    const glab = makeFakeGlab({ authed: false, username: 'nik' });
    const account = await gitlabAccount({ bin: glab.bin });
    expect(account.available).toBe(false);
    expect(account.detail).toContain('glab auth login');
    expect(glab.calls().some((argv) => argv[0] === 'api')).toBe(false);
  });

  it('calls api user when auth status fails but GITLAB_TOKEN is set', async () => {
    const glab = makeFakeGlab({ authed: false, username: 'nik', groups: ['acme'] });
    process.env.GITLAB_TOKEN = 'glpat_test';
    const account = await gitlabAccount({ bin: glab.bin });
    expect(account.available).toBe(true);
    expect(account.login).toBe('nik');
    expect(account.owners).toEqual(['nik', 'acme']);
    expect(account.provider).toBe('gitlab');
    expect(glab.calls().some((argv) => argv[0] === 'api' && argv[1] === 'user')).toBe(true);
  });

  it('offers the login first, then its groups', async () => {
    const glab = makeFakeGlab({ username: 'nik', groups: ['acme', 'widgets'] });
    const account = await gitlabAccount({ bin: glab.bin });
    expect(account.available).toBe(true);
    expect(account.owners).toEqual(['nik', 'acme', 'widgets']);
    expect(account.host).toBe('gitlab.com');
  });
});

describe('createGitlabRepo', () => {
  it('passes --private --readme and clones a repo Foundry can branch from', async () => {
    const dir = parentDir();
    const glab = makeFakeGlab({ username: 'nik' });
    const result = await createGitlabRepo(
      { name: 'my-service', owner: 'nik', visibility: 'private', parentDir: dir },
      { bin: glab.bin },
    );
    expect(result.ok).toBe(true);
    expect(result.nameWithOwner).toBe('nik/my-service');
    expect(result.path).toBe(join(dir, 'my-service'));
    expect(result.url).toBe('https://gitlab.com/nik/my-service');

    const create = glab.calls().find((argv) => argv[0] === 'repo' && argv[1] === 'create');
    expect(create).toContain('--private');
    expect(create).toContain('--readme');
    expect(create).not.toContain('--public');

    const path = result.path!;
    expect(await isRepo(path)).toBe(true);
    expect(await refExists(path, 'HEAD')).toBe(true);
    expect(await currentBranch(path)).toBe('main');
  });

  it('passes --public only when public was chosen', async () => {
    const dir = parentDir();
    const glab = makeFakeGlab({ username: 'nik' });
    const result = await createGitlabRepo(
      { name: 'open-source', visibility: 'public', parentDir: dir },
      { bin: glab.bin },
    );
    expect(result.ok).toBe(true);
    const create = glab.calls().find((argv) => argv[0] === 'repo' && argv[1] === 'create');
    expect(create).toContain('--public');
    expect(create).not.toContain('--private');
  });

  it('refuses to clone over an existing directory', async () => {
    const dir = parentDir();
    mkdirSync(join(dir, 'taken'));
    writeFileSync(join(dir, 'taken', 'keep.txt'), 'existing work\n');
    const glab = makeFakeGlab({ username: 'nik' });
    const result = await createGitlabRepo(
      { name: 'taken', visibility: 'private', parentDir: dir },
      { bin: glab.bin },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('already exists');
    expect(glab.calls()).toEqual([]);
    expect(existsSync(join(dir, 'taken', 'keep.txt'))).toBe(true);
  });

  it('reports a failure when glab exits 0 but no clone lands', async () => {
    const dir = parentDir();
    const glab = makeFakeGlab({ username: 'nik', cloneSilentlyFails: true });
    const result = await createGitlabRepo(
      { name: 'ghosted', visibility: 'private', parentDir: dir },
      { bin: glab.bin },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no clone landed');
    expect(existsSync(join(dir, 'ghosted'))).toBe(false);
  });
});

describe('forgeAccount / createForgeRepo preference routing', () => {
  it('auto and github use gh; gitlab uses glab', async () => {
    const gh = makeFakeGh({ login: 'nik' });
    const glab = makeFakeGlab({ username: 'nik' });

    const auto = await forgeAccount({
      preference: 'auto',
      gh: { bin: gh.bin },
      glab: { bin: glab.bin },
    });
    expect(auto.provider).toBe('github');
    expect(auto.login).toBe('nik');
    expect(glab.calls()).toEqual([]);

    const github = await forgeAccount({
      preference: 'github',
      gh: { bin: gh.bin },
      glab: { bin: glab.bin },
    });
    expect(github.provider).toBe('github');

    const gitlab = await forgeAccount({
      preference: 'gitlab',
      gh: { bin: gh.bin },
      glab: { bin: glab.bin },
    });
    expect(gitlab.provider).toBe('gitlab');
    expect(gitlab.login).toBe('nik');
  });

  it('createForgeRepo routes auto→gh and gitlab→glab', async () => {
    const dir = parentDir();
    const gh = makeFakeGh({ login: 'nik' });
    const glab = makeFakeGlab({ username: 'nik' });

    const viaAuto = await createForgeRepo(
      { name: 'from-auto', visibility: 'private', parentDir: dir },
      { preference: 'auto', gh: { bin: gh.bin }, glab: { bin: glab.bin } },
    );
    expect(viaAuto.ok).toBe(true);
    expect(viaAuto.url).toContain('github.com');
    expect(gh.calls().some((a) => a[0] === 'repo' && a[1] === 'create')).toBe(true);
    expect(glab.calls().some((a) => a[0] === 'repo' && a[1] === 'create')).toBe(false);

    const dir2 = parentDir();
    const viaGitlab = await createForgeRepo(
      { name: 'from-gitlab', visibility: 'private', parentDir: dir2 },
      { preference: 'gitlab', gh: { bin: gh.bin }, glab: { bin: glab.bin } },
    );
    expect(viaGitlab.ok).toBe(true);
    expect(viaGitlab.url).toContain('gitlab.com');
    expect(glab.calls().some((a) => a[0] === 'repo' && a[1] === 'create')).toBe(true);
  });

  it('honors the app preference provider when opts omit preference', async () => {
    setForgePreferenceProvider(() => 'gitlab');
    const glab = makeFakeGlab({ username: 'nik' });
    const gh = makeFakeGh({ login: 'other' });
    const account = await forgeAccount({ gh: { bin: gh.bin }, glab: { bin: glab.bin } });
    expect(account.provider).toBe('gitlab');
    expect(account.login).toBe('nik');
  });
});
