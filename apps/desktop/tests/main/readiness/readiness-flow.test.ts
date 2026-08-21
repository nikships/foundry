import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import type { ReadinessEntry } from '../../../src/shared/types.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { ProjectStore } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import { evaluateRepo } from '../../../src/main/readiness/evaluate.js';
import { readMarker } from '../../../src/main/readiness/marker.js';
import { mergeCheckFromView, pollPrMerged } from '../../../src/main/readiness/merge.js';
import { inspectProject } from '../../../src/main/readiness/sessions.js';
import {
  READINESS_SYSTEM_PROMPT,
  readinessRemediatePrompt,
} from '../../../src/main/readiness/prompt.js';
import { ReadinessSession, type ReadinessRemediator } from '../../../src/main/readiness/session.js';
import { createAgentRemediator } from '../../../src/main/readiness/remediator.js';
import { evaluate } from '../../../src/main/pi/policy.js';
import { makeFakeGh } from '../../helpers/fake-gh.js';
import { viewPrMergeState } from '../../../src/main/system/gh.js';
import { say, scriptedOneShots, toolCall } from '../../helpers/scripted-oneshot.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

/** A bare origin so `fastForwardBase` has a real remote to pull the merge from. */
function addOriginRemote(repo: string): string {
  const bare = tempDir('foundry-ready-origin-');
  sh(bare, ['git', 'init', '-q', '--bare', '-b', 'main']);
  sh(repo, ['git', 'remote', 'add', 'origin', bare]);
  sh(repo, ['git', 'push', '-q', '-u', 'origin', 'main']);
  return bare;
}

/** The live `foundry-ready/<id>` branch the session created. */
function branchOf(repo: string): string {
  const found = sh(repo, [
    'git',
    'branch',
    '--list',
    'foundry-ready/*',
    '--format=%(refname:short)',
  ])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!found[0]) throw new Error('no readiness branch exists');
  return found[0];
}

/**
 * Stands in for the PR actually landing: the readiness branch is one commit
 * ahead of main, so pointing origin's main at it is exactly the fast-forward a
 * merged PR produces.
 */
function mergeReadinessBranchIntoOrigin(repo: string, bare: string, branch: string): void {
  sh(bare, ['git', 'fetch', '-q', repo, `${branch}:main`]);
}

function commitAll(root: string, message: string): void {
  sh(root, ['git', 'add', '-A']);
  sh(root, ['git', 'commit', '-qm', message]);
}

/** A marker that validates against the repo's own evaluation. */
function markerJson(repo: string): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: '2026-08-11T05:00:00Z',
      commit: 'abc',
      agent: { harness: 'pi', model: 'inherit', reasoningEffort: 'high' },
      verdict: 'ready',
      summary: 'Ready.',
      stack: { languages: ['typescript'], monorepo: false, packages: [] },
      criteria: evaluateRepo(repo).criteria.map((c) => ({
        ...c,
        status: c.status === 'fail' ? 'pass' : c.status,
      })),
    },
    null,
    2,
  );
}

function gitRepo(prefix: string): string {
  const dir = tempDir(prefix);
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  write(dir, 'README.md', '# scratch\nnpm ci && npm run dev\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

function seedReadyFiles(root: string): void {
  write(
    root,
    'package.json',
    JSON.stringify(
      {
        name: 'ready-app',
        scripts: {
          test: 'vitest',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          build: 'vite build',
          dev: 'vite',
        },
        devDependencies: { typescript: '5.0.0', vitest: '4.0.0' },
      },
      null,
      2,
    ),
  );
  write(root, 'tsconfig.json', '{ "compilerOptions": { "strict": true } }\n');
  write(root, 'eslint.config.js', 'export default [];\n');
  write(
    root,
    'vitest.config.ts',
    'export default { test: { coverage: { thresholds: { lines: 70 } } } }\n',
  );
  write(root, 'src/math.test.ts', 'test("ok", () => {});\n');
  write(root, 'AGENTS.md', '# Agents\n');
  write(
    root,
    '.github/workflows/ci.yml',
    'run: npm test\nrun: npm run lint\nrun: npm run typecheck\nrun: npm run build\n',
  );
  write(root, '.github/ISSUE_TEMPLATE/bug.md', '---\nname: Bug\n---\n');
  write(root, '.github/pull_request_template.md', '## Summary\n');
  write(root, '.husky/pre-commit', 'npm run lint\n');
  write(root, 'README.md', 'Clone, then `npm ci` and `npm run dev`.\n');
}

function sessionFor(
  repo: string,
  io: ConstructorParameters<typeof ReadinessSession>[0]['io'] = {},
) {
  const project = defaultProject(repo);
  project.baseRef = 'main';
  const snapshots: string[] = [];
  const s = new ReadinessSession({
    project,
    settings: defaultSettings(),
    persist: (next) => {
      project.readinessValidated = next.readinessValidated;
      project.readinessSkipped = next.readinessSkipped;
    },
    onChange: (state) => snapshots.push(state.phase),
    io: { pollIntervalMs: 0, sleep: async () => {}, ...io },
  });
  return { session: s, project, snapshots };
}

describe('readiness inspect and cache', () => {
  it('stays confirming when the checklist is green but the marker is missing', async () => {
    const repo = gitRepo('foundry-ready-valid-');
    seedReadyFiles(repo);
    expect(evaluateRepo(repo).ready).toBe(true);
    const { session, project } = sessionFor(repo);
    const state = await session.inspect();
    expect(state.phase).toBe('confirming');
    expect(state.markerValid).toBe(false);
    expect(project.readinessValidated).toBe(false);
  });

  it('treats a valid committed marker as ready and sets the cache', async () => {
    const repo = gitRepo('foundry-ready-mark-');
    seedReadyFiles(repo);
    const { session, project } = sessionFor(repo);
    await session.inspect();
    expect(session.snapshot().phase).toBe('confirming');

    write(repo, '.agents/agent-ready.json', markerJson(repo));
    commitAll(repo, 'add marker');

    const again = sessionFor(repo);
    const state = await again.session.inspect();
    expect(state.phase).toBe('complete');
    expect(state.markerValid).toBe(true);
    expect(again.project.readinessValidated).toBe(true);
    expect((await inspectProject(again.project)).ready).toBe(true);
    expect(project.readinessValidated).toBe(false);
  });

  it('never lets a validated cache override a missing marker', async () => {
    const repo = gitRepo('foundry-ready-stale-');
    const project = defaultProject(repo);
    project.readinessValidated = true;
    const status = await inspectProject(project);
    expect(status.ready).toBe(false);
    expect(status.validatedCache).toBe(true);
    expect(status.markerValid).toBe(false);
  });
});

describe('the base ref is the authority, not the checked-out branch', () => {
  it('reports ready from the base ref while a feature branch omits the marker', async () => {
    const repo = gitRepo('foundry-ready-baseref-');
    seedReadyFiles(repo);
    write(repo, '.agents/agent-ready.json', markerJson(repo));
    commitAll(repo, 'ready with marker');

    sh(repo, ['git', 'checkout', '-qb', 'feature/no-marker']);
    sh(repo, ['git', 'rm', '-q', '-r', '.agents']);
    sh(repo, ['git', 'commit', '-qm', 'drop marker on the feature branch']);
    expect(readMarker(repo).ok).toBe(false);

    const project = defaultProject(repo);
    project.baseRef = 'main';
    const status = await inspectProject(project);
    expect(status.ready).toBe(true);
    expect(status.markerSource).toBe('base-ref');
    expect(status.markerRef).toBe('main');

    const { session } = sessionFor(repo);
    expect((await session.inspect()).phase).toBe('complete');
  });

  it('is not ready when the marker exists only in the working checkout', async () => {
    const repo = gitRepo('foundry-ready-uncommitted-');
    seedReadyFiles(repo);
    write(repo, '.agents/agent-ready.json', markerJson(repo));
    expect(readMarker(repo).ok).toBe(true);

    const project = defaultProject(repo);
    project.baseRef = 'main';
    const status = await inspectProject(project);
    expect(status.ready).toBe(false);
    expect(status.markerSource).toBe('base-ref');
    expect(status.markerDetail).toMatch(/not committed on main/);
  });

  it('is not ready when the base-ref marker is malformed', async () => {
    const repo = gitRepo('foundry-ready-malformed-');
    seedReadyFiles(repo);
    write(repo, '.agents/agent-ready.json', '{ "schemaVersion": 1, ');
    commitAll(repo, 'add a broken marker');

    const project = defaultProject(repo);
    project.baseRef = 'main';
    const status = await inspectProject(project);
    expect(status.ready).toBe(false);
    expect(status.markerDetail).toMatch(/not valid JSON/);

    const { session, project: sessionProject } = sessionFor(repo);
    expect((await session.inspect()).phase).toBe('confirming');
    expect(sessionProject.readinessValidated).toBe(false);
  });

  it('reads HEAD, not the working checkout, when the base ref does not resolve', async () => {
    const repo = gitRepo('foundry-ready-noref-');
    seedReadyFiles(repo);
    write(repo, '.agents/agent-ready.json', markerJson(repo));
    commitAll(repo, 'ready with marker');

    const project = defaultProject(repo);
    project.baseRef = 'nonexistent-ref';
    const status = await inspectProject(project);
    expect(status.ready).toBe(true);
    expect(status.markerSource).toBe('base-ref');
    expect(status.markerRef).toBe('HEAD');
    expect(status.markerDetail).toMatch(/does not resolve/);
  });

  it('does not report ready off an uncommitted marker when the base ref is misconfigured', async () => {
    const repo = gitRepo('foundry-ready-badref-');
    seedReadyFiles(repo);
    commitAll(repo, 'ready files, no marker');
    // Only on disk. A run branches from HEAD here, so it would never see this.
    write(repo, '.agents/agent-ready.json', markerJson(repo));
    expect(readMarker(repo).ok).toBe(true);

    const project = defaultProject(repo);
    project.baseRef = 'not-a-real-branch';
    const status = await inspectProject(project);
    expect(status.ready).toBe(false);
    expect(status.markerSource).toBe('base-ref');
  });

  it('falls back to the working checkout only when the repo has no commits', async () => {
    const repo = tempDir('foundry-ready-nocommits-');
    sh(repo, ['git', 'init', '-q', '-b', 'main']);
    seedReadyFiles(repo);
    write(repo, '.agents/agent-ready.json', markerJson(repo));

    const project = defaultProject(repo);
    project.baseRef = 'main';
    const status = await inspectProject(project);
    expect(status.markerSource).toBe('worktree');
    expect(status.markerDetail).toMatch(/no commits/);
  });

  it('skips a redundant Make it ready when the checklist and the base marker agree', async () => {
    const repo = gitRepo('foundry-ready-noredundant-');
    seedReadyFiles(repo);
    write(repo, '.agents/agent-ready.json', markerJson(repo));
    commitAll(repo, 'ready with marker');

    const { session, project } = sessionFor(repo);
    const state = await session.evaluate();
    expect(state.evaluation?.ready).toBe(true);
    expect(state.phase).toBe('complete');
    expect(project.readinessValidated).toBe(true);
  });

  it('refuses to remediate a session that already completed', async () => {
    const repo = gitRepo('foundry-ready-nodoubleready-');
    seedReadyFiles(repo);
    write(repo, '.agents/agent-ready.json', markerJson(repo));
    commitAll(repo, 'ready with marker');

    let openedPrs = 0;
    const { session } = sessionFor(repo, {
      openPr: async () => {
        openedPrs += 1;
        return { ok: true, detail: 'opened', number: 99, url: 'https://example.com/99' };
      },
    });
    await session.inspect();
    expect(session.snapshot().phase).toBe('complete');

    const after = await session.makeReady();
    expect(after.phase).toBe('complete');
    expect(openedPrs).toBe(0);
    expect(sh(repo, ['git', 'branch', '--list', 'foundry-ready/*']).trim()).toBe('');
  });

  it('re-checks the base ref before remediating, in case the marker landed meanwhile', async () => {
    const repo = gitRepo('foundry-ready-raced-');
    seedReadyFiles(repo);
    commitAll(repo, 'ready files, no marker');

    let openedPrs = 0;
    const { session } = sessionFor(repo, {
      openPr: async () => {
        openedPrs += 1;
        return { ok: true, detail: 'opened', number: 98, url: 'https://example.com/98' };
      },
    });
    const evaluated = await session.evaluate();
    expect(evaluated.phase).toBe('not_ready');

    // The operator commits the marker in another terminal before clicking.
    write(repo, '.agents/agent-ready.json', markerJson(repo));
    commitAll(repo, 'marker landed out of band');

    const after = await session.makeReady();
    expect(after.phase).toBe('complete');
    expect(openedPrs).toBe(0);
  });

  it('explains the missing base-ref marker when the checklist is already green', async () => {
    const repo = gitRepo('foundry-ready-greennomarker-');
    seedReadyFiles(repo);
    commitAll(repo, 'ready files');

    const { session } = sessionFor(repo);
    const state = await session.evaluate();
    expect(state.evaluation?.ready).toBe(true);
    expect(state.phase).toBe('not_ready');
    expect(state.detail).toMatch(/not committed on main/);
  });
});

describe('onboarding transitions, skip, and retry', () => {
  it('evaluates a missing marker into not_ready', async () => {
    const repo = gitRepo('foundry-ready-eval-');
    const { session, snapshots } = sessionFor(repo);
    await session.inspect();
    await session.evaluate();
    expect(session.snapshot().phase).toBe('not_ready');
    expect(session.snapshot().evaluation?.ready).toBe(false);
    expect(snapshots).toContain('evaluating');
    expect(snapshots).toContain('not_ready');
  });

  it('skips explicitly and can be retried', async () => {
    const repo = gitRepo('foundry-ready-skip-');
    const { session, project } = sessionFor(repo);
    await session.inspect();
    await session.evaluate();
    const skipped = session.skip();
    expect(skipped.phase).toBe('skipped');
    expect(skipped.skipDetail).toMatch(/project settings/);
    expect(project.readinessSkipped).toBe(true);

    const retried = await session.retry();
    expect(project.readinessSkipped).toBe(false);
    expect(retried.phase).toBe('not_ready');
  });
});

describe('persistence', () => {
  it('round-trips skipped and validated flags through the project store', () => {
    const dir = tempDir('foundry-ready-store-');
    const store = new ProjectStore(dir);
    const added = store.add('/tmp/some-repo');
    expect(added.readinessSkipped).toBeUndefined();
    const saved = store.save({ ...added, readinessSkipped: true, readinessValidated: false });
    expect(saved.ok).toBe(true);
    expect(store.get(added.id)?.readinessSkipped).toBe(true);
    store.save({ ...store.get(added.id)!, readinessSkipped: false, readinessValidated: true });
    expect(store.get(added.id)?.readinessValidated).toBe(true);
    expect(store.get(added.id)?.readinessSkipped).toBe(false);
  });
});

describe('make it ready, merge polling, and failed confirmation', () => {
  it('writes the marker last, opens a PR, and refuses a false merge confirm', async () => {
    const repo = gitRepo('foundry-ready-pr-');
    seedReadyFiles(repo);
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'ready files']);
    const remote = addOriginRemote(repo);

    let opened = false;
    let merged = false;
    const { session, snapshots } = sessionFor(repo, {
      openPr: async () => {
        opened = true;
        return {
          ok: true,
          detail: 'opened',
          number: 12,
          url: 'https://github.com/acme/widgets/pull/12',
        };
      },
      viewPrMerge: async () => ({
        number: 12,
        url: 'https://github.com/acme/widgets/pull/12',
        merged,
        state: merged ? 'MERGED' : 'OPEN',
      }),
    });

    await session.inspect();
    await session.evaluate();
    expect(session.snapshot().evaluation?.ready).toBe(true);
    expect(readMarker(repo).ok).toBe(false);

    await session.makeReady();
    expect(opened).toBe(true);
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(snapshots).toContain('pr_ready');
    expect(session.snapshot().pr?.url).toContain('/pull/12');
    expect(readMarker(repo).ok).toBe(false);

    const refused = await session.confirmMerge();
    expect(refused.phase).toBe('awaiting_merge');
    expect(refused.mergeDetail).toMatch(/still/i);

    // The PR landing is what puts the marker on the base ref; simulate that on
    // the bare origin so the fast-forward has something real to pull.
    mergeReadinessBranchIntoOrigin(repo, remote, branchOf(repo));

    merged = true;
    const done = await session.confirmMerge();
    expect(done.phase).toBe('complete');
    expect(session.snapshot().pr?.merged).toBe(true);
    expect(session.snapshot().markerValid).toBe(true);
    expect(readMarker(repo).ok).toBe(true);
  });

  it('refuses to complete when the merged PR never landed the marker on the base ref', async () => {
    const repo = gitRepo('foundry-ready-nomarker-merge-');
    seedReadyFiles(repo);
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'ready files']);
    const remote = addOriginRemote(repo);

    const { session, project } = sessionFor(repo, {
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 21,
        url: 'https://github.com/acme/widgets/pull/21',
      }),
      viewPrMerge: async () => ({
        number: 21,
        url: 'https://github.com/acme/widgets/pull/21',
        merged: true,
        state: 'MERGED',
      }),
    });

    await session.inspect();
    await session.evaluate();
    await session.makeReady();

    // Nothing was merged into origin, so the fast-forward brings back no marker.
    const parked = await session.confirmMerge();
    expect(parked.phase).toBe('needs_continue');
    expect(parked.failedPhase).toBe('finalizing');
    expect(parked.detail).toMatch(/not committed on main/);
    expect(project.readinessValidated).toBe(false);
    expect((await inspectProject(project)).ready).toBe(false);

    mergeReadinessBranchIntoOrigin(repo, remote, branchOf(repo));
    const done = await session.makeReady();
    expect(done.phase).toBe('complete');
    expect(project.readinessValidated).toBe(true);
  });

  it('commits the marker even when the repo gitignores .agents', async () => {
    const repo = gitRepo('foundry-ready-gitignored-');
    seedReadyFiles(repo);
    write(repo, '.gitignore', '.agents/\n.foundry-worktrees/\n');
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'ready files with .agents ignored']);
    const remote = addOriginRemote(repo);

    const { session } = sessionFor(repo, {
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 30,
        url: 'https://github.com/acme/widgets/pull/30',
      }),
      viewPrMerge: async () => ({
        number: 30,
        url: 'https://github.com/acme/widgets/pull/30',
        merged: true,
        state: 'MERGED',
      }),
    });

    await session.inspect();
    await session.evaluate();
    await session.makeReady();
    expect(session.snapshot().phase).toBe('awaiting_merge');

    const branch = branchOf(repo);
    expect(sh(repo, ['git', 'ls-tree', '--name-only', '-r', branch])).toContain(
      '.agents/agent-ready.json',
    );

    mergeReadinessBranchIntoOrigin(repo, remote, branch);
    const done = await session.confirmMerge();
    expect(done.phase).toBe('complete');
    expect(done.markerValid).toBe(true);
  });

  it('exempts the marker from .prettierignore when the repo already uses prettier', async () => {
    const repo = gitRepo('foundry-ready-prettier-');
    seedReadyFiles(repo);
    write(repo, '.prettierrc.json', '{ "printWidth": 100 }\n');
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'ready files']);

    const { session } = sessionFor(repo, {
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 5,
        url: 'https://github.com/acme/widgets/pull/5',
      }),
      viewPrMerge: async () => ({
        number: 5,
        url: 'https://github.com/acme/widgets/pull/5',
        merged: false,
        state: 'OPEN',
      }),
    });
    await session.inspect();
    await session.evaluate();
    expect(session.snapshot().evaluation?.ready).toBe(true);
    await session.makeReady();
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(session.snapshot().entries.some((e) => e.text.includes('Exempting'))).toBe(true);
  });

  it('lets an injected remediator fix a failing repo, then writes the marker last', async () => {
    const repo = gitRepo('foundry-ready-fix-');
    const remediator: ReadinessRemediator = {
      async run(job) {
        seedReadyFiles(job.cwd);
        job.onEntry({ kind: 'note', text: 'Implementing linting' });
        return { ok: true, detail: 'fixed' };
      },
    };
    const { session } = sessionFor(repo, {
      remediator,
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 3,
        url: 'https://github.com/acme/widgets/pull/3',
      }),
      viewPrMerge: async () => ({
        number: 3,
        url: 'https://github.com/acme/widgets/pull/3',
        merged: false,
        state: 'OPEN',
      }),
    });
    await session.inspect();
    await session.evaluate();
    expect(session.snapshot().evaluation?.ready).toBe(false);
    await session.makeReady();
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(session.snapshot().markerValid).toBe(true);
    expect(session.snapshot().entries.some((e) => e.text.includes('agent-ready.json'))).toBe(true);
  });

  it('parks a failed verify on the same branch so Continue can finish the work', async () => {
    const repo = gitRepo('foundry-ready-continue-');
    const jobs: Array<{ continuation?: boolean; tests: string; cwd: string }> = [];
    const remediator: ReadinessRemediator = {
      async run(job) {
        const tests = job.evaluation.criteria.find((c) => c.id === 'tests')?.status ?? '';
        jobs.push({ continuation: job.continuation, tests, cwd: job.cwd });
        if (jobs.length === 1) {
          write(job.cwd, 'tests/ok.test.ts', 'test("ok", () => {});\n');
          return { ok: true, detail: 'partial' };
        }
        seedReadyFiles(job.cwd);
        return { ok: true, detail: 'fixed' };
      },
    };
    const { session } = sessionFor(repo, {
      remediator,
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 41,
        url: 'https://github.com/acme/widgets/pull/41',
      }),
      viewPrMerge: async () => ({
        number: 41,
        url: 'https://github.com/acme/widgets/pull/41',
        merged: false,
        state: 'OPEN',
      }),
    });
    await session.inspect();
    await session.evaluate();
    await session.makeReady();
    expect(session.snapshot().phase).toBe('needs_continue');
    expect(session.snapshot().detail).toMatch(/Continue sends those remaining failures/);
    const branch = branchOf(repo);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.continuation).toBeFalsy();

    // A banner re-check must not throw the parked work away.
    await session.evaluate();
    expect(session.snapshot().phase).toBe('needs_continue');

    await session.makeReady();
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.continuation).toBe(true);
    expect(jobs[1]?.tests).toBe('pass');
    expect(jobs[1]?.cwd).toBe(jobs[0]?.cwd);
    expect(branchOf(repo)).toBe(branch);
  });

  it('discards isolated work only when the operator starts over', async () => {
    const repo = gitRepo('foundry-ready-startover-');
    const remediator: ReadinessRemediator = {
      async run(job) {
        write(job.cwd, 'AGENTS.md', '# Agents\n');
        return { ok: true, detail: 'partial' };
      },
    };
    const { session } = sessionFor(repo, { remediator });
    await session.inspect();
    await session.evaluate();
    await session.makeReady();
    expect(session.snapshot().phase).toBe('needs_continue');
    expect(branchOf(repo)).toMatch(/^foundry-ready\//);

    const retried = await session.retry();
    expect(retried.phase).toBe('not_ready');
    expect(sh(repo, ['git', 'branch', '--list', 'foundry-ready/*']).trim()).toBe('');
    expect(retried.entries.some((e) => e.text.includes('Starting over'))).toBe(true);
  });

  it('parks a remediator crash on the same branch instead of failing', async () => {
    const repo = gitRepo('foundry-ready-failphase-');
    let calls = 0;
    const remediator: ReadinessRemediator = {
      async run(job) {
        calls += 1;
        if (calls === 1) return { ok: false, detail: 'Connection error.' };
        seedReadyFiles(job.cwd);
        return { ok: true, detail: 'fixed' };
      },
    };
    const { session } = sessionFor(repo, {
      remediator,
      openPr: async () => ({
        ok: true,
        detail: 'opened',
        number: 44,
        url: 'https://github.com/acme/widgets/pull/44',
      }),
      viewPrMerge: async () => ({
        number: 44,
        url: 'https://github.com/acme/widgets/pull/44',
        merged: false,
        state: 'OPEN',
      }),
    });
    await session.inspect();
    await session.evaluate();
    await session.makeReady();
    expect(session.snapshot().phase).toBe('needs_continue');
    expect(session.snapshot().failedPhase).toBe('remediating');
    expect(session.snapshot().detail).toMatch(/isolated branch is still here/i);
    const branch = branchOf(repo);

    await session.makeReady();
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(calls).toBe(2);
    expect(branchOf(repo)).toBe(branch);
  });

  it('retries opening the PR without running the remediator again', async () => {
    const repo = gitRepo('foundry-ready-prretry-');
    seedReadyFiles(repo);
    sh(repo, ['git', 'add', '-A']);
    sh(repo, ['git', 'commit', '-qm', 'ready files']);
    let opens = 0;
    const remediator: ReadinessRemediator = {
      async run() {
        throw new Error('remediator should not run on a green checklist');
      },
    };
    const { session } = sessionFor(repo, {
      remediator,
      openPr: async () => {
        opens += 1;
        if (opens === 1) return { ok: false, detail: 'gh 502' };
        return {
          ok: true,
          detail: 'opened',
          number: 45,
          url: 'https://github.com/acme/widgets/pull/45',
        };
      },
    });
    await session.inspect();
    await session.evaluate();
    await session.makeReady();
    expect(session.snapshot().phase).toBe('needs_continue');
    expect(session.snapshot().failedPhase).toBe('pr_ready');
    expect(opens).toBe(1);

    await session.makeReady();
    expect(session.snapshot().phase).toBe('awaiting_merge');
    expect(opens).toBe(2);
    expect(session.snapshot().pr?.number).toBe(45);
  });

  it('polls until merged and reports a still-open PR', async () => {
    const views = [
      { number: 1, url: 'https://example.com/1', merged: false, state: 'OPEN' },
      { number: 1, url: 'https://example.com/1', merged: false, state: 'OPEN' },
      { number: 1, url: 'https://example.com/1', merged: true, state: 'MERGED' },
    ];
    let i = 0;
    const result = await pollPrMerged({
      view: async () => views[Math.min(i++, views.length - 1)]!,
      intervalMs: 1,
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(result.merged).toBe(true);
    expect(i).toBe(3);

    const open = mergeCheckFromView({
      number: 9,
      url: 'https://example.com/9',
      merged: false,
      state: 'OPEN',
    });
    expect(open.merged).toBe(false);
    expect(open.detail).toMatch(/still open/i);
  });

  it('reads merge state through fake gh', async () => {
    const repo = gitRepo('foundry-ready-gh-');
    const gh = makeFakeGh({
      prView: {
        number: 4,
        url: 'https://github.com/acme/widgets/pull/4',
        state: 'MERGED',
        mergedAt: '2026-08-12T00:00:00Z',
      },
    });
    const viewed = await viewPrMergeState(repo, 4, { bin: gh.bin });
    expect(viewed?.merged).toBe(true);
    expect(viewed?.state).toBe('MERGED');
  });
});

describe('pipeline zero-interrupt policy', () => {
  it('denies an asking tool in a pipeline run rather than waiting on it', () => {
    // A pipeline run has nobody to answer, and the policy has no "wait"
    // outcome, so an interactive tool is unrecognised and fails closed.
    const outcome = evaluate(
      {
        tool: 'ask_user',
        input: {
          questions: [{ index: 0, question: 'which CI?', options: ['github', 'gitlab'] }],
        },
      },
      { worktree: '/repo', writes: null, protectedPaths: [] },
    );
    expect(outcome.decision.outcome).toBe('deny');
  });
});

describe('readiness remediator continuation prompt', () => {
  const evaluation = {
    stack: { languages: ['shell'], monorepo: false, packages: [] },
    criteria: [
      { id: 'lint_format' as const, status: 'fail' as const, notes: 'No lint/format command.' },
      { id: 'tests' as const, status: 'fail' as const, notes: 'No tests.' },
    ],
    ready: false,
    summary: 'shell single package. 2 criterion(s) need work: lint_format, tests.',
  };

  it('states marker-ignore ownership once and does not advertise unavailable workers', () => {
    const combined = `${READINESS_SYSTEM_PROMPT}\n${readinessRemediatePrompt(evaluation)}`;
    expect(combined.match(/Exempt the marker from every gate/g)).toHaveLength(1);
    expect(combined).not.toMatch(/Fan out|sub-agents|workers to split/);
  });

  it('tells a continuation turn not to start over', () => {
    const first = readinessRemediatePrompt(evaluation);
    expect(first).not.toMatch(/This is a continuation/);
    const next = readinessRemediatePrompt(evaluation, {
      continuation: true,
      attempt: 2,
      priorSummary: 'Added Spotless to the Lint job.',
    });
    expect(next).toMatch(/This is a continuation/);
    expect(next).toMatch(/attempt 2/);
    expect(next).toMatch(/Added Spotless/);
    expect(next).toMatch(/Fix these first: lint_format, tests/);
  });
});

describe('readiness remediator streams mid-turn work', () => {
  /** Drives one remediation turn and collects the transcript it produced. */
  async function remediate(
    turns: Parameters<typeof scriptedOneShots>[0],
    signal: { cancelled: boolean } = { cancelled: false },
  ) {
    const dir = tempDir('foundry-ready-remediate-');
    const oneShots = scriptedOneShots(turns);
    const remediator = createAgentRemediator({ oneShot: oneShots.factory });
    const entries: ReadinessEntry[] = [];
    const result = await remediator.run({
      cwd: dir,
      evaluation: evaluateRepo(dir),
      model: 'inherit',
      reasoningEffort: 'off',
      onEntry: (entry) => {
        const full = { ...entry, id: String(entries.length), at: 0 } as ReadinessEntry;
        entries.push(full);
        return full;
      },
      flush: () => {},
      signal,
    });
    return { result, entries, oneShots, dir };
  }

  it('folds assistant text and closed tool rows into the session transcript', async () => {
    const { result, entries } = await remediate([
      {
        events: [
          ...say('Adding a linter.'),
          ...toolCall({
            callId: 'c1',
            tool: 'read',
            args: { path: '/repo/package.json' },
            result: '{}',
          }),
        ],
        text: 'Done.',
      },
    ]);

    expect(result.ok).toBe(true);
    expect(entries.some((e) => e.kind === 'text' && e.text.includes('Adding a linter'))).toBe(true);
    const tool = entries.find((e) => e.kind === 'tool');
    expect(tool?.text).toContain('package.json');
    // A tool row that never closes reads as work still in flight after the
    // session has been disposed.
    expect(tool?.done).toBe(true);
    expect(tool?.failed).toBe(false);
  });

  it('runs write-capable, but only inside the readiness worktree it was handed', async () => {
    const { oneShots, dir } = await remediate([{ text: 'Done.' }]);
    // The whole job is to change the repository, so unlike detection this one
    // needs write tools. The isolated branch is what makes that safe.
    expect(oneShots.calls[0]!.access).toBe('write');
    expect(oneShots.calls[0]!.cwd).toBe(dir);
  });

  it('reports an interrupted turn as a failure rather than a finished fix', async () => {
    const { result } = await remediate([{ interrupted: true, reason: 'aborted' }]);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('aborted');
  });

  it('aborts the turn in flight when the session is cancelled', async () => {
    const signal = { cancelled: false };
    // The turn is held open until the abort lands, which is what the 250ms
    // cancellation poll exists to deliver; a turn that answered first would
    // prove nothing about cancellation.
    setTimeout(() => {
      signal.cancelled = true;
    }, 10);
    const { result } = await remediate([{ hangUntilAbort: true }], signal);
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('cancelled');
  });

  it('reports a turn that could not run at all', async () => {
    const { result } = await remediate([{ throws: 'no model is available to this install' }]);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no model is available');
  });
});
