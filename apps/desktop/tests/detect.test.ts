import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDetectReply, sniffCommands } from '../src/main/engine/detect.js';

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-detect-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'x', scripts });

const argvFor = async (dir: string, role: string): Promise<string[] | undefined> =>
  (await sniffCommands(dir)).find((c) => c.name === role)?.argv;

describe('sniffCommands: node', () => {
  it('finds test, lint, typecheck, and build from package.json scripts', async () => {
    const dir = repo({
      'package.json': pkg({
        test: 'vitest run',
        lint: 'eslint .',
        typecheck: 'tsc --noEmit',
        build: 'vite build',
      }),
    });
    const found = await sniffCommands(dir);
    expect(found.map((c) => c.name)).toEqual(['test', 'lint', 'typecheck', 'build']);
    expect(found.every((c) => c.source === 'package.json')).toBe(true);
  });

  it('omits a role the repo has no script for rather than inventing one', async () => {
    const dir = repo({ 'package.json': pkg({ test: 'vitest run' }) });
    expect((await sniffCommands(dir)).map((c) => c.name)).toEqual(['test']);
  });

  it('uses `npm test` bare but `npm run` for every other script', async () => {
    const dir = repo({ 'package.json': pkg({ test: 'vitest run', build: 'vite build' }) });
    expect(await argvFor(dir, 'test')).toEqual(['npm', 'test']);
    expect(await argvFor(dir, 'build')).toEqual(['npm', 'run', 'build']);
  });

  it('switches runner on the lockfile, since npm can resolve a different tree', async () => {
    const scripts = pkg({ test: 'vitest run' });
    expect(await argvFor(repo({ 'package.json': scripts, 'pnpm-lock.yaml': '' }), 'test')).toEqual([
      'pnpm',
      'test',
    ]);
    expect(await argvFor(repo({ 'package.json': scripts, 'yarn.lock': '' }), 'test')).toEqual([
      'yarn',
      'test',
    ]);
    expect(await argvFor(repo({ 'package.json': scripts, 'bun.lockb': '' }), 'test')).toEqual([
      'bun',
      'test',
    ]);
  });

  it('accepts an aliased script name', async () => {
    const dir = repo({ 'package.json': pkg({ vitest: 'vitest run', 'type-check': 'tsc' }) });
    expect(await argvFor(dir, 'test')).toEqual(['npm', 'run', 'vitest']);
    expect(await argvFor(dir, 'typecheck')).toEqual(['npm', 'run', 'type-check']);
  });

  it('returns nothing for a package.json with no scripts at all', async () => {
    expect(await sniffCommands(repo({ 'package.json': '{"name":"x"}' }))).toEqual([]);
  });

  it('survives a package.json that does not parse', async () => {
    expect(await sniffCommands(repo({ 'package.json': '{not json' }))).toEqual([]);
  });
});

describe('sniffCommands: other ecosystems', () => {
  it('reads cargo, go, gradle, and swift manifests', async () => {
    expect(await argvFor(repo({ 'Cargo.toml': '[package]\nname="x"\n' }), 'test')).toEqual([
      'cargo',
      'test',
    ]);
    expect(await argvFor(repo({ 'go.mod': 'module x\n' }), 'test')).toEqual([
      'go',
      'test',
      './...',
    ]);
    expect(await argvFor(repo({ 'build.gradle': '' }), 'test')).toEqual(['gradle', 'test']);
    expect(await argvFor(repo({ 'Package.swift': '' }), 'test')).toEqual(['swift', 'test']);
  });

  it('prefers the gradle wrapper over a bare gradle on PATH', async () => {
    const dir = repo({ 'build.gradle': '', gradlew: '#!/bin/sh\n' });
    expect(await argvFor(dir, 'test')).toEqual(['./gradlew', 'test']);
  });

  it('prefixes pytest with uv run only when uv manages the environment', async () => {
    expect(await argvFor(repo({ 'pyproject.toml': '[project]\nname="x"\n' }), 'test')).toEqual([
      'pytest',
    ]);
    const managed = repo({ 'pyproject.toml': '[project]\nname="x"\n', 'uv.lock': '' });
    expect(await argvFor(managed, 'test')).toEqual(['uv', 'run', 'pytest']);
  });

  it('reads Makefile targets but ignores .PHONY and pattern rules', async () => {
    const dir = repo({ Makefile: '.PHONY: test\n\ntest:\n\tgo test ./...\n\n%.o: %.c\n\tcc $<\n' });
    const found = await sniffCommands(dir);
    expect(found.map((c) => c.argv)).toEqual([['make', 'test']]);
  });

  it('does not treat a make variable assignment as a target', async () => {
    expect(await sniffCommands(repo({ Makefile: 'test := yes\n' }))).toEqual([]);
  });

  it('lets package.json win over an incidental Makefile', async () => {
    const dir = repo({
      'package.json': pkg({ test: 'vitest run' }),
      Makefile: 'test:\n\techo no\n',
    });
    expect(await argvFor(dir, 'test')).toEqual(['npm', 'test']);
  });

  it('returns nothing for a repo with no manifest, which is what triggers the agent', async () => {
    expect(await sniffCommands(repo({ 'README.md': '# hi\n' }))).toEqual([]);
  });
});

describe('parseDetectReply', () => {
  const reply = (commands: unknown): string => JSON.stringify({ commands });

  it('reads commands out of a reply wrapped in prose', async () => {
    const text = `Here is what I found:\n${reply([{ name: 'test', argv: ['npm', 'test'], source: 'package.json' }])}\nHope that helps.`;
    expect(parseDetectReply(text)).toEqual([
      { name: 'test', argv: ['npm', 'test'], source: 'package.json' },
    ]);
  });

  it('drops a command carrying a shell operator, since the argv is executed later', () => {
    expect(
      parseDetectReply(reply([{ name: 'test', argv: ['npm', 'test', '&&', 'lint'] }])),
    ).toEqual([]);
    expect(parseDetectReply(reply([{ name: 'test', argv: ['cd', 'sub'] }]))).toEqual([]);
    expect(parseDetectReply(reply([{ name: 'test', argv: ['sh', '-c', 'a | b'] }]))).toEqual([]);
  });

  it('drops a role no pipeline can reference', () => {
    expect(parseDetectReply(reply([{ name: 'deploy', argv: ['./deploy.sh'] }]))).toEqual([]);
  });

  it('keeps the first entry when a role is repeated', () => {
    const out = parseDetectReply(
      reply([
        { name: 'test', argv: ['npm', 'test'] },
        { name: 'test', argv: ['make', 'test'] },
      ]),
    );
    expect(out).toEqual([{ name: 'test', argv: ['npm', 'test'], source: 'agent' }]);
  });

  it('drops an entry with an empty or non-string argv', () => {
    expect(parseDetectReply(reply([{ name: 'test', argv: [] }]))).toEqual([]);
    expect(parseDetectReply(reply([{ name: 'test', argv: ['npm', 7] }]))).toEqual([]);
    expect(parseDetectReply(reply([{ name: 'test' }]))).toEqual([]);
  });

  it('treats an empty list and unparseable prose alike, as no answer', () => {
    expect(parseDetectReply(reply([]))).toEqual([]);
    expect(parseDetectReply('I could not find any test command.')).toEqual([]);
    expect(parseDetectReply('{ definitely not json')).toEqual([]);
  });

  it('returns roles in pipeline order regardless of the order the agent listed them', () => {
    const out = parseDetectReply(
      reply([
        { name: 'build', argv: ['npm', 'run', 'build'] },
        { name: 'test', argv: ['npm', 'test'] },
      ]),
    );
    expect(out.map((c) => c.name)).toEqual(['test', 'build']);
  });
});
