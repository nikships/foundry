/**
 * Readiness tools for Smith's chat: `readiness_check`, `readiness_remediate`,
 * and `readiness_pr_status` over real git temp repositories and a real
 * `ReadinessSession` with scripted io — no model, no network, no mocked git.
 *
 * The invariants under test are the readiness invariants themselves: the
 * marker on the base ref is truth, a merged PR is not proof, and a half-done
 * onboarding keeps its `foundry-ready/<id>` branch outside the chat session.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReadinessState } from '../../../src/shared/types.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import { evaluateRepo } from '../../../src/main/readiness/evaluate.js';
import { ReadinessSession, type ReadinessRemediator } from '../../../src/main/readiness/session.js';
import type { ReadinessIo } from '../../../src/main/readiness/session.js';
import {
  createReadinessCheckTool,
  createReadinessPrStatusTool,
  createReadinessRemediateTool,
  createReadinessTools,
  type ReadinessProgressEvent,
  type ReadinessSessionSurface,
} from '../../../src/main/smith/readiness-tools.js';
import { tempDir } from '../../helpers/tmp.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function write(root: string, rel: string, body: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function commitAll(root: string, message: string): void {
  sh(root, ['git', 'add', '-A']);
  sh(root, ['git', 'commit', '-qm', message]);
}

function gitRepo(prefix: string): string {
  const dir = tempDir(prefix);
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  write(dir, 'README.md', '# scratch\nnpm ci && npm run dev\n');
  commitAll(dir, 'initial');
  return dir;
}

/** A bare origin so finalize's `fastForwardBase` has a real remote to pull from. */
function addOriginRemote(repo: string): string {
  const bare = tempDir('foundry-smith-ready-origin-');
  sh(bare, ['git', 'init', '-q', '--bare', '-b', 'main']);
  sh(repo, ['git', 'remote', 'add', 'origin', bare]);
  sh(repo, ['git', 'push', '-q', '-u', 'origin', 'main']);
  return bare;
}

/** The live `foundry-ready/<id>` branch the session created, if any. */
function readinessBranches(repo: string): string[] {
  return sh(repo, ['git', 'branch', '--list', 'foundry-ready/*', '--format=%(refname:short)'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Stands in for the PR landing: point origin's main at the readiness branch. */
function mergeReadinessBranchIntoOrigin(repo: string, bare: string, branch: string): void {
  sh(bare, ['git', 'fetch', '-q', repo, `${branch}:main`]);
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

/** A marker that validates against the repo's own evaluation. */
function markerJson(repo: string): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: '2026-08-21T05:00:00Z',
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

/**
 * The real state machine with scripted io, wired the way the chat session
 * worker will wire it: one observer slot the provider swaps on each install,
 * exactly as the contract requires.
 */
function harness(repo: string, io: ReadinessIo = {}) {
  const project = defaultProject(repo);
  project.baseRef = 'main';
  let observer: ((state: ReadinessState) => void) | null = null;
  const session = new ReadinessSession({
    project,
    settings: defaultSettings(),
    persist: (next) => {
      project.readinessValidated = next.readinessValidated;
      project.readinessSkipped = next.readinessSkipped;
    },
    onChange: (state) => observer?.(state),
    io: { pollIntervalMs: 0, sleep: async () => {}, ...io },
  });
  const events: ReadinessProgressEvent[] = [];
  const deps = {
    project: () => ({ path: project.path, baseRef: project.baseRef }),
    session: (observe: (state: ReadinessState) => void): ReadinessSessionSurface => {
      observer = observe;
      return session;
    },
    onProgress: (event: ReadinessProgressEvent) => events.push(event),
  };
  return { project, session, deps, events };
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

const openPrOk = (number: number) => async () => ({
  ok: true,
  detail: 'opened',
  number,
  url: `https://github.com/acme/widgets/pull/${number}`,
});

describe('readiness_check', () => {
  it('reports a failing checklist and a missing base-ref marker', async () => {
    const repo = gitRepo('foundry-smith-check-fail-');
    const { deps } = harness(repo);
    const tool = createReadinessCheckTool(deps);
    const answer = parse(await tool.execute({}));
    expect(answer.ready).toBe(false);
    const marker = answer.marker as { ok: boolean; detail: string; source?: string };
    expect(marker.ok).toBe(false);
    expect(marker.detail).toMatch(/not committed on main/);
    const checklist = answer.checklist as {
      ready: boolean;
      criteria: Array<{ id: string; status: string }>;
    };
    expect(checklist.ready).toBe(false);
    expect(checklist.criteria.some((c) => c.status === 'fail')).toBe(true);
  });

  it('never reports ready off a marker that exists only in the working tree', async () => {
    const repo = gitRepo('foundry-smith-check-uncommitted-');
    seedReadyFiles(repo);
    commitAll(repo, 'ready files');
    write(repo, '.agents/agent-ready.json', markerJson(repo));

    const { deps } = harness(repo);
    const answer = parse(await createReadinessCheckTool(deps).execute({}));
    expect(answer.ready).toBe(false);
    expect((answer.checklist as { ready: boolean }).ready).toBe(true);
    expect((answer.marker as { detail: string }).detail).toMatch(/not committed on main/);
  });

  it('reports ready from the committed base-ref marker', async () => {
    const repo = gitRepo('foundry-smith-check-ready-');
    seedReadyFiles(repo);
    write(repo, '.agents/agent-ready.json', markerJson(repo));
    commitAll(repo, 'ready with marker');

    const { deps } = harness(repo);
    const answer = parse(await createReadinessCheckTool(deps).execute({}));
    expect(answer.ready).toBe(true);
    const marker = answer.marker as { ok: boolean; source?: string; ref?: string };
    expect(marker.ok).toBe(true);
    expect(marker.source).toBe('base-ref');
    expect(marker.ref).toBe('main');
  });
});

describe('readiness_remediate', () => {
  it('runs the remediator on an isolated worktree and streams progress', async () => {
    const repo = gitRepo('foundry-smith-remediate-');
    const cwds: string[] = [];
    const remediator: ReadinessRemediator = {
      async run(job) {
        cwds.push(job.cwd);
        seedReadyFiles(job.cwd);
        job.onEntry({ kind: 'note', text: 'Fixed the checklist' });
        return { ok: true, detail: 'fixed' };
      },
    };
    const { deps, events } = harness(repo, {
      remediator,
      openPr: openPrOk(7),
      viewPrMerge: async () => ({
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        merged: false,
        state: 'OPEN',
      }),
    });

    const answer = parse(await createReadinessRemediateTool(deps).execute({}));
    expect(answer.phase).toBe('awaiting_merge');
    expect(answer.needsContinue).toBe(false);
    expect((answer.pr as { number: number }).number).toBe(7);
    expect(answer.markerValid).toBe(true);

    // The remediator ran in the isolated worktree, never in the checkout.
    expect(cwds).toHaveLength(1);
    expect(cwds[0]).toContain('.foundry-worktrees');
    expect(cwds[0]).not.toBe(repo);
    expect(readinessBranches(repo)).toHaveLength(1);

    // Progress streamed as structured events: transcript rows and phases.
    expect(events.some((e) => e.type === 'entry' && e.entry.text === 'Fixed the checklist')).toBe(
      true,
    );
    const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase);
    expect(phases).toContain('remediating');
    expect(phases).toContain('verifying');
    expect(phases).toContain('awaiting_merge');
  });

  it('parks a partial fix on needs_continue and continues on the same branch', async () => {
    const repo = gitRepo('foundry-smith-continue-');
    const jobs: Array<{ continuation?: boolean; cwd: string }> = [];
    const remediator: ReadinessRemediator = {
      async run(job) {
        jobs.push({ continuation: job.continuation, cwd: job.cwd });
        if (jobs.length === 1) {
          write(job.cwd, 'tests/ok.test.ts', 'test("ok", () => {});\n');
          return { ok: true, detail: 'partial' };
        }
        seedReadyFiles(job.cwd);
        return { ok: true, detail: 'fixed' };
      },
    };
    const io: ReadinessIo = {
      remediator,
      openPr: openPrOk(8),
      viewPrMerge: async () => ({
        number: 8,
        url: 'https://github.com/acme/widgets/pull/8',
        merged: false,
        state: 'OPEN',
      }),
    };
    const { deps } = harness(repo, io);

    const parked = parse(await createReadinessRemediateTool(deps).execute({}));
    expect(parked.phase).toBe('needs_continue');
    expect(parked.needsContinue).toBe(true);
    expect((parked.checklist as { failing: string[] }).failing.length).toBeGreaterThan(0);
    const branch = readinessBranches(repo);
    expect(branch).toHaveLength(1);

    // needs_continue lives on the session, outside the chat: a fresh tool
    // wiring (a "New chat") finds the parked work and continues it.
    const fresh: ReadinessProgressEvent[] = [];
    const rewired = createReadinessRemediateTool({
      session: deps.session,
      onProgress: (e) => fresh.push(e),
    });
    const done = parse(await rewired.execute({}));
    expect(done.phase).toBe('awaiting_merge');
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.continuation).toBe(true);
    expect(jobs[1]?.cwd).toBe(jobs[0]?.cwd);
    expect(readinessBranches(repo)).toEqual(branch);
  });

  it('refuses to start while make-it-ready work is already in flight', async () => {
    const live: ReadinessSessionSurface = {
      snapshot: () =>
        ({ phase: 'remediating', detail: 'The agent is fixing the repository' }) as ReadinessState,
      makeReady: () => {
        throw new Error('must not start a second remediation');
      },
      confirmMerge: () => {
        throw new Error('unused');
      },
    };
    const tool = createReadinessRemediateTool({
      session: () => live,
      onProgress: () => {},
    });
    const answer = parse(await tool.execute({}));
    expect(answer.inProgress).toBe(true);
    expect(answer.phase).toBe('remediating');
  });
});

describe('readiness_pr_status', () => {
  function prHarness(repo: string, mergedRef: { merged: boolean }) {
    return harness(repo, {
      remediator: {
        async run(job) {
          seedReadyFiles(job.cwd);
          return { ok: true, detail: 'fixed' };
        },
      },
      openPr: openPrOk(12),
      viewPrMerge: async () => ({
        number: 12,
        url: 'https://github.com/acme/widgets/pull/12',
        merged: mergedRef.merged,
        state: mergedRef.merged ? 'MERGED' : 'OPEN',
      }),
    });
  }

  it('answers without a session mutation when no PR exists yet', async () => {
    const repo = gitRepo('foundry-smith-pr-none-');
    const { deps } = harness(repo);
    const answer = parse(await createReadinessPrStatusTool(deps).execute({}));
    expect(answer.prMerged).toBe(false);
    expect(answer.ready).toBe(false);
    expect(answer.detail).toMatch(/no readiness pull request/i);
  });

  it('stays waiting while the PR is open, then finalizes off the base-ref marker', async () => {
    const repo = gitRepo('foundry-smith-pr-flow-');
    const bare = addOriginRemote(repo);
    const mergedRef = { merged: false };
    const { project, deps } = prHarness(repo, mergedRef);

    await createReadinessRemediateTool(deps).execute({});
    const waiting = parse(await createReadinessPrStatusTool(deps).execute({}));
    expect(waiting.prMerged).toBe(false);
    expect(waiting.ready).toBe(false);
    expect(waiting.phase).toBe('awaiting_merge');

    mergeReadinessBranchIntoOrigin(repo, bare, readinessBranches(repo)[0]!);
    mergedRef.merged = true;
    const done = parse(await createReadinessPrStatusTool(deps).execute({}));
    expect(done.prMerged).toBe(true);
    expect(done.ready).toBe(true);
    expect(done.phase).toBe('complete');
    expect(done.markerValid).toBe(true);
    expect(project.readinessValidated).toBe(true);
    // finalize discarded the worktree; the recoverable branch is gone with it.
    expect(readinessBranches(repo)).toHaveLength(0);
  });

  it('treats a merged PR without the base-ref marker as not ready', async () => {
    const repo = gitRepo('foundry-smith-pr-noproof-');
    addOriginRemote(repo);
    const mergedRef = { merged: false };
    const { project, deps } = prHarness(repo, mergedRef);

    await createReadinessRemediateTool(deps).execute({});
    // gh says merged, but nothing ever landed on origin's main.
    mergedRef.merged = true;
    const answer = parse(await createReadinessPrStatusTool(deps).execute({}));
    expect(answer.prMerged).toBe(true);
    expect(answer.ready).toBe(false);
    expect(answer.phase).toBe('needs_continue');
    expect(answer.markerValid).toBe(false);
    expect(project.readinessValidated).toBe(false);
    // The branch survives: the parked onboarding is recoverable work.
    expect(readinessBranches(repo)).toHaveLength(1);
  });
});

describe('createReadinessTools', () => {
  it('exports the three tools in registration order', () => {
    const tools = createReadinessTools({
      project: () => ({ path: '/tmp/none', baseRef: 'main' }),
      session: () => {
        throw new Error('unused');
      },
      onProgress: () => {},
    });
    expect(tools.map((t) => t.name)).toEqual([
      'readiness_check',
      'readiness_remediate',
      'readiness_pr_status',
    ]);
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.description.length).toBeGreaterThan(40);
    }
  });
});
