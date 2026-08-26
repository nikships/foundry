/**
 * The failure this was built for, reproduced end to end: a `git_commit`
 * builtin rejected by a pre-commit hook that found unformatted files.
 *
 * It is its own suite because it is the shape that decided the default. A
 * commit looks like metadata, which argues for excluding it from healing; a
 * repository with a pre-commit hook makes it a quality gate, which is the
 * opposite. The hook wins: it prints the failing check and the fix, so this is
 * the most repairable failure a chain produces, not the least.
 *
 * Everything but the healer's own turn is production: a real repo, a real
 * hook, the real `git_commit` argv the engine builds, and the real executor
 * deciding what the run is worth.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import type { PipelineDef, ProjectDef } from '../../../src/shared/types.js';
import { tempDir } from '../../helpers/tmp.js';

function sh(cwd: string, argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? '';
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${stderr.trim() || String(e)}`);
  }
}

/**
 * A repo whose pre-commit hook refuses a file that is not "formatted" —
 * `formatted.marker` present next to it, which a `format` step writes. Same
 * shape as a Prettier `--check` hook, with none of the toolchain.
 */
function repoWithFormatHook(): string {
  const dir = tempDir('foundry-heal-hook-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  sh(dir, ['git', 'config', 'commit.gpgsign', 'false']);

  const hooks = join(dir, '.githooks');
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, 'pre-commit');
  writeFileSync(
    hook,
    [
      '#!/bin/sh',
      'if [ ! -f formatted.marker ]; then',
      '  echo "pre-commit: found unformatted files. Fix with: format"',
      '  echo "pre-commit: commit aborted."',
      '  exit 1',
      'fi',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(hook, 0o755);
  sh(dir, ['git', 'config', 'core.hooksPath', '.githooks']);

  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  sh(dir, ['git', 'add', '-A']);
  // The initial commit predates the hook being wired, so it is allowed through.
  sh(dir, ['git', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'initial']);
  return dir;
}

let repo: string;
let support: string;
let tracer: Tracer;
let project: ProjectDef;

beforeEach(() => {
  repo = repoWithFormatHook();
  support = tempDir('foundry-heal-hook-support-');
  tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  project = { ...defaultProject(repo), mergePolicy: 'never' };
});

/** The chain reduced to its failing link: write a file, then commit it. */
function commitPipeline(heal?: boolean): PipelineDef {
  return {
    id: 'p',
    name: 'p',
    description: 'write a file, then commit it past the hook',
    acceptance: { kind: 'all_phases_pass' },
    phases: [
      {
        name: 'build',
        kind: 'code',
        description: 'Stand in for the builder: leave a change for the commit to record.',
        command: { argv: ['sh', '-c', 'echo work > src.txt'] },
      },
      {
        name: 'commit_build',
        kind: 'code',
        description: 'Commit the implementation once its tests are green.',
        command: { builtin: 'git_commit' },
        ...(heal === undefined ? {} : { heal }),
      },
    ],
  };
}

interface Attempt {
  cwd: string;
  prompt: string;
}

/**
 * The healer, scripted: it reads the hook's own output and runs the fix that
 * output names. Nothing else about the run is simulated.
 */
function formattingHealer(attempts: Attempt[]): NonNullable<ExecutorDeps['healing']> {
  return {
    attempts: 2,
    model: 'provider/healer',
    reasoningEffort: 'medium',
    open: (cwd) => ({
      send: async (prompt) => {
        attempts.push({ cwd, prompt });
        if (prompt.includes('Fix with: format')) {
          writeFileSync(join(cwd, 'formatted.marker'), 'formatted\n');
        }
        return { text: 'Ran the formatter the hook asked for.' };
      },
      abort: () => undefined,
    }),
  };
}

function run(input: {
  pipeline: PipelineDef;
  healing?: ExecutorDeps['healing'];
}): Promise<{ status: string; runId: string }> {
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  const executor = new Executor({
    tracer,
    envelopeRetries: 2,
    gateRetries: 2,
    compactionThreshold: 0.8,
    rewindAfterCorrections: 2,
    healing: input.healing ?? null,
    supportDir: support,
    agents: [],
    envelopeDefs: [],
    project,
    pipeline: input.pipeline,
    request: 'add persistent light and dark desktop themes',
    runId,
    engineer: 'test',
  });
  return executor.run().then((o) => ({ status: o.status, runId }));
}

function commitCount(worktree: string): number {
  return Number(sh(worktree, ['git', 'rev-list', '--count', 'HEAD']).trim());
}

describe('a commit the pre-commit hook refused', () => {
  it('fails the run, as it does today, when no healing is configured', async () => {
    const outcome = await run({ pipeline: commitPipeline() });

    expect(outcome.status).toBe('rejected');
    const phase = tracer.phases(outcome.runId).find((p) => p.name === 'commit_build')!;
    expect(phase.status).toBe('fail');
    expect(phase.error).toBe('exit 1');
    expect(tracer.readRunFile(outcome.runId, 'commands/commit_build.log')).toContain(
      'commit aborted',
    );
  });

  it('is not healed when the phase opts out, even though the hook named the fix', async () => {
    const attempts: Attempt[] = [];
    const outcome = await run({
      pipeline: commitPipeline(false),
      healing: formattingHealer(attempts),
    });

    expect(outcome.status).toBe('rejected');
    expect(attempts).toEqual([]);
  });

  it('repairs it by default, and the same commit then lands', async () => {
    const attempts: Attempt[] = [];
    const outcome = await run({
      pipeline: commitPipeline(),
      healing: formattingHealer(attempts),
    });

    expect(outcome.status).toBe('accepted');
    expect(tracer.phases(outcome.runId).find((p) => p.name === 'commit_build')!.status).toBe(
      'success',
    );

    // One turn was enough, and it ran in the run's own worktree.
    expect(attempts).toHaveLength(1);
    const worktree = tracer.run(outcome.runId)!.worktreePath!;
    expect(attempts[0]!.cwd).toBe(worktree);
    // The hook's own words reached the healer, which is how it knew the fix.
    expect(attempts[0]!.prompt).toContain('Fix with: format');
    expect(attempts[0]!.prompt).toContain('add persistent light and dark desktop themes');

    // The commit the phase exists to make is really there, hook and all.
    expect(commitCount(worktree)).toBe(2);
    expect(sh(worktree, ['git', 'status', '--porcelain'])).toBe('');

    const settled = tracer
      .eventsAfter(outcome.runId, 0, 1000)
      .find((e) => e.name === 'healing commit_build succeeded');
    expect(settled?.payload).toMatchObject({ model: 'provider/healer', attempts: 1 });
  });

  it('gives up and fails the run when the healer cannot satisfy the hook', async () => {
    const attempts: Attempt[] = [];
    const healer = formattingHealer(attempts);
    const outcome = await run({
      pipeline: commitPipeline(),
      // A healer that answers without ever writing the marker.
      healing: {
        ...healer,
        open: (cwd) => ({
          send: async (prompt) => {
            attempts.push({ cwd, prompt });
            return { text: 'I could not work out what the hook wants.' };
          },
          abort: () => undefined,
        }),
      },
    });

    expect(outcome.status).toBe('rejected');
    expect(attempts).toHaveLength(2);
    const gaveUp = tracer
      .eventsAfter(outcome.runId, 0, 1000)
      .find((e) => e.name === 'healing commit_build gave up');
    expect(gaveUp?.payload.escalation).toBe('no feedback owner: the run fails');
  });
});
