import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { makeFakeGh } from '../../helpers/fake-gh.js';
import { makeFakeGlab } from '../../helpers/fake-glab.js';
import { classifyRemoteUrl, scmStatus } from '../../../src/main/system/forge.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchWithRemote(url: string): string {
  const dir = tempDir('foundry-forge-');
  const repo = join(dir, 'repo');
  sh(dir, ['git', 'init', '-q', '-b', 'main', 'repo']);
  sh(repo, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(repo, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  sh(repo, ['git', 'add', '-A']);
  sh(repo, ['git', 'commit', '-qm', 'initial']);
  sh(repo, ['git', 'remote', 'add', 'origin', url]);
  return repo;
}

describe('classifyRemoteUrl', () => {
  it('recognises GitHub hosts', () => {
    expect(classifyRemoteUrl('git@github.com:acme/widgets.git')).toBe('github');
    expect(classifyRemoteUrl('https://github.com/acme/widgets.git')).toBe('github');
    expect(classifyRemoteUrl('https://github.example.com/acme/widgets')).toBe('github');
  });

  it('recognises GitLab hosts', () => {
    expect(classifyRemoteUrl('git@gitlab.com:acme/widgets.git')).toBe('gitlab');
    expect(classifyRemoteUrl('https://gitlab.com/acme/widgets.git')).toBe('gitlab');
    expect(classifyRemoteUrl('https://gitlab.example.com/acme/widgets')).toBe('gitlab');
    expect(classifyRemoteUrl('tom@salsa.debian.org:group/pkg.git')).toBe('gitlab');
  });
});

describe('scmStatus', () => {
  it('routes GitHub remotes to gh', async () => {
    const repo = scratchWithRemote('git@github.com:acme/widgets.git');
    const gh = makeFakeGh({ repoView: { nameWithOwner: 'acme/widgets' } });
    const status = await scmStatus(repo, {
      gh: { bin: gh.bin },
      glab: { bin: join(repo, 'no-glab') },
    });
    expect(status.available).toBe(true);
    expect(status.cli).toBe('gh');
    expect(status.repo).toBe('acme/widgets');
  });

  it('routes GitLab remotes to glab', async () => {
    const repo = scratchWithRemote('git@gitlab.com:acme/widgets.git');
    const glab = makeFakeGlab({ repoView: { path_with_namespace: 'acme/widgets' } });
    const status = await scmStatus(repo, {
      gh: { bin: join(repo, 'no-gh') },
      glab: { bin: glab.bin },
    });
    expect(status.available).toBe(true);
    expect(status.cli).toBe('glab');
    expect(status.repo).toBe('acme/widgets');
  });
});
