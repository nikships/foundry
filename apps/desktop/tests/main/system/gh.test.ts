/**
 * The PR flow against real git and a fake gh. What these pin down: a PR is
 * never created for a branch GitHub has not seen (push runs first and its
 * failure short-circuits), gh's JSON answers survive the trip into typed rows,
 * and a merged PR can fast-forward the local base whether or not the operator
 * is standing on it.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import { fastForwardBase, headSha, preferredRemote } from '../../../src/main/engine/git.js';
import * as worktree from '../../../src/main/engine/worktree.js';
import {
  createIssue,
  ghStatus,
  listOpenPrs,
  mergePr,
  openPr,
  summarizeChecks,
  viewPr,
} from '../../../src/main/system/gh.js';
import { makeFakeGh } from '../../helpers/fake-gh.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function initRepo(dir: string): void {
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
}

/** A working repo whose `origin` is a local bare repo, so push works offline. */
function scratchRepoWithOrigin(): { repo: string; bare: string } {
  const dir = tempDir('foundry-gh-');
  const bare = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  // `-b main` matters twice over: the bare repo's HEAD must point at a branch
  // that will exist, or a later clone of it checks out nothing at all.
  sh(dir, ['git', 'init', '-q', '--bare', '-b', 'main', 'origin.git']);
  sh(dir, ['git', 'init', '-q', '-b', 'main', 'repo']);
  sh(repo, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(repo, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(repo, 'README.md'), '# scratch\n');
  sh(repo, ['git', 'add', '-A']);
  sh(repo, ['git', 'commit', '-qm', 'initial']);
  sh(repo, ['git', 'remote', 'add', 'origin', bare]);
  sh(repo, ['git', 'push', '-qu', 'origin', 'main']);
  return { repo, bare };
}

/** A run that committed one file on its own foundry branch. */
async function runBranch(repo: string, runId: string) {
  const handle = await worktree.create({ repo, runId, baseRef: 'main' });
  writeFileSync(join(handle.path, 'work.txt'), `work in ${runId}\n`);
  sh(handle.path, ['git', 'add', '-A']);
  sh(handle.path, ['git', 'commit', '-qm', `work in ${runId}`]);
  return handle;
}

describe('ghStatus', () => {
  it('reports gh missing when the binary does not run', async () => {
    const { repo } = scratchRepoWithOrigin();
    const status = await ghStatus(repo, { bin: join(repo, 'no-such-gh') });
    expect(status.available).toBe(false);
    expect(status.detail).toContain('not installed');
  });

  it('reports not signed in before blaming the repo', async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({ authed: false });
    const status = await ghStatus(repo, { bin: gh.bin });
    expect(status.available).toBe(false);
    expect(status.detail).toContain('gh auth login');
  });

  it('resolves the repo name when everything is in place', async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({ repoView: { nameWithOwner: 'acme/widgets' } });
    const status = await ghStatus(repo, { bin: gh.bin });
    expect(status.available).toBe(true);
    expect(status.repo).toBe('acme/widgets');
  });
});

describe('openPr', () => {
  it('pushes the branch to origin before asking gh to create', async () => {
    const { repo, bare } = scratchRepoWithOrigin();
    const handle = await runBranch(repo, 'run_pr1');
    const gh = makeFakeGh({ createUrl: 'https://github.com/acme/widgets/pull/7' });

    const result = await openPr(
      repo,
      { branch: handle.branch, baseRef: 'main', title: 'add work', body: 'body' },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(true);
    expect(result.number).toBe(7);
    expect(result.url).toBe('https://github.com/acme/widgets/pull/7');
    // The branch made it to the remote — gh could only have seen a pushed head.
    const remoteSha = sh(bare, ['git', 'rev-parse', `refs/heads/${handle.branch}`]).trim();
    expect(remoteSha).toBe(sh(handle.path, ['git', 'rev-parse', 'HEAD']).trim());
    const create = gh.calls().find((argv) => argv[0] === 'pr' && argv[1] === 'create');
    expect(create).toBeDefined();
    expect(create).toContain('--head');
    expect(create).toContain(handle.branch);
    expect(create).toContain('--base');
    expect(create).toContain('main');
  });

  it('refuses without a remote and never reaches gh', async () => {
    const dir = tempDir('foundry-gh-noremote-');
    initRepo(dir);
    const handle = await runBranch(dir, 'run_pr2');
    const gh = makeFakeGh();

    const result = await openPr(
      dir,
      { branch: handle.branch, baseRef: 'main', title: 't', body: '' },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('no git remote');
    expect(gh.calls()).toEqual([]);
  });

  it('recovers the existing PR when gh refuses a duplicate', async () => {
    const { repo } = scratchRepoWithOrigin();
    const handle = await runBranch(repo, 'run_pr3');
    const gh = makeFakeGh({
      createError: `a pull request for branch "${handle.branch}" already exists`,
      prView: {
        number: 41,
        url: 'https://github.com/acme/widgets/pull/41',
        headRefName: handle.branch,
        baseRefName: 'main',
      },
    });

    const result = await openPr(
      repo,
      { branch: handle.branch, baseRef: 'main', title: 't', body: '' },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(true);
    expect(result.number).toBe(41);
    expect(result.detail).toContain('already exists');
  });
});

describe('createIssue', () => {
  it('files the issue with title, body, and labels, and parses the number from the URL', async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({ issueUrl: 'https://github.com/acme/widgets/issues/17' });

    const result = await createIssue(
      repo,
      { title: 'Fix the flake', body: '## Problem\nIt flakes.', labels: ['bug'] },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(true);
    expect(result.number).toBe(17);
    expect(result.url).toBe('https://github.com/acme/widgets/issues/17');
    const create = gh.calls().find((argv) => argv[0] === 'issue' && argv[1] === 'create')!;
    expect(create).toContain('--title');
    expect(create).toContain('Fix the flake');
    expect(create).toContain('--label');
    expect(create).toContain('bug');
  });

  it('retries without labels when gh refuses them, and says which were dropped', async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({
      issueUrl: 'https://github.com/acme/widgets/issues/18',
      issueLabelError: "could not add label: 'no-such-label' not found",
    });

    const result = await createIssue(
      repo,
      { title: 't', body: 'b', labels: ['no-such-label'] },
      { bin: gh.bin },
    );

    expect(result.ok).toBe(true);
    expect(result.number).toBe(18);
    expect(result.detail).toContain('no-such-label');
    const creates = gh.calls().filter((argv) => argv[0] === 'issue' && argv[1] === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[1]).not.toContain('--label');
  });

  it("fails with gh's own words when the create is refused", async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({ issueCreateError: 'GraphQL: Resource not accessible' });

    const result = await createIssue(repo, { title: 't', body: 'b' }, { bin: gh.bin });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Resource not accessible');
    expect(result.number).toBeUndefined();
  });
});

describe('viewPr', () => {
  it('maps gh json to a typed ref for a run branch', async () => {
    const { repo } = scratchRepoWithOrigin();
    const handle = await runBranch(repo, 'run_view1');
    const gh = makeFakeGh({
      prView: {
        number: 93,
        url: 'https://github.com/acme/widgets/pull/93',
        headRefName: handle.branch,
        baseRefName: 'main',
      },
    });

    const ref = await viewPr(repo, handle.branch, { bin: gh.bin });

    expect(ref).toEqual({
      number: 93,
      url: 'https://github.com/acme/widgets/pull/93',
      headRefName: handle.branch,
      baseRefName: 'main',
    });
    const view = gh.calls().find((argv) => argv[0] === 'pr' && argv[1] === 'view');
    expect(view).toContain(handle.branch);
    expect(view).toContain('number,url,headRefName,baseRefName');
  });

  it('answers null when the branch has no PR, so the manual fallback still applies', async () => {
    const { repo } = scratchRepoWithOrigin();
    const handle = await runBranch(repo, 'run_view2');
    const gh = makeFakeGh({ prView: null });

    // A null here is what leaves RunRow.prUrl unset after a pr phase, which is
    // the signal OutcomeBanner uses to keep offering "Open PR…".
    expect(await viewPr(repo, handle.branch, { bin: gh.bin })).toBeNull();
  });

  it('accepts a PR number as well as a branch', async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({
      prView: { number: 12, url: 'https://github.com/acme/widgets/pull/12' },
    });

    const ref = await viewPr(repo, 12, { bin: gh.bin });

    expect(ref?.number).toBe(12);
    // Absent head/base in gh's answer must not become undefined on the row.
    expect(ref?.headRefName).toBe('');
    expect(ref?.baseRefName).toBe('');
    expect(gh.calls().find((argv) => argv[0] === 'pr' && argv[1] === 'view')).toContain('12');
  });
});

describe('listOpenPrs', () => {
  it('maps gh json to typed rows and summarises the check rollup', async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({
      prList: [
        {
          number: 5,
          title: 'green',
          url: 'https://github.com/acme/widgets/pull/5',
          author: { login: 'nik' },
          headRefName: 'foundry/run_x',
          baseRefName: 'main',
          createdAt: '2026-08-01T00:00:00Z',
          additions: 10,
          deletions: 2,
          isDraft: false,
          reviewDecision: 'APPROVED',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
            { __typename: 'StatusContext', state: 'SUCCESS' },
          ],
        },
        {
          number: 6,
          title: 'red wins over spinning',
          url: 'https://github.com/acme/widgets/pull/6',
          author: { login: 'nik' },
          headRefName: 'feature',
          baseRefName: 'main',
          isDraft: true,
          mergeable: 'CONFLICTING',
          statusCheckRollup: [
            { __typename: 'CheckRun', status: 'IN_PROGRESS' },
            { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
          ],
        },
      ],
    });

    const page = await listOpenPrs(repo, { bin: gh.bin });
    expect(page.ok).toBe(true);
    expect(page.prs).toHaveLength(2);
    expect(page.prs[0]).toMatchObject({
      number: 5,
      author: 'nik',
      checks: 'passing',
      mergeable: 'mergeable',
      reviewDecision: 'APPROVED',
    });
    expect(page.prs[1]).toMatchObject({
      number: 6,
      isDraft: true,
      checks: 'failing',
      mergeable: 'conflicting',
    });
  });

  it('summarises rollups the way the list column needs', () => {
    expect(summarizeChecks(undefined)).toBe('none');
    expect(summarizeChecks([])).toBe('none');
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('passing');
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SKIPPED' }])).toBe('passing');
    expect(summarizeChecks([{ status: 'QUEUED' }])).toBe('pending');
    expect(summarizeChecks([{ state: 'PENDING' }])).toBe('pending');
    expect(
      summarizeChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }]),
    ).toBe('failing');
  });
});

describe('mergePr', () => {
  it('passes the chosen method and reports the head branch for settlement', async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({
      prView: {
        number: 8,
        url: 'https://github.com/acme/widgets/pull/8',
        headRefName: 'foundry/run_y',
        baseRefName: 'main',
      },
    });

    const outcome = await mergePr(repo, 8, 'squash', { bin: gh.bin });
    expect(outcome.ok).toBe(true);
    expect(outcome.headRefName).toBe('foundry/run_y');
    expect(outcome.baseRefName).toBe('main');
    const merge = gh.calls().find((argv) => argv[0] === 'pr' && argv[1] === 'merge');
    expect(merge).toEqual(['pr', 'merge', '8', '--squash']);
  });

  it('surfaces gh’s reason when the merge is refused', async () => {
    const { repo } = scratchRepoWithOrigin();
    const gh = makeFakeGh({ prView: null, mergeError: 'Pull request #8 is not mergeable' });
    const outcome = await mergePr(repo, 8, 'merge', { bin: gh.bin });
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain('not mergeable');
  });
});

describe('fastForwardBase', () => {
  /** Two clones of one bare origin: `ahead` pushes, `behind` catches up. */
  function twoClones(): { behind: string; ahead: string; bare: string } {
    const { repo: ahead, bare } = scratchRepoWithOrigin();
    const dir = tempDir('foundry-gh-clone-');
    sh(dir, ['git', 'clone', '-q', bare, 'behind']);
    const behind = join(dir, 'behind');
    sh(behind, ['git', 'config', 'user.email', 'test@foundry.local']);
    sh(behind, ['git', 'config', 'user.name', 'Foundry Test']);
    writeFileSync(join(ahead, 'ahead.txt'), 'moved\n');
    sh(ahead, ['git', 'add', '-A']);
    sh(ahead, ['git', 'commit', '-qm', 'advance main']);
    sh(ahead, ['git', 'push', '-q', 'origin', 'main']);
    return { behind, ahead, bare };
  }

  it('pulls ff-only while standing on the base branch', async () => {
    const { behind, ahead } = twoClones();
    const result = await fastForwardBase(behind, 'origin', 'main');
    expect(result.ok).toBe(true);
    expect(await headSha(behind)).toBe(await headSha(ahead));
  });

  it('moves the base ref without touching the branch the operator is on', async () => {
    const { behind, ahead } = twoClones();
    sh(behind, ['git', 'checkout', '-qb', 'elsewhere']);
    const before = await headSha(behind);

    const result = await fastForwardBase(behind, 'origin', 'main');
    expect(result.ok).toBe(true);
    expect(sh(behind, ['git', 'rev-parse', 'main']).trim()).toBe(await headSha(ahead));
    // Still on `elsewhere`, exactly where they were.
    expect(sh(behind, ['git', 'rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('elsewhere');
    expect(await headSha(behind)).toBe(before);
  });

  it('prefers origin among several remotes', async () => {
    const { repo } = scratchRepoWithOrigin();
    sh(repo, ['git', 'remote', 'add', 'alpha', '/tmp/nowhere']);
    expect(await preferredRemote(repo)).toBe('origin');
  });
});
