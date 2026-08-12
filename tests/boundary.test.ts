import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALWAYS_PROTECTED,
  describeBoundary,
  isAllowed,
  isProtected,
  matchesPattern,
  snapshot,
} from '../src/main/engine/boundary.js';
import { resolveRef } from '../src/main/engine/git.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-boundary-'));
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# boundary\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('pattern matching', () => {
  it('treats a trailing slash as a directory prefix', () => {
    expect(matchesPattern('specs/plan.md', 'specs/')).toBe(true);
    expect(matchesPattern('specs', 'specs/')).toBe(true);
    expect(matchesPattern('specsuffix/x.md', 'specs/')).toBe(false);
  });

  it('treats a bare path as itself or a directory', () => {
    expect(matchesPattern('docs/a.md', 'docs')).toBe(true);
    expect(matchesPattern('docs2/a.md', 'docs')).toBe(false);
    expect(matchesPattern('README.md', 'README.md')).toBe(true);
  });

  it('keeps a single star inside one segment', () => {
    expect(matchesPattern('src/a.ts', 'src/*.ts')).toBe(true);
    expect(matchesPattern('src/deep/a.ts', 'src/*.ts')).toBe(false);
  });

  it('lets a double star cross segments', () => {
    expect(matchesPattern('src/deep/nested/a.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesPattern('src/a.ts', 'src/**')).toBe(true);
  });

  it('normalises a leading ./', () => {
    expect(matchesPattern('./src/a.ts', 'src/')).toBe(true);
  });
});

describe('protected paths', () => {
  it('always protects the app and git internals', () => {
    expect(ALWAYS_PROTECTED).toContain('.git/');
    expect(isProtected('.git/config')).toBe(true);
    expect(isProtected('.foundry/project.json')).toBe(true);
    expect(isProtected('.foundry-worktrees/run_1/x')).toBe(true);
  });

  it('adds the project-specific protected list', () => {
    expect(isProtected('infra/prod.tf', ['infra/'])).toBe(true);
    expect(isProtected('src/a.ts', ['infra/'])).toBe(false);
  });
});

describe('write boundary semantics', () => {
  it('null means unrestricted except protected paths', () => {
    expect(isAllowed('anything/at/all.ts', null)).toBe(true);
    expect(isAllowed('.git/hooks/pre-commit', null)).toBe(false);
  });

  it('an empty list means read-only', () => {
    expect(isAllowed('src/a.ts', [])).toBe(false);
    expect(isAllowed('README.md', [])).toBe(false);
  });

  it('a list is an allowlist', () => {
    const writes = ['specs/', 'docs/**'];
    expect(isAllowed('specs/plan.md', writes)).toBe(true);
    expect(isAllowed('docs/deep/x.md', writes)).toBe(true);
    expect(isAllowed('src/a.ts', writes)).toBe(false);
  });

  it('protection beats an explicit allow', () => {
    expect(isAllowed('.git/config', ['.git/'])).toBe(false);
  });

  it('describes each of the three states for the UI', () => {
    expect(describeBoundary(null)).toContain('unrestricted');
    expect(describeBoundary([])).toBe('read-only');
    expect(describeBoundary(['specs/'])).toBe('specs/');
  });
});

describe('phase-start snapshot', () => {
  it('captures HEAD SHA and per-file content hash and size for changed files only', async () => {
    const dir = tempRepo();
    const head = await resolveRef(dir, 'HEAD');
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    // Seed two dirty files after the commit so the snapshot has real content to hash.
    const trackedBody = 'phase-start tracked body\n';
    const untrackedBody = 'phase-start untracked body\n';
    writeFileSync(join(dir, 'README.md'), trackedBody);
    writeFileSync(join(dir, 'notes.txt'), untrackedBody);

    const snap = await snapshot(dir);

    expect(snap.headSha).toBe(head);
    expect(snap.paths.has('README.md')).toBe(true);
    expect(snap.paths.has('notes.txt')).toBe(true);
    // Only dirty paths — the clean tree is not walked.
    expect(snap.paths.has('.git')).toBe(false);

    const byPath = new Map(snap.files.map((f) => [f.path, f]));
    expect(byPath.get('README.md')).toEqual({
      path: 'README.md',
      contentHash: sha256(trackedBody),
      size: Buffer.byteLength(trackedBody),
    });
    expect(byPath.get('notes.txt')).toEqual({
      path: 'notes.txt',
      contentHash: sha256(untrackedBody),
      size: Buffer.byteLength(untrackedBody),
    });
    expect(snap.files).toHaveLength(2);
  });

  it('returns an empty files list and still records HEAD when the tree is clean', async () => {
    const dir = tempRepo();
    const head = await resolveRef(dir, 'HEAD');
    const snap = await snapshot(dir);

    expect(snap.headSha).toBe(head);
    expect(snap.paths.size).toBe(0);
    expect(snap.files).toEqual([]);
  });
});
