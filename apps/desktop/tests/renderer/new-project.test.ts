/**
 * Creating a repository from Foundry, against a fake gh that really does
 * `git init` + a commit for `--clone`. What these pin down: private means the
 * flag actually reaches gh (a repo the operator asked to keep private must
 * never be created public because a default changed), a clone Foundry cannot
 * branch from is a failure rather than a success, and nothing is created when
 * the destination is already occupied.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from '../helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import { createRepo, githubAccount, repoNameIssue } from '../../src/main/system/gh.js';
import { currentBranch, isRepo, refExists } from '../../src/main/engine/git.js';
import { makeFakeGh } from '../helpers/fake-gh.js';

function parentDir(): string {
  return tempDir('foundry-newproject-');
}

describe('repoNameIssue', () => {
  it('accepts the names GitHub accepts', () => {
    for (const name of ['my-service', 'app_2', 'dot.name', 'A']) {
      expect(repoNameIssue(name)).toBeNull();
    }
  });

  it('refuses names that would not be a repository', () => {
    expect(repoNameIssue('')).toContain('needs a name');
    expect(repoNameIssue('   ')).toContain('needs a name');
    expect(repoNameIssue('with space')).toContain('letters, numbers');
    expect(repoNameIssue('slash/name')).toContain('letters, numbers');
    // Character-class-legal, but names the parent directory rather than a new one.
    expect(repoNameIssue('.')).toContain('not a repository name');
    expect(repoNameIssue('..')).toContain('not a repository name');
    expect(repoNameIssue('x'.repeat(101))).toContain('letters, numbers');
  });
});

describe('githubAccount', () => {
  it('reports gh missing before blaming the account', async () => {
    const account = await githubAccount({ bin: join(parentDir(), 'no-such-gh') });
    expect(account.available).toBe(false);
    expect(account.detail).toContain('not installed');
  });

  it('reports signed out before asking who the user is', async () => {
    const gh = makeFakeGh({ authed: false, login: 'nik' });
    const account = await githubAccount({ bin: gh.bin });
    expect(account.available).toBe(false);
    expect(account.detail).toContain('gh auth login');
    expect(gh.calls().some((argv) => argv[0] === 'api')).toBe(false);
  });

  it('offers the login first, then its orgs', async () => {
    const gh = makeFakeGh({ login: 'nik', orgs: ['acme', 'widgets'] });
    const account = await githubAccount({ bin: gh.bin });
    expect(account.available).toBe(true);
    expect(account.login).toBe('nik');
    expect(account.owners).toEqual(['nik', 'acme', 'widgets']);
  });

  it('stays usable when orgs cannot be listed', async () => {
    // No orgs configured is the same shape as a token without the org scope:
    // the account is still perfectly able to create under its own login.
    const gh = makeFakeGh({ login: 'nik' });
    const account = await githubAccount({ bin: gh.bin });
    expect(account.available).toBe(true);
    expect(account.owners).toEqual(['nik']);
  });
});

describe('createRepo', () => {
  it('passes --private and clones a repo Foundry can branch from', async () => {
    const dir = parentDir();
    const gh = makeFakeGh({ login: 'nik' });

    const result = await createRepo(
      { name: 'my-service', owner: 'nik', visibility: 'private', parentDir: dir },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(true);
    expect(result.nameWithOwner).toBe('nik/my-service');
    expect(result.path).toBe(join(dir, 'my-service'));
    expect(result.url).toBe('https://github.com/nik/my-service');

    const create = gh.calls().find((argv) => argv[0] === 'repo' && argv[1] === 'create');
    expect(create).toContain('--private');
    expect(create).not.toContain('--public');
    // A repo with no commits has no HEAD, and `git worktree add` refuses it, so
    // every run would die at isolation. The README commit is load-bearing.
    expect(create).toContain('--add-readme');

    const path = result.path!;
    expect(await isRepo(path)).toBe(true);
    expect(await refExists(path, 'HEAD')).toBe(true);
    expect(await currentBranch(path)).toBe('main');
  });

  it('passes --public only when public was chosen', async () => {
    const dir = parentDir();
    const gh = makeFakeGh({ login: 'nik' });
    const result = await createRepo(
      { name: 'open-source', visibility: 'public', parentDir: dir },
      { bin: gh.bin },
    );
    expect(result.ok).toBe(true);
    const create = gh.calls().find((argv) => argv[0] === 'repo' && argv[1] === 'create');
    expect(create).toContain('--public');
    expect(create).not.toContain('--private');
    // No owner given: gh defaults to the signed-in login, so the bare name goes.
    expect(create?.[2]).toBe('open-source');
  });

  it('sends a description only when one was written', async () => {
    const dir = parentDir();
    const gh = makeFakeGh({ login: 'nik' });

    await createRepo(
      { name: 'with-desc', visibility: 'private', description: 'a thing', parentDir: dir },
      { bin: gh.bin },
    );
    await createRepo({ name: 'no-desc', visibility: 'private', parentDir: dir }, { bin: gh.bin });

    const creates = gh.calls().filter((argv) => argv[0] === 'repo' && argv[1] === 'create');
    expect(creates[0]).toContain('--description');
    expect(creates[0]).toContain('a thing');
    expect(creates[1]).not.toContain('--description');
  });

  it('refuses a bad name before spending a network call', async () => {
    const gh = makeFakeGh({ login: 'nik' });
    const result = await createRepo(
      { name: 'not a name', visibility: 'private', parentDir: parentDir() },
      { bin: gh.bin },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('letters, numbers');
    expect(gh.calls()).toEqual([]);
  });

  it('refuses to clone over an existing directory', async () => {
    const dir = parentDir();
    mkdirSync(join(dir, 'taken'));
    writeFileSync(join(dir, 'taken', 'keep.txt'), 'existing work\n');
    const gh = makeFakeGh({ login: 'nik' });

    const result = await createRepo(
      { name: 'taken', visibility: 'private', parentDir: dir },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('already exists');
    expect(gh.calls()).toEqual([]);
    expect(existsSync(join(dir, 'taken', 'keep.txt'))).toBe(true);
  });

  it('refuses a parent folder that is not there', async () => {
    const gh = makeFakeGh({ login: 'nik' });
    const result = await createRepo(
      { name: 'ok-name', visibility: 'private', parentDir: join(tmpdir(), 'foundry-no-such-dir') },
      { bin: gh.bin },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('does not exist');
    expect(gh.calls()).toEqual([]);
  });

  it("surfaces gh's own reason when GitHub refuses", async () => {
    const dir = parentDir();
    const gh = makeFakeGh({
      login: 'nik',
      repoCreateError: 'GraphQL: Name already exists on this account (createRepository)',
    });

    const result = await createRepo(
      { name: 'duplicate', visibility: 'private', parentDir: dir },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Name already exists');
    expect(existsSync(join(dir, 'duplicate'))).toBe(false);
  });

  it('reports a failure when gh exits 0 but no clone lands', async () => {
    const dir = parentDir();
    // The remote repo exists and gh is happy; the clone is what failed. Trusting
    // the exit code here would register a project pointing at nothing.
    const gh = makeFakeGh({ login: 'nik', cloneSilentlyFails: true });

    const result = await createRepo(
      { name: 'ghosted', visibility: 'private', parentDir: dir },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no clone landed');
    expect(result.nameWithOwner).toBe('ghosted');
    expect(existsSync(join(dir, 'ghosted'))).toBe(false);
  });
});
