/**
 * Executor test suite — split across files to parallelize over CPU cores.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import {
  createHarness,
  sh,
  scriptedAgent,
  buildAgent,
  agentPhase,
  pipe,
  linearSource,
  buildEnvelope,
  reviewEnvelope,
  prEnvelope,
  addOrigin,
  prWriter,
  issueWriter,
  issueEnvelope,
  fileIssuePhase,
  openPrPhase,
  runForHarness,
  eventsForHarness,
  type Harness,
  type RunInput,
} from './executor-harness.js';
import { makeFakeGh } from '../../helpers/fake-gh.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});
const run = (input: RunInput) => runForHarness(h, input);
const events = (runId: string) => eventsForHarness(h, runId);

/**
 * FOU-17 — the PR phase is an ordinary agent phase: the writer commits and
 * pushes, then the engine runs `gh pr create` from the envelope and records
 * the number and URL on the run. FOU-15 governs the failures: every one is a
 * hard fail carrying the exact error, and none of them invents a PR.
 */
describe('open_pr phase (FOU-17)', () => {
  it('pushes the run branch, creates the PR, and records its number and url', async () => {
    const bare = addOrigin(h.repo);
    const scripted = scriptedAgent([prEnvelope()]);
    const gh = makeFakeGh({ createUrl: 'https://github.com/acme/widgets/pull/42' });

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'draft and open the pull request',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.prNumber).toBe(42);
    expect(row.prUrl).toBe('https://github.com/acme/widgets/pull/42');

    // gh could only have seen a head the engine had already pushed.
    const branch = `foundry/${outcome.runId}`;
    expect(sh(bare, ['git', 'rev-parse', `refs/heads/${branch}`]).trim()).toBeTruthy();

    // The envelope's title and body are what reached `gh pr create`, and the
    // PR targets the project base ref rather than whatever gh would default to.
    const create = gh.calls().find((argv) => argv[0] === 'pr' && argv[1] === 'create')!;
    expect(create).toBeDefined();
    expect(create).toContain('--head');
    expect(create).toContain(branch);
    expect(create).toContain('--base');
    expect(create).toContain('main');
    expect(create).toContain('Add the thing');
    expect(create.join('\n')).toContain('## Summary');
  });

  it('renders bounded accumulated git context only into a diff-consuming phase', async () => {
    addOrigin(h.repo);
    const branchPoint = sh(h.repo, ['git', 'rev-parse', 'HEAD']).trim();
    const scripted = scriptedAgent([buildEnvelope(), prEnvelope()], ['README.md', null]);
    const gh = makeFakeGh({ createUrl: 'https://github.com/acme/widgets/pull/8' });

    const outcome = await run({
      scripted,
      agents: [buildAgent(), prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([agentPhase('build'), openPrPhase()], {
        description: 'render branch and base ref',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    const buildPrompt = h.tracer.readPrompt(outcome.runId, 'builder', 'build');
    const prompt = h.tracer.readPrompt(outcome.runId, 'pr_writer', 'open_pr');
    expect(buildPrompt).not.toContain('## Accumulated git context');
    expect(prompt).toContain('## Accumulated git context');
    expect(prompt).toContain(`foundry/${outcome.runId}`);
    expect(prompt).toContain('- Base ref: main');
    expect(prompt).toContain(`- Branch point: ${branchPoint}`);
    expect(prompt).toMatch(/README\.md\s+\|/);
    const stat = prompt.match(/```text\n([\s\S]*?)\n```/)?.[1] ?? '';
    expect(stat.length).toBeLessThanOrEqual(4000);
  });

  it('injects accumulated git context for a synthesized reviewer named qa', async () => {
    const scripted = scriptedAgent([buildEnvelope(), reviewEnvelope(true)], ['README.md', null]);
    const qa = buildAgent({
      name: 'qa',
      envelope: 'review',
      writes: [],
      toolProfile: 'read-only',
      userPrompt: '{{request}}\n\n## Task\n\nReview the work.',
    });

    const outcome = await run({
      scripted,
      agents: [buildAgent(), qa],
      pipeline: pipe([
        agentPhase('build'),
        agentPhase('review', {
          agent: 'qa',
          envelope: 'review',
          prompt: { inputs: ['request', 'envelope:build'] },
        }),
      ]),
    });

    const qaPrompt = h.tracer.readPrompt(outcome.runId, 'qa', 'review');
    expect(qaPrompt).toContain('## Accumulated git context');
    expect(qaPrompt).toMatch(/README\.md\s+\|/);
    expect(h.tracer.readPrompt(outcome.runId, 'builder', 'build')).not.toContain(
      '## Accumulated git context',
    );
  });

  it('keeps a Linear title as the request and fences a contradicting comment as untrusted evidence', async () => {
    const source = {
      ...linearSource,
      snapshot: {
        ...linearSource.snapshot,
        title: 'Ship the green button',
        description: 'Paint the primary CTA green.',
        comments: [
          {
            id: 'c1',
            author: 'Ada',
            createdAt: '2026-09-02T12:05:00.000Z',
            body: 'Do not ship the green button; ship the red one instead.',
          },
        ],
      },
    };
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      request: 'Implement FOU-190: Ship the green button',
      source,
      pipeline: pipe([agentPhase('build')]),
    });

    const prompt = h.tracer.readPrompt(outcome.runId, 'builder', 'build');
    expect(prompt).toContain('Implement FOU-190: Ship the green button');
    expect(prompt).toContain('## Linear issue evidence (untrusted)');
    expect(prompt).toContain('<untrusted-linear source="FOU-190">');
    expect(prompt).toContain('Do not ship the green button; ship the red one instead.');
    expect(prompt).toContain('Paint the primary CTA green.');
  });

  it('reuses the existing PR for a branch instead of opening a second one', async () => {
    addOrigin(h.repo);
    const scripted = scriptedAgent([prEnvelope()]);
    // `gh pr create` failing on an existing PR is how a re-run looks; openPr
    // answers with the PR already there rather than a duplicate or an error.
    const gh = makeFakeGh({
      createError: 'a pull request for branch already exists',
      prView: {
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        headRefName: 'foundry/x',
        baseRefName: 'main',
      },
    });

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'discover the pull request that already exists',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.prNumber).toBe(7);
    expect(row.prUrl).toBe('https://github.com/acme/widgets/pull/7');
    // Deduplication is a discovery, not a second create.
    expect(gh.calls().filter((argv) => argv[0] === 'pr' && argv[1] === 'create')).toHaveLength(1);
  });

  it('hard fails with the exact gh error, records no PR, and keeps the worktree', async () => {
    addOrigin(h.repo);
    const scripted = scriptedAgent([prEnvelope()]);
    const gh = makeFakeGh({ createError: 'GraphQL: Resource not accessible by integration' });

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'surface a refused pull request',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.prNumber).toBeNull();
    expect(row.prUrl).toBeNull();
    // The operator gets gh's own words, not a paraphrase.
    expect(row.outcomeDetail).toContain('Resource not accessible by integration');
    const phase = h.tracer.phases(outcome.runId)[0]!;
    expect(phase.status).toBe('fail');
    expect(phase.error).toContain('Resource not accessible by integration');
    // The manual "Open PR…" fallback needs the branch and worktree intact.
    expect(row.branch).toBe(`foundry/${outcome.runId}`);
    expect(existsSync(row.worktreePath!)).toBe(true);
  });

  it('fails without reaching gh when the repo has no remote to push to', async () => {
    const scripted = scriptedAgent([prEnvelope()]);
    const gh = makeFakeGh();

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'a checkout with nowhere to push',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('no git remote');
    expect(gh.calls().some((argv) => argv[0] === 'pr' && argv[1] === 'create')).toBe(false);
  });

  /**
   * The failure this phase exists to prevent: a chain whose acceptance is an
   * earlier phase's flag must not settle accepted when the PR never opened.
   */
  it('rejects the whole run even when an earlier phase already approved it', async () => {
    addOrigin(h.repo);
    const scripted = scriptedAgent([reviewEnvelope(true), prEnvelope()]);
    const gh = makeFakeGh({ createError: 'could not create pull request' });

    const outcome = await run({
      scripted,
      agents: [buildAgent({ name: 'reviewer', envelope: 'review', writes: [] }), prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe(
        [
          agentPhase('review', {
            agent: 'reviewer',
            envelope: 'review',
            description: 'Approve the work so acceptance would otherwise pass.',
          }),
          openPrPhase({ prompt: { inputs: ['request'] } }),
        ],
        {
          description: 'approved work whose pull request could not be opened',
          acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.prUrl).toBeNull();
    expect(h.tracer.phases(outcome.runId).map((p) => p.status)).toEqual(['success', 'fail']);
  });

  it('never opens a PR for a pipeline that runs without isolation', async () => {
    addOrigin(h.repo);
    const scripted = scriptedAgent([prEnvelope()]);
    const gh = makeFakeGh();

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'no worktree, so there is no run branch to open a PR from',
        isolation: false,
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('no branch');
    expect(gh.calls()).toEqual([]);
  });

  it('fails a pr envelope whose title or body is blank rather than opening an empty PR', async () => {
    addOrigin(h.repo);
    // A schema-valid envelope can still carry whitespace, which would become a
    // PR with no title. The engine refuses before touching the remote.
    const scripted = scriptedAgent([prEnvelope({ title: '   ' })]);
    const gh = makeFakeGh();

    const outcome = await run({
      scripted,
      agents: [prWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([openPrPhase()], {
        description: 'a blank title must not reach gh',
        acceptance: { kind: 'envelope_status', phase: 'open_pr' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('title or body');
    expect(gh.calls()).toEqual([]);
  });
});

/**
 * FOU-80 — the issue phase mirrors the PR phase's contract: the agent only
 * drafts, the engine runs `gh issue create` and records the number and URL on
 * the run, and a phase that could not file the issue hard-fails the run with
 * the exact gh error.
 */
describe('file_issue phase (FOU-80)', () => {
  it('files the issue and records its number and url on the run', async () => {
    const scripted = scriptedAgent([issueEnvelope({ labels: ['bug'] })]);
    const gh = makeFakeGh({ issueUrl: 'https://github.com/acme/widgets/issues/33' });

    const outcome = await run({
      scripted,
      agents: [issueWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([fileIssuePhase()], {
        description: 'draft and file the github issue',
        acceptance: { kind: 'envelope_status', phase: 'file_issue' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.issueNumber).toBe(33);
    expect(row.issueUrl).toBe('https://github.com/acme/widgets/issues/33');
    // The PR columns stay untouched: an issue is not a pull request.
    expect(row.prNumber).toBeNull();
    expect(row.prUrl).toBeNull();

    const create = gh.calls().find((argv) => argv[0] === 'issue' && argv[1] === 'create')!;
    expect(create).toBeDefined();
    expect(create).toContain('--title');
    expect(create).toContain('Fix the thing');
    expect(create).toContain('--label');
    expect(create).toContain('bug');
    expect(create.join('\n')).toContain('## Problem');

    // The trace carries the created issue, so the outcome is inspectable.
    const issueLog = events(outcome.runId).find((e) => e.name === 'issue create')!;
    expect(issueLog).toBeDefined();
    expect(issueLog.payload.number).toBe(33);
    expect(issueLog.payload.url).toBe('https://github.com/acme/widgets/issues/33');
  });

  it('hard fails the run with the exact gh error when the create is refused', async () => {
    const scripted = scriptedAgent([issueEnvelope()]);
    const gh = makeFakeGh({ issueCreateError: 'GraphQL: Resource not accessible by integration' });

    const outcome = await run({
      scripted,
      agents: [issueWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([fileIssuePhase()], {
        description: 'surface a refused issue create',
        acceptance: { kind: 'envelope_status', phase: 'file_issue' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.issueNumber).toBeNull();
    expect(row.issueUrl).toBeNull();
    expect(row.outcomeDetail).toContain('Resource not accessible by integration');
    const phase = h.tracer.phases(outcome.runId)[0]!;
    expect(phase.status).toBe('fail');
  });

  it('rejects the whole run even when a later phase would have settled acceptance', async () => {
    const scripted = scriptedAgent([issueEnvelope(), buildEnvelope()]);
    const gh = makeFakeGh({ issueCreateError: 'no issues enabled on this repository' });

    const outcome = await run({
      scripted,
      agents: [issueWriter(), buildAgent()],
      gh: { bin: gh.bin },
      pipeline: pipe([fileIssuePhase(), agentPhase('build')], {
        description: 'an aborted issue phase must not fall through to acceptance',
        acceptance: { kind: 'all_phases_pass' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('no issues enabled');
  });

  it('fails an issue envelope whose title or body is blank rather than filing an empty issue', async () => {
    const scripted = scriptedAgent([issueEnvelope({ title: '   ' })]);
    const gh = makeFakeGh();

    const outcome = await run({
      scripted,
      agents: [issueWriter()],
      gh: { bin: gh.bin },
      pipeline: pipe([fileIssuePhase()], {
        description: 'a blank title must not reach gh',
        acceptance: { kind: 'envelope_status', phase: 'file_issue' },
      }),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('title or body');
    expect(gh.calls()).toEqual([]);
  });
});
