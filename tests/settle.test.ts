/**
 * Run settlement against real git and a scripted repair agent. The bug this
 * closes: "a run landed" lived in four IPC routers, so setBranchPoint-before-
 * merge, setWorktree(null)-after-discard, drift-only-after-merged, and
 * notify-after-every-tracer-write were call-site folklore. They are internal
 * now, and this suite is the seam that pins them.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  landRun,
  repairBranch,
  type SettleHooks,
  type SettleScope,
} from '../src/main/engine/settle.js';
import { headSha, isAncestor, resolveRef } from '../src/main/engine/git.js';
import * as worktree from '../src/main/engine/worktree.js';
import { defaultProject } from '../src/main/store/projects.js';
import { defaultSettings } from '../src/main/store/settings.js';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import type { PipelineDef, ProjectDef } from '../src/shared/types.js';
import { makeFakeGh } from './fake-gh.js';
import { scriptedOneShots } from './scripted-oneshot.js';
import { tempDir } from './tmp.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchRepo(): string {
  const dir = tempDir('foundry-settle-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  writeFileSync(join(dir, 'shared.txt'), 'base\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

/** A working repo whose `origin` is a local bare repo, so push works offline. */
function scratchRepoWithOrigin(): { repo: string; bare: string } {
  const dir = tempDir('foundry-settle-origin-');
  const bare = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  sh(dir, ['git', 'init', '-q', '--bare', '-b', 'main', 'origin.git']);
  sh(dir, ['git', 'init', '-q', '-b', 'main', 'repo']);
  sh(repo, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(repo, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  writeFileSync(join(repo, 'shared.txt'), 'base\n');
  sh(repo, ['git', 'add', '-A']);
  sh(repo, ['git', 'commit', '-qm', 'initial']);
  sh(repo, ['git', 'remote', 'add', 'origin', bare]);
  sh(repo, ['git', 'push', '-qu', 'origin', 'main']);
  return { repo, bare };
}

const pipeline: PipelineDef = {
  id: 'p',
  name: 'p',
  description: 'test',
  acceptance: { kind: 'all_phases_pass' },
  phases: [],
};

const DRIFT = [
  { name: 'test', from: ['swift', 'test'], to: ['npm', 'test'], source: 'package.json' },
];

interface Harness {
  repo: string;
  project: ProjectDef;
  tracer: Tracer;
  db: Db;
  scoped: SettleScope;
  hooks: SettleHooks;
  notifies: { runs: number; settings: number };
  seed(handle: worktree.WorktreeHandle, runId?: string): string;
  writeDrift(runId: string): void;
}

function harness(repo = scratchRepo(), extras: { gh?: SettleHooks['gh'] } = {}): Harness {
  const support = tempDir('foundry-settle-support-');
  const db = openDb(projectDbPath(support, repo));
  const tracer = new Tracer(db, projectRunsDir(support, repo));
  const state: { project: ProjectDef } = {
    project: {
      ...defaultProject(repo),
      commands: [{ name: 'test', argv: ['swift', 'test'] }],
    },
  };
  const notifies = { runs: 0, settings: 0 };
  const scoped: SettleScope = {
    get project() {
      return state.project;
    },
    tracer,
  };
  const hooks: SettleHooks = {
    getSettings: () => defaultSettings(),
    oneShot: scriptedOneShots([]).factory,
    notifyRuns: () => {
      notifies.runs += 1;
    },
    notifySettings: () => {
      notifies.settings += 1;
    },
    saveProject: (next) => {
      state.project = next;
      return { ok: true };
    },
    gh: extras.gh,
  };
  return {
    repo,
    get project() {
      return state.project;
    },
    tracer,
    db,
    scoped,
    hooks,
    notifies,
    seed(handle, runId = handle.branch.replace(/^foundry\//, '')) {
      tracer.startRun({
        runId,
        projectId: state.project.id,
        pipeline,
        request: 'do it',
        engineer: 'test',
        worktreePath: handle.path,
        branch: handle.branch,
        baseRef: handle.baseRef,
        branchPointSha: handle.branchPointSha,
        mode: 'pi',
      });
      return runId;
    },
    writeDrift(runId) {
      writeFileSync(
        join(tracer.runDir(runId), 'command-drift.json'),
        `${JSON.stringify(DRIFT, null, 2)}\n`,
      );
    },
  };
}

async function committedRun(
  repo: string,
  runId: string,
  file = 'feature.ts',
  body = 'export const a = 1;\n',
) {
  const handle = await worktree.create({ repo, runId, baseRef: 'main' });
  writeFileSync(join(handle.path, file), body);
  sh(handle.path, ['git', 'add', '-A']);
  sh(handle.path, ['git', 'commit', '-qm', `work in ${runId}`]);
  return handle;
}

function moveBase(repo: string, file = 'other.ts', body = 'export const b = 2;\n'): void {
  writeFileSync(join(repo, file), body);
  sh(repo, ['git', 'add', '-A']);
  sh(repo, ['git', 'commit', '-qm', 'base moved']);
}

function events(tracer: Tracer, runId: string) {
  return tracer.eventsAfter(runId, 0, 1000);
}

describe('landRun via merge', () => {
  it('merges, marks merged, clears the worktree path, and notifies', async () => {
    const h = harness();
    const handle = await committedRun(h.repo, 'run_a');
    const runId = h.seed(handle);

    const outcome = await landRun(h.scoped, h.hooks, { via: 'merge', runId });

    expect(outcome.ok).toBe(true);
    const run = h.tracer.run(runId)!;
    expect(run.merged).toBe(true);
    expect(run.worktreePath).toBeNull();
    expect(existsSync(handle.path)).toBe(false);
    expect(readFileSync(join(h.repo, 'feature.ts'), 'utf8')).toContain('export const a = 1;');
    expect(events(h.tracer, runId).some((e) => e.name === 'worktree merge')).toBe(true);
    expect(h.notifies.runs).toBe(1);
  });

  it('applies command drift only after merged=true', async () => {
    const h = harness();
    const handle = await committedRun(h.repo, 'run_a');
    const runId = h.seed(handle);
    h.writeDrift(runId);

    const outcome = await landRun(h.scoped, h.hooks, { via: 'merge', runId });

    expect(outcome.ok).toBe(true);
    expect(h.project.commands[0]!.argv).toEqual(['npm', 'test']);
    expect(events(h.tracer, runId).some((e) => e.name === 'command_drift_applied')).toBe(true);
    expect(h.notifies.settings).toBe(1);
  });

  it('refuses a moved base without marking merged or applying drift', async () => {
    const h = harness();
    const handle = await committedRun(h.repo, 'run_a');
    const runId = h.seed(handle);
    h.writeDrift(runId);
    moveBase(h.repo);

    const outcome = await landRun(h.scoped, h.hooks, { via: 'merge', runId });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('rebase before merging');
    const run = h.tracer.run(runId)!;
    expect(run.merged).toBe(false);
    expect(run.worktreePath).toBe(handle.path);
    expect(h.project.commands[0]!.argv).toEqual(['swift', 'test']);
    expect(events(h.tracer, runId).some((e) => e.name === 'command_drift_applied')).toBe(false);
    expect(h.notifies.runs).toBe(1);
    expect(h.notifies.settings).toBe(0);
  });

  it('returns without notifying when the run has no worktree', async () => {
    const h = harness();
    const outcome = await landRun(h.scoped, h.hooks, { via: 'merge', runId: 'missing' });
    expect(outcome).toEqual({ ok: false, detail: 'this run has no worktree' });
    expect(h.notifies.runs).toBe(0);
  });

  it('still lands when project save refuses the drift', async () => {
    const h = harness();
    const handle = await committedRun(h.repo, 'run_a');
    const runId = h.seed(handle);
    h.writeDrift(runId);
    h.hooks.saveProject = () => ({ ok: false });

    const outcome = await landRun(h.scoped, h.hooks, { via: 'merge', runId });

    expect(outcome.ok).toBe(true);
    expect(h.tracer.run(runId)!.merged).toBe(true);
    expect(h.project.commands[0]!.argv).toEqual(['swift', 'test']);
    expect(events(h.tracer, runId).some((e) => e.name === 'command_drift_applied')).toBe(false);
    expect(h.notifies.settings).toBe(0);
    expect(h.notifies.runs).toBe(1);
  });
});

describe('landRun via fixMerge', () => {
  it('records the new branch point before merging, so a moved base can land', async () => {
    const h = harness();
    const handle = await committedRun(h.repo, 'run_fix');
    const runId = h.seed(handle);
    h.writeDrift(runId);
    moveBase(h.repo);
    const ontoSha = await headSha(h.repo);
    h.hooks.oneShot = scriptedOneShots([
      { work: () => sh(handle.path, ['git', 'rebase', ontoSha]), text: 'Rebased cleanly.' },
    ]).factory;

    const outcome = await landRun(h.scoped, h.hooks, { via: 'fixMerge', runId });

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('merged into main');
    const run = h.tracer.run(runId)!;
    expect(run.merged).toBe(true);
    expect(run.branchPointSha).toBe(ontoSha);
    expect(run.worktreePath).toBeNull();
    expect(h.project.commands[0]!.argv).toEqual(['npm', 'test']);
    const names = events(h.tracer, runId).map((e) => e.name);
    expect(names).toContain('agent fix');
    expect(names).toContain('worktree merge');
    expect(names).toContain('command_drift_applied');
    expect(h.notifies.runs).toBe(1);
    expect(h.notifies.settings).toBe(1);
  });

  it('aborts a failed rebase without merging or moving the branch point', async () => {
    const h = harness();
    const handle = await committedRun(h.repo, 'run_fix');
    const runId = h.seed(handle);
    const before = handle.branchPointSha;
    moveBase(h.repo);
    h.hooks.oneShot = scriptedOneShots([{ work: () => {}, text: 'did nothing' }]).factory;

    const outcome = await landRun(h.scoped, h.hooks, { via: 'fixMerge', runId });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('does not sit on main');
    const run = h.tracer.run(runId)!;
    expect(run.merged).toBe(false);
    expect(run.branchPointSha).toBe(before);
    expect(run.worktreePath).toBe(handle.path);
    expect(events(h.tracer, runId).some((e) => e.name === 'agent fix')).toBe(true);
    expect(events(h.tracer, runId).some((e) => e.name === 'worktree merge')).toBe(false);
    expect(h.notifies.runs).toBe(1);
  });

  it('refuses an already-merged run without writing the tracer', async () => {
    const h = harness();
    const handle = await committedRun(h.repo, 'run_fix');
    const runId = h.seed(handle);
    h.tracer.setMerged(runId, true);

    const outcome = await landRun(h.scoped, h.hooks, { via: 'fixMerge', runId });

    expect(outcome).toEqual({ ok: false, detail: 'this run is already merged' });
    expect(h.notifies.runs).toBe(0);
  });
});

describe('landRun via ghMerge', () => {
  it('discards the worktree, lands the run, and applies drift', async () => {
    const { repo } = scratchRepoWithOrigin();
    const handle = await committedRun(repo, 'run_a');
    sh(repo, ['git', 'push', '-qu', 'origin', handle.branch]);
    const gh = makeFakeGh({
      prView: {
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        headRefName: handle.branch,
        baseRefName: 'main',
      },
    });
    const h = harness(repo, { gh: { bin: gh.bin } });
    const runId = h.seed(handle);
    h.writeDrift(runId);

    const outcome = await landRun(h.scoped, h.hooks, {
      via: 'ghMerge',
      prNumber: 7,
      method: 'squash',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.number).toBe(7);
    expect(outcome.detail).toContain('worktree removed');
    expect(outcome.detail).toContain('main fast-forwarded');
    const run = h.tracer.run(runId)!;
    expect(run.merged).toBe(true);
    expect(run.worktreePath).toBeNull();
    expect(existsSync(handle.path)).toBe(false);
    expect(h.project.commands[0]!.argv).toEqual(['npm', 'test']);
    expect(events(h.tracer, runId).some((e) => e.name === 'pr merge')).toBe(true);
    expect(events(h.tracer, runId).some((e) => e.name === 'command_drift_applied')).toBe(true);
    expect(h.notifies.runs).toBe(1);
    expect(h.notifies.settings).toBe(1);
  });

  it('does not notify or mutate the run when gh refuses the merge', async () => {
    const h = harness(scratchRepo(), {
      gh: {
        bin: makeFakeGh({
          mergeError: 'Pull request is not mergeable',
          prView: {
            number: 7,
            url: 'https://github.com/acme/widgets/pull/7',
            headRefName: 'foundry/run_a',
            baseRefName: 'main',
          },
        }).bin,
      },
    });
    const handle = await committedRun(h.repo, 'run_a');
    const runId = h.seed(handle);

    const outcome = await landRun(h.scoped, h.hooks, {
      via: 'ghMerge',
      prNumber: 7,
      method: 'merge',
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('not mergeable');
    expect(h.tracer.run(runId)!.merged).toBe(false);
    expect(h.notifies.runs).toBe(0);
  });

  it('skips run settlement for a non-foundry head and still notifies', async () => {
    const h = harness(scratchRepo(), {
      gh: {
        bin: makeFakeGh({
          prView: {
            number: 3,
            url: 'https://github.com/acme/widgets/pull/3',
            headRefName: 'feature/outside',
            baseRefName: 'main',
          },
        }).bin,
      },
    });
    const handle = await committedRun(h.repo, 'run_a');
    const runId = h.seed(handle);

    const outcome = await landRun(h.scoped, h.hooks, {
      via: 'ghMerge',
      prNumber: 3,
      method: 'merge',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain('no git remote found');
    expect(h.tracer.run(runId)!.merged).toBe(false);
    expect(h.tracer.run(runId)!.worktreePath).toBe(handle.path);
    expect(h.notifies.runs).toBe(1);
  });
});

describe('repairBranch then push', () => {
  it('rebases onto the fetched base, records the branch point, and pushes', async () => {
    const { repo } = scratchRepoWithOrigin();
    const handle = await committedRun(repo, 'run_pr');
    sh(repo, ['git', 'push', '-qu', 'origin', handle.branch]);
    moveBase(repo);
    sh(repo, ['git', 'push', '-q', 'origin', 'main']);
    const gh = makeFakeGh({
      prView: {
        number: 9,
        url: 'https://github.com/acme/widgets/pull/9',
        headRefName: handle.branch,
        baseRefName: 'main',
      },
    });
    const h = harness(repo, { gh: { bin: gh.bin } });
    const runId = h.seed(handle);
    h.hooks.oneShot = scriptedOneShots([
      {
        work: () => {
          const onto = sh(repo, ['git', 'rev-parse', 'FETCH_HEAD']).trim();
          sh(handle.path, ['git', 'rebase', onto]);
        },
        text: 'Rebased onto origin/main.',
      },
    ]).factory;

    const outcome = await repairBranch(h.scoped, h.hooks, { prNumber: 9, then: 'push' });

    expect(outcome.ok).toBe(true);
    expect(outcome.number).toBe(9);
    expect(outcome.detail).toContain('pushed');
    const ontoSha = await resolveRef(repo, 'origin/main');
    expect(h.tracer.run(runId)!.branchPointSha).toBe(ontoSha);
    expect(await isAncestor(handle.path, ontoSha, await headSha(handle.path))).toBe(true);
    expect(h.tracer.run(runId)!.merged).toBe(false);
    expect(h.notifies.runs).toBe(1);
  });

  it('notifies a failed rebase and does not push a new branch point', async () => {
    const { repo } = scratchRepoWithOrigin();
    const handle = await committedRun(repo, 'run_pr');
    sh(repo, ['git', 'push', '-qu', 'origin', handle.branch]);
    moveBase(repo);
    sh(repo, ['git', 'push', '-q', 'origin', 'main']);
    const gh = makeFakeGh({
      prView: {
        number: 9,
        url: 'https://github.com/acme/widgets/pull/9',
        headRefName: handle.branch,
        baseRefName: 'main',
      },
    });
    const h = harness(repo, { gh: { bin: gh.bin } });
    const runId = h.seed(handle);
    const before = handle.branchPointSha;
    h.hooks.oneShot = scriptedOneShots([{ work: () => {}, text: 'nope' }]).factory;

    const outcome = await repairBranch(h.scoped, h.hooks, { prNumber: 9, then: 'push' });

    expect(outcome.ok).toBe(false);
    expect(outcome.number).toBe(9);
    expect(h.tracer.run(runId)!.branchPointSha).toBe(before);
    expect(h.notifies.runs).toBe(1);
  });

  it('refuses a non-foundry PR without writing the tracer', async () => {
    const h = harness(scratchRepo(), {
      gh: {
        bin: makeFakeGh({
          prView: {
            number: 4,
            url: 'https://github.com/acme/widgets/pull/4',
            headRefName: 'feature/outside',
            baseRefName: 'main',
          },
        }).bin,
      },
    });

    const outcome = await repairBranch(h.scoped, h.hooks, { prNumber: 4, then: 'push' });

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('not a foundry run branch');
    expect(h.notifies.runs).toBe(0);
  });
});
