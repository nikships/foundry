import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../helpers/tmp.js';
import { makeFakeGh } from '../../helpers/fake-gh.js';
import { makeFakeGlab } from '../../helpers/fake-glab.js';
import {
  classifyRemoteUrl,
  resolveForge,
  scmStatus,
  setForgePreferenceProvider,
} from '../../../src/main/system/forge.js';

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

afterEach(() => {
  setForgePreferenceProvider(null);
});

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

  it('defaults unknown hosts to GitHub', () => {
    expect(classifyRemoteUrl('git@git.company.internal:acme/widgets.git')).toBe('github');
    expect(classifyRemoteUrl('https://git.example.com/acme/widgets.git')).toBe('github');
    expect(classifyRemoteUrl('')).toBe('github');
  });
});

describe('resolveForge', () => {
  it('honors an explicit GitLab preference over a GitHub remote', async () => {
    const repo = scratchWithRemote('git@github.com:acme/widgets.git');
    expect(await resolveForge(repo, 'gitlab')).toBe('gitlab');
  });

  it('honors an explicit GitHub preference over a GitLab remote', async () => {
    const repo = scratchWithRemote('git@gitlab.com:acme/widgets.git');
    expect(await resolveForge(repo, 'github')).toBe('github');
  });

  it('classifies from the remote when preference is auto', async () => {
    const github = scratchWithRemote('git@github.com:acme/widgets.git');
    const gitlab = scratchWithRemote('git@gitlab.com:acme/widgets.git');
    const unknown = scratchWithRemote('git@git.company.internal:acme/widgets.git');
    expect(await resolveForge(github, 'auto')).toBe('github');
    expect(await resolveForge(gitlab, 'auto')).toBe('gitlab');
    expect(await resolveForge(unknown, 'auto')).toBe('github');
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

  it('forces glab when preference is gitlab, even on a GitHub remote', async () => {
    const repo = scratchWithRemote('git@github.com:acme/widgets.git');
    const glab = makeFakeGlab({ repoView: { path_with_namespace: 'acme/widgets' } });
    const status = await scmStatus(repo, {
      preference: 'gitlab',
      gh: { bin: join(repo, 'no-gh') },
      glab: { bin: glab.bin },
    });
    expect(status.available).toBe(true);
    expect(status.cli).toBe('glab');
  });

  it('reports glab when preference is gitlab even if glab is missing', async () => {
    const repo = scratchWithRemote('git@git.company.internal:acme/widgets.git');
    const status = await scmStatus(repo, {
      preference: 'gitlab',
      gh: { bin: join(repo, 'no-gh') },
      glab: { bin: join(repo, 'no-glab') },
    });
    expect(status.available).toBe(false);
    expect(status.cli).toBe('glab');
    expect(status.detail.toLowerCase()).toContain('gitlab');
  });

  it('reads the injected app preference when no per-call override is given', async () => {
    const repo = scratchWithRemote('git@github.com:acme/widgets.git');
    const glab = makeFakeGlab({ repoView: { path_with_namespace: 'acme/widgets' } });
    setForgePreferenceProvider(() => 'gitlab');
    const status = await scmStatus(repo, {
      gh: { bin: join(repo, 'no-gh') },
      glab: { bin: glab.bin },
    });
    expect(status.cli).toBe('glab');
  });
});
