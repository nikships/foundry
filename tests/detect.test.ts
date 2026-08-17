import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from './tmp.js';
import { describe, expect, it } from 'vitest';
import {
  applyCommandDrifts,
  mergeCommandsFillMissing,
  parseCommandDrift,
  parseDetectReply,
  resolveRefCommand,
  sniffCommands,
} from '../src/main/engine/detect.js';

function repo(files: Record<string, string>): string {
  const dir = tempDir('foundry-detect-');
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
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
    // A bare Package.swift with no testTarget uses build as the test gate.
    expect(await argvFor(repo({ 'Package.swift': 'import PackageDescription\n' }), 'test')).toEqual(
      ['swift', 'build'],
    );
    expect(
      await argvFor(
        repo({
          'Package.swift':
            'import PackageDescription\nlet package = Package(name:"x", targets:[.testTarget(name:"t")])\n',
        }),
        'test',
      ),
    ).toEqual(['swift', 'test']);
  });

  it('finds a nested Swift package one directory down (mcp-panel shape)', async () => {
    const dir = repo({
      'MCPServerManager/Package.swift':
        'import PackageDescription\nlet package = Package(name:"App", targets:[.executableTarget(name:"App")])\n',
      'MCPServerManager.xcodeproj/project.pbxproj': '',
      '.swiftlint.yml': 'disabled_rules: []\n',
    });
    const found = await sniffCommands(dir);
    const byName = Object.fromEntries(found.map((c) => [c.name, c]));
    expect(byName.test?.argv).toEqual(['swift', 'build', '--package-path', 'MCPServerManager']);
    expect(byName.build?.argv[0]).toBe('swift');
    expect(byName.lint?.argv).toEqual(['swiftlint', 'lint', '--strict']);
  });

  it('merges fill-missing without clobbering existing names', () => {
    const next = mergeCommandsFillMissing(
      [{ name: 'test', argv: ['custom'] }],
      [
        { name: 'test', argv: ['npm', 'test'], source: 'package.json' },
        { name: 'lint', argv: ['npm', 'run', 'lint'], source: 'package.json' },
      ],
    );
    expect(next).toEqual([
      { name: 'test', argv: ['custom'] },
      { name: 'lint', argv: ['npm', 'run', 'lint'] },
    ]);
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

  it('reads commands out of a reply wrapped in prose', () => {
    const text = `Here is what I found:\n${reply([{ name: 'test', argv: ['npm', 'test'], source: 'package.json' }])}\nHope that helps.`;
    expect(parseDetectReply(text).commands).toEqual([
      { name: 'test', argv: ['npm', 'test'], source: 'package.json' },
    ]);
  });

  it('drops a command carrying a shell operator, since the argv is executed later', () => {
    for (const argv of [
      ['npm', 'test', '&&', 'lint'],
      ['cd', 'sub'],
      ['sh', '-c', 'a | b'],
    ]) {
      const out = parseDetectReply(reply([{ name: 'test', argv }]));
      expect(out.commands).toEqual([]);
      // Silently dropping these is what made a real answer read as "nothing
      // found"; the reason has to travel back to the UI.
      expect(out.rejected).toHaveLength(1);
      expect(out.rejected[0]!.reason).toMatch(/shell token/);
    }
  });

  it('accepts a name outside the four pipeline roles, since a command name is free-form', () => {
    const out = parseDetectReply(reply([{ name: 'e2e', argv: ['npm', 'run', 'e2e'] }]));
    expect(out.commands).toEqual([{ name: 'e2e', argv: ['npm', 'run', 'e2e'], source: 'agent' }]);
    expect(out.rejected).toEqual([]);
  });

  it('rejects a name that could not survive into a project command', () => {
    const out = parseDetectReply(reply([{ name: 'not a name!', argv: ['x'] }]));
    expect(out.commands).toEqual([]);
    expect(out.rejected[0]!.reason).toMatch(/not usable as a command name/);
  });

  it('keeps the first entry when a name is repeated, and says the duplicate was dropped', () => {
    const out = parseDetectReply(
      reply([
        { name: 'test', argv: ['npm', 'test'] },
        { name: 'test', argv: ['make', 'test'] },
      ]),
    );
    expect(out.commands).toEqual([{ name: 'test', argv: ['npm', 'test'], source: 'agent' }]);
    expect(out.rejected[0]!.reason).toMatch(/duplicate/);
  });

  it('drops an entry with an empty or non-string argv, with a reason each time', () => {
    for (const item of [
      { name: 'test', argv: [] },
      { name: 'test', argv: ['npm', 7] },
      { name: 'test' },
    ]) {
      const out = parseDetectReply(reply([item]));
      expect(out.commands).toEqual([]);
      expect(out.rejected).toHaveLength(1);
    }
  });

  it('distinguishes an empty answer from one that could not be read', () => {
    const empty = parseDetectReply(reply([]));
    expect(empty.commands).toEqual([]);
    expect(empty.parseError).toBeUndefined();

    expect(parseDetectReply('I could not find any test command.').parseError).toMatch(/no JSON/);
    // No closing brace at all, so there is nothing to even attempt to parse.
    expect(parseDetectReply('{ definitely not json').parseError).toMatch(/no JSON/);
    expect(parseDetectReply('{ definitely: not json }').parseError).toMatch(/not valid JSON/);
    expect(parseDetectReply('{"other":1}').parseError).toMatch(/no "commands" array/);
  });

  it('always retains the raw reply, so an unusable answer stays diagnosable', () => {
    const text = 'the repo has no tests';
    expect(parseDetectReply(text).rawReply).toBe(text);
  });

  it('returns the four roles first, then anything else the agent proposed', () => {
    const out = parseDetectReply(
      reply([
        { name: 'e2e', argv: ['npm', 'run', 'e2e'] },
        { name: 'build', argv: ['npm', 'run', 'build'] },
        { name: 'test', argv: ['npm', 'test'] },
      ]),
    );
    expect(out.commands.map((c) => c.name)).toEqual(['test', 'build', 'e2e']);
  });
});

describe('resolveRefCommand', () => {
  it('keeps the frozen argv when sniff agrees or has nothing to say', () => {
    const frozen = [{ name: 'test', argv: ['./check.sh'] }];
    expect(resolveRefCommand('test', frozen, [])).toEqual({
      ok: true,
      argv: ['./check.sh'],
      drifted: false,
    });
    expect(
      resolveRefCommand('test', frozen, [
        { name: 'test', argv: ['./check.sh'], source: 'check.sh' },
      ]),
    ).toMatchObject({ drifted: false, argv: ['./check.sh'] });
  });

  it('uses the worktree sniff when it disagrees with the frozen argv', () => {
    const resolved = resolveRefCommand(
      'test',
      [{ name: 'test', argv: ['swift', 'test'] }],
      [{ name: 'test', argv: ['npm', 'test'], source: 'package.json' }],
    );
    expect(resolved).toEqual({
      ok: true,
      argv: ['npm', 'test'],
      drifted: true,
      drift: {
        name: 'test',
        from: ['swift', 'test'],
        to: ['npm', 'test'],
        source: 'package.json',
      },
    });
  });

  it('reports missing when the project has no such command', () => {
    expect(resolveRefCommand('test', [], [])).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('command drift records', () => {
  it('replaces only the drifted names', () => {
    expect(
      applyCommandDrifts(
        [
          { name: 'test', argv: ['swift', 'test'] },
          { name: 'lint', argv: ['make', 'lint'] },
        ],
        [{ name: 'test', from: ['swift', 'test'], to: ['npm', 'test'], source: 'package.json' }],
      ),
    ).toEqual([
      { name: 'test', argv: ['npm', 'test'] },
      { name: 'lint', argv: ['make', 'lint'] },
    ]);
  });

  it('ignores malformed drift files rather than throwing', () => {
    expect(parseCommandDrift('not json')).toEqual([]);
    expect(parseCommandDrift('{"name":"test"}')).toEqual([]);
    expect(
      parseCommandDrift(
        JSON.stringify([
          { name: 'test', from: ['swift', 'test'], to: ['npm', 'test'], source: 'package.json' },
        ]),
      ),
    ).toEqual([
      { name: 'test', from: ['swift', 'test'], to: ['npm', 'test'], source: 'package.json' },
    ]);
  });
});
