import { describe, expect, it } from 'vitest';
import {
  ALWAYS_PROTECTED,
  describeBoundary,
  isAllowed,
  isProtected,
  matchesPattern,
} from '../src/main/engine/boundary.js';

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
