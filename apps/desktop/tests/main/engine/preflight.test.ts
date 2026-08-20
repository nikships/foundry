import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import {
  ensureMissingCommands,
  missingCommandRefs,
  preflightForRun,
  requiredCommandRefs,
} from '../../../src/main/engine/preflight.js';
import type { AgentDef, PipelineDef, ProjectDef } from '../../../src/shared/types.js';

function pipe(phases: PipelineDef['phases']): PipelineDef {
  return {
    id: 'p',
    name: 'P',
    description: 'a pipeline used only by unit tests',
    acceptance: { kind: 'all_phases_pass' },
    phases,
  };
}

function project(partial: Partial<ProjectDef> & { path: string }): ProjectDef {
  return {
    id: 'proj',
    name: 'proj',
    baseRef: 'main',
    isolation: true,
    mergePolicy: 'never',
    commands: [],
    protectedPaths: [],
    ownRoster: false,
    ownPipelines: false,
    addedAt: new Date().toISOString(),
    ...partial,
  };
}

const agents: AgentDef[] = [
  {
    name: 'builder',
    purpose: 'builds',
    model: 'inherit',
    reasoningEffort: 'off',
    systemPrompt: 'sys',
    userPrompt: 'do {{request}}',
    writes: null,
    envelope: 'build',
    color: '#5ad2dd',
  },
];

describe('requiredCommandRefs / missingCommandRefs', () => {
  it('collects unique project command refs and ignores argv/builtin', () => {
    const pipeline = pipe([
      {
        name: 'test',
        kind: 'code',
        description: 'Run the project test suite.',
        command: { ref: 'test' },
      },
      {
        name: 'lint',
        kind: 'code',
        description: 'Run the project linter.',
        command: { ref: 'lint' },
      },
      {
        name: 'again',
        kind: 'code',
        description: 'Run tests a second time.',
        command: { ref: 'test' },
      },
      {
        name: 'echo',
        kind: 'code',
        description: 'Print a fixed string.',
        command: { argv: ['echo', 'hi'] },
      },
      {
        name: 'commit',
        kind: 'code',
        description: 'Commit phase output.',
        command: { builtin: 'git_commit' },
      },
    ]);
    expect(requiredCommandRefs(pipeline).sort()).toEqual(['lint', 'test']);
    expect(
      missingCommandRefs(
        pipeline,
        project({ path: '/tmp', commands: [{ name: 'lint', argv: ['a'] }] }),
      ),
    ).toEqual(['test']);
  });
});

describe('preflightForRun', () => {
  it('promotes a missing project command ref to a start-blocking error', () => {
    const pipeline = pipe([
      {
        name: 'test',
        kind: 'code',
        description: 'Run the project test suite before accepting.',
        command: { ref: 'test' },
      },
    ]);
    const issues = preflightForRun(pipeline, agents, []);
    expect(issues.some((i) => i.level === 'error' && i.message.includes('"test"'))).toBe(true);
  });

  it('passes when the required ref is configured', () => {
    const pipeline = pipe([
      {
        name: 'test',
        kind: 'code',
        description: 'Run the project test suite before accepting.',
        command: { ref: 'test' },
      },
    ]);
    expect(preflightForRun(pipeline, agents, ['test'])).toEqual([]);
  });

  /**
   * A project Foundry created empty has no test command because it has no code
   * yet. Blocking the start would mean a brand-new repo could never run the
   * pipeline meant to fill it.
   */
  it('demotes a missing ref to a warning for a project created empty', () => {
    const pipeline = pipe([
      {
        name: 'test',
        kind: 'code',
        description: 'Run the project test suite before accepting.',
        command: { ref: 'test' },
      },
    ]);
    const issues = preflightForRun(pipeline, agents, [], [], { scaffold: true });
    expect(issues.some((i) => i.level === 'error')).toBe(false);
    expect(issues.some((i) => i.level === 'warning' && i.message.includes('skipped'))).toBe(true);
  });

  it('does not require project commands for argv-only pipelines', () => {
    const pipeline = pipe([
      {
        name: 'echo',
        kind: 'code',
        description: 'Print hello so the phase has something to run.',
        command: { argv: ['echo', 'hello'] },
      },
    ]);
    expect(preflightForRun(pipeline, agents, [])).toEqual([]);
  });
});

describe('ensureMissingCommands', () => {
  it('fills a missing test ref from a nested Swift package without an agent', async () => {
    const dir = tempDir('foundry-preflight-');
    const pkg = join(dir, 'App');
    mkdirSync(pkg);
    writeFileSync(
      join(pkg, 'Package.swift'),
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "App",
  targets: [.executableTarget(name: "App", path: "Sources")]
)
`,
    );

    const before = project({ path: dir, commands: [] });
    const result = await ensureMissingCommands(before, ['test'], {
      useAgent: false,
      save: (next) => next,
    });

    expect(result.filled).toEqual(['test']);
    expect(result.stillMissing).toEqual([]);
    expect(result.via).toBe('manifest');
    const testCmd = result.project.commands.find((c) => c.name === 'test');
    expect(testCmd).toBeTruthy();
    // Nested package, no testTarget → build is the gate, run from repo root.
    expect(testCmd!.argv).toEqual(['swift', 'build', '--package-path', 'App']);
  });

  it('never overwrites an existing command name', async () => {
    const dir = tempDir('foundry-preflight-');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'vitest run', lint: 'eslint .' } }),
    );
    const before = project({
      path: dir,
      commands: [{ name: 'test', argv: ['custom', 'test'] }],
    });
    const result = await ensureMissingCommands(before, ['test', 'lint'], {
      useAgent: false,
      save: (next) => next,
    });
    expect(result.filled).toEqual(['lint']);
    expect(result.project.commands.find((c) => c.name === 'test')?.argv).toEqual([
      'custom',
      'test',
    ]);
    expect(result.project.commands.find((c) => c.name === 'lint')?.argv[0]).toBe('npm');
  });
});
