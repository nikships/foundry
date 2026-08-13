import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import { describe, expect, it } from 'vitest';
import { detectStack, evaluateRepo } from '../src/main/readiness/evaluate.js';
import { indexRepo } from '../src/main/readiness/evaluate.js';

function scratch(prefix: string): string {
  return tempDir(prefix);
}

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function byId(root: string, id: string) {
  return evaluateRepo(root).criteria.find((c) => c.id === id);
}

describe('language-aware readiness evaluation', () => {
  it('fails an empty tree on the required file-based criteria', () => {
    const root = scratch('foundry-ready-empty-');
    const result = evaluateRepo(root);
    expect(result.ready).toBe(false);
    expect(byId(root, 'agents_md')?.status).toBe('fail');
    expect(byId(root, 'ci_parity')?.status).toBe('fail');
    expect(byId(root, 'templates')?.status).toBe('fail');
    expect(byId(root, 'precommit')?.status).toBe('fail');
  });

  it('detects a TypeScript monorepo from workspaces and tsconfig', () => {
    const root = scratch('foundry-ready-mono-');
    write(
      root,
      'package.json',
      JSON.stringify({
        name: 'mono',
        workspaces: ['apps/*'],
        devDependencies: { typescript: '5.0.0' },
      }),
    );
    write(root, 'tsconfig.json', '{}\n');
    write(root, 'apps/web/package.json', JSON.stringify({ name: 'web' }));
    const stack = detectStack(root, indexRepo(root));
    expect(stack.languages).toContain('typescript');
    expect(stack.monorepo).toBe(true);
    expect(stack.packages).toContain('apps/web');
  });

  it('marks typecheck n/a for a Python repo without a type policy', () => {
    const root = scratch('foundry-ready-py-');
    write(root, 'pyproject.toml', '[project]\nname = "demo"\n');
    expect(byId(root, 'typecheck')?.status).toBe('n/a');
  });

  it('passes typecheck when mypy is configured', () => {
    const root = scratch('foundry-ready-mypy-');
    write(root, 'pyproject.toml', '[tool.mypy]\nstrict = true\n');
    expect(byId(root, 'typecheck')?.status).toBe('pass');
  });

  it('requires .env.example only when an env file exists', () => {
    const root = scratch('foundry-ready-env-');
    expect(byId(root, 'env_example')?.status).toBe('n/a');
    write(root, '.env', 'SECRET=1\n');
    expect(byId(root, 'env_example')?.status).toBe('fail');
    write(root, '.env.example', 'SECRET=\n');
    expect(byId(root, 'env_example')?.status).toBe('pass');
  });

  it('passes CI parity when workflows mention local scripts', () => {
    const root = scratch('foundry-ready-ci-');
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }));
    write(root, '.github/workflows/ci.yml', 'run: npm test\nrun: npm run lint\n');
    expect(byId(root, 'ci_parity')?.status).toBe('pass');
  });

  it('fails CI parity when workflows ignore documented local checks', () => {
    const root = scratch('foundry-ready-ci-miss-');
    write(root, 'package.json', JSON.stringify({ scripts: { test: 'vitest', lint: 'eslint .' } }));
    write(root, '.github/workflows/ci.yml', 'run: echo hello\n');
    expect(byId(root, 'ci_parity')?.status).toBe('fail');
  });

  it('treats coverage as n/a until tests exist, then requires a threshold', () => {
    const root = scratch('foundry-ready-cov-');
    expect(byId(root, 'coverage')?.status).toBe('n/a');
    write(root, 'src/math.test.ts', 'test("add", () => {});\n');
    expect(byId(root, 'tests')?.status).toBe('pass');
    expect(byId(root, 'coverage')?.status).toBe('fail');
    write(
      root,
      'vitest.config.ts',
      'export default { test: { coverage: { thresholds: { lines: 70 } } } }\n',
    );
    expect(byId(root, 'coverage')?.status).toBe('pass');
  });

  it('passes AGENTS.md and notes a monorepo without nested files', () => {
    const root = scratch('foundry-ready-agents-');
    write(root, 'package.json', JSON.stringify({ workspaces: ['packages/*'] }));
    write(root, 'packages/a/package.json', JSON.stringify({ name: 'a' }));
    write(root, 'AGENTS.md', '# Agents\n');
    const crit = byId(root, 'agents_md');
    expect(crit?.status).toBe('pass');
    expect(crit?.notes).toMatch(/nested/i);
  });
});
