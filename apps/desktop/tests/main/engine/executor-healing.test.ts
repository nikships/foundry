/**
 * Executor test suite — split across files to parallelize over CPU cores.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHarness,
  sh,
  scriptedAgent,
  buildAgent,
  codePhase,
  agentPhase,
  pipe,
  buildEnvelope,
  runForHarness,
  startForHarness,
  eventsForHarness,
  type Harness,
  type RunInput,
} from './executor-harness.js';
import type { PhaseDef, PipelineDef } from '../../../src/shared/types.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import { tempDir } from '../../helpers/tmp.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});
const run = (input: RunInput) => runForHarness(h, input);
const start = (input: RunInput) => startForHarness(h, input);
const events = (runId: string) => eventsForHarness(h, runId);

/**
 * Healing sits between a red command and the escalation it used to trigger
 * immediately. The command stays frozen, so what these pin down is the engine's
 * half: who is eligible, how many turns they get, that only the re-run's exit
 * code counts, and that exhaustion still lands on the existing bounded feedback
 * path rather than looping.
 */
describe('healing a failed programmatic phase', () => {
  function installCheck(body: string): void {
    writeFileSync(join(h.repo, 'check.sh'), body);
    chmodSync(join(h.repo, 'check.sh'), 0o755);
    sh(h.repo, ['git', 'add', '-A']);
    sh(h.repo, ['git', 'commit', '-qm', 'add check']);
  }

  /** Passes only once `fix.txt` exists, which is what a healer has to write. */
  const fixableCheck = '#!/bin/sh\ntest -f fix.txt\n';

  interface HealingSpy {
    support: ExecutorDeps['healing'];
    /** Every worktree a healing session was opened against, in order. */
    readonly opens: string[];
    /** Every prompt a healing turn was sent, in order. */
    readonly prompts: string[];
  }

  /**
   * A healing stand-in behind the same interface the real one-shot satisfies:
   * each turn runs `work` in the worktree it was opened against, so the
   * re-run has something real to judge.
   */
  function healingSpy(
    turns: ((cwd: string) => void)[],
    over: Partial<NonNullable<ExecutorDeps['healing']>> = {},
  ): HealingSpy {
    const opens: string[] = [];
    const prompts: string[] = [];
    let index = 0;
    return {
      opens,
      prompts,
      support: {
        attempts: turns.length || 1,
        model: 'provider/healer',
        reasoningEffort: 'medium',
        ...over,
        open: (cwd) => {
          opens.push(cwd);
          return {
            send: async (text) => {
              prompts.push(text);
              turns[index++]?.(cwd);
              return { text: 'made the smallest fix' };
            },
            abort: () => undefined,
          };
        },
      },
    };
  }

  const project = { commands: [{ name: 'test', argv: ['./check.sh'] }] };

  const healPipeline = (over: Partial<PhaseDef> = {}): PipelineDef =>
    pipe(
      [
        codePhase(
          'test',
          { ref: 'test' },
          {
            description: 'Run the project check and let a healer repair it.',
            // Healing tests isolate the healer; flake reruns have their own cases.
            flakeRerun: 0,
            ...over,
          },
        ),
      ],
      {
        description: 'a check a healer may repair',
        acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
      },
    );

  it('repairs the failure and accepts once the exact command passes', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('success');
    // The healer worked in the run's own worktree, never the checkout.
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(spy.opens).toEqual([worktree]);
    expect(existsSync(join(worktree, 'fix.txt'))).toBe(true);
    expect(existsSync(join(h.repo, 'fix.txt'))).toBe(false);
  });

  it('re-runs the exact same argv rather than anything the healer chose', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    const calls = events(outcome.runId).filter(
      (e) => e.type === 'tool_call' && e.name.startsWith('test:'),
    );
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((e) => JSON.stringify(e.payload.argv)))).toEqual(
      new Set([JSON.stringify(['./check.sh'])]),
    );
    expect(calls.map((e) => e.payload.passed)).toEqual([false, true]);
  });

  it('records the healing model, the attempt count, and the command log', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    const started = events(outcome.runId).find((e) => e.name === 'healing test');
    expect(started?.payload).toMatchObject({ model: 'provider/healer', attempts: 1 });
    const attempt = events(outcome.runId).find(
      (e) => e.type === 'correction' && e.name === 'healing attempt 1 on test',
    );
    expect(attempt?.payload).toMatchObject({ model: 'provider/healer', passed: true });
    expect(String(attempt?.payload.summary)).toContain('smallest fix');
    const settled = events(outcome.runId).find((e) => e.name === 'healing test succeeded');
    expect(settled?.payload).toMatchObject({ escalation: 'none' });
    expect(existsSync(join(h.tracer.runDir(outcome.runId), 'commands', 'test.heal-1.log'))).toBe(
      true,
    );
  });

  it('hands the healer the frozen command, the failure, and the run request', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    await run({
      project: { ...project, protectedPaths: ['vendor/'] },
      healing: spy.support,
      request: 'teach the widget to fly',
      pipeline: healPipeline(),
    });

    expect(spy.prompts).toHaveLength(1);
    expect(spy.prompts[0]).toContain('./check.sh');
    expect(spy.prompts[0]).toContain('exited 1');
    expect(spy.prompts[0]).toContain('teach the widget to fly');
    expect(spy.prompts[0]).toContain('vendor/');
  });

  it('writes a healing prompt record with the repository card and prior envelope', async () => {
    installCheck(fixableCheck);
    const scripted = scriptedAgent([buildEnvelope({ summary: 'added the widget' })]);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    const outcome = await run({
      scripted,
      project: {
        ...project,
        contextSummary: [
          '## Stack\nTypeScript',
          '## Repository layout\n`apps/`',
          '## Conventions\nstrict',
          '## Verification\n`npm test`',
          '## Setup\n`npm ci`',
        ].join('\n\n'),
      },
      healing: spy.support,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Implement the change.' }),
          codePhase('test', { ref: 'test' }, { description: 'Run the project check.' }),
        ],
        {
          description: 'build then a healable check',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const record = readFileSync(
      join(h.tracer.runDir(outcome.runId), 'healer', 'prompts', 'test-1.md'),
      'utf8',
    );
    expect(record).toContain('## Stack');
    expect(record).toContain('## Verification');
    expect(record).toContain('added the widget');
    expect(record).toContain('npm test');
  });

  it('escalates through feedbackTo once its attempts are spent', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    // The healer cannot fix it; the builder can, on the feedback re-entry.
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt']);
    const spy = healingSpy([() => undefined, () => undefined]);

    const outcome = await run({
      scripted,
      project,
      healing: spy.support,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Implement the change the request asks for.' }),
          codePhase(
            'test',
            { ref: 'test' },
            {
              description: 'Run the project check, heal it, then hand it back to the builder.',
              feedbackTo: 'build',
              feedbackRetries: 2,
            },
          ),
        ],
        {
          description: 'healing that gives up, then feedback that converges',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // Both healing turns were spent before the failure escalated, and the
    // phase's re-entry did not hand it a fresh budget: healing is bounded per
    // run, so a struggling run does not earn more model time than a calm one.
    expect(spy.prompts).toHaveLength(2);
    const gaveUp = events(outcome.runId).find((e) => e.name === 'healing test gave up');
    expect(gaveUp?.payload).toMatchObject({ attempts: 2, budget: 2, escalation: 'build' });
    expect(
      events(outcome.runId).find((e) => e.type === 'correction' && e.name === 'feedback to build'),
    ).toBeDefined();
  });

  it('does not open a second healing session when the phase is re-entered', async () => {
    installCheck('#!/bin/sh\ntest -f fix.txt\n');
    const envelope = buildEnvelope({ summary: 'attempted', commit_message: 'work' });
    const scripted = scriptedAgent([envelope, envelope], [null, 'fix.txt']);
    // One turn of budget, spent on the first visit and unavailable on the second.
    const spy = healingSpy([() => undefined]);

    const outcome = await run({
      scripted,
      project,
      healing: spy.support,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Implement the change the request asks for.' }),
          codePhase(
            'test',
            { ref: 'test' },
            {
              description: 'Run the project check, heal it once, then hand it back.',
              feedbackTo: 'build',
              feedbackRetries: 2,
            },
          ),
        ],
        {
          description: 'a healing budget that does not renew on re-entry',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(spy.opens).toHaveLength(1);
    expect(events(outcome.runId).filter((e) => e.name === 'healing test')).toHaveLength(1);
  });

  it('interrupts the healing turn in flight rather than waiting out its timeout', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const cancel = { fire: (): void => undefined };
    let aborted = false;
    /**
     * A turn that answers only once something aborts it — which is what a real
     * provider call is: `cancelled()` is polled between awaits, and a turn
     * already in flight has no next await point for up to its 15 minute
     * timeout. If cancel cannot reach the agent, this test hangs.
     */
    const support: ExecutorDeps['healing'] = {
      attempts: 1,
      model: 'provider/healer',
      reasoningEffort: 'medium',
      open: () => {
        let release = (): void => undefined;
        const interrupted = new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          send: async () => {
            cancel.fire();
            await interrupted;
            return { text: 'interrupted mid-turn' };
          },
          abort: () => {
            aborted = true;
            release();
          },
        };
      },
    };

    const started = start({ project, healing: support, pipeline: healPipeline() });
    cancel.fire = () => started.executor.cancel();
    const outcome = await started.done;

    expect(aborted).toBe(true);
    expect(outcome.status).toBe('killed');
  });

  it('fails the run normally when healing is exhausted and no owner is configured', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const spy = healingSpy([() => undefined, () => undefined]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId)[0]!.error).toBe('exit 1');
    const gaveUp = events(outcome.runId).find((e) => e.name === 'healing test gave up');
    expect(gaveUp?.payload.escalation).toBe('no feedback owner: the run fails');
  });

  it('reverts a healing write to a protected path and still fails the run', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const spy = healingSpy([
      (cwd) => {
        mkdirSync(join(cwd, 'vendor'), { recursive: true });
        writeFileSync(join(cwd, 'vendor', 'lib.txt'), 'rewritten\n');
      },
    ]);

    const outcome = await run({
      project: { ...project, protectedPaths: ['vendor/'] },
      healing: spy.support,
      pipeline: healPipeline(),
    });

    expect(outcome.status).toBe('rejected');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(existsSync(join(worktree, 'vendor', 'lib.txt'))).toBe(false);
    const attempt = events(outcome.runId).find(
      (e) => e.type === 'correction' && e.name === 'healing attempt 1 on test',
    );
    expect(attempt?.payload.violations).toEqual(['vendor/lib.txt (protected path)']);
  });

  it('does not heal an optional failure — it never fails the run to begin with', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const spy = healingSpy([() => undefined]);

    const outcome = await run({
      project,
      healing: spy.support,
      pipeline: pipe([codePhase('test', { ref: 'test' }, { optional: true })], {
        description: 'an optional check nothing needs to repair',
      }),
    });

    expect(outcome.status).toBe('accepted');
    expect(spy.opens).toEqual([]);
  });

  it('heals a literal argv too: what a command is does not predict a repairable failure', async () => {
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);
    const outcome = await run({
      healing: spy.support,
      pipeline: pipe([codePhase('check', { argv: ['test', '-f', 'fix.txt'] })], {
        description: 'a literal command whose failure a healer can repair',
      }),
    });

    expect(outcome.status).toBe('accepted');
    expect(spy.opens).toHaveLength(1);
  });

  it('skips healing on a project command the phase opted out of', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const spy = healingSpy([() => undefined]);

    const outcome = await run({
      project,
      healing: spy.support,
      pipeline: healPipeline({ heal: false }),
    });

    expect(outcome.status).toBe('rejected');
    expect(spy.opens).toEqual([]);
  });

  it('does not heal a missing project command — that is configuration, not a fault', async () => {
    const spy = healingSpy([() => undefined]);
    const outcome = await run({
      project: { commands: [] },
      healing: spy.support,
      pipeline: healPipeline(),
    });

    expect(outcome.status).toBe('rejected');
    expect(spy.opens).toEqual([]);
    expect(h.tracer.phases(outcome.runId)[0]!.error).toContain('is not configured');
  });

  it('does not heal a scaffold skip — there is no command to repair yet', async () => {
    const spy = healingSpy([() => undefined]);
    const outcome = await run({
      project: { commands: [], scaffold: true },
      healing: spy.support,
      pipeline: healPipeline(),
    });

    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('skipped');
    expect(spy.opens).toEqual([]);
  });

  it('leaves the pre-healing behaviour intact when no healing model is configured', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const outcome = await run({ project, pipeline: healPipeline() });

    expect(outcome.status).toBe('rejected');
    expect(events(outcome.runId).some((e) => e.name.startsWith('healing'))).toBe(false);
  });

  it('classifies a fail-then-pass with no worktree diff as flake and never opens a healer', async () => {
    installCheck(
      '#!/bin/sh\ncountfile="$(git rev-parse --git-dir)/foundry-flake-count"\nn=0\n[ -f "$countfile" ] && n=$(cat "$countfile")\nn=$((n+1))\necho "$n" > "$countfile"\n[ "$n" -ge 2 ] && exit 0\nexit 1\n',
    );
    const spy = healingSpy([() => undefined]);

    const outcome = await run({
      project,
      healing: spy.support,
      pipeline: pipe(
        [
          codePhase(
            'test',
            { ref: 'test' },
            { description: 'A proof command that fails once then passes.' },
          ),
        ],
        {
          description: 'flake rerun before healing',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(spy.opens).toEqual([]);
    expect(events(outcome.runId).find((e) => e.name === 'heal_class')?.payload.class).toBe('flake');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(sh(worktree, ['git', 'status', '--porcelain']).trim()).toBe('');
  });

  it('still heals after fail-fail-fail', async () => {
    installCheck(fixableCheck);
    const spy = healingSpy([(cwd) => writeFileSync(join(cwd, 'fix.txt'), 'healed\n')]);

    const outcome = await run({
      project,
      healing: spy.support,
      pipeline: pipe(
        [
          codePhase(
            'test',
            { ref: 'test' },
            { description: 'A proof command that stays red until a healer writes.' },
          ),
        ],
        {
          description: 'consistent failures still enter heal',
          acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(spy.opens).toHaveLength(1);
    expect(events(outcome.runId).find((e) => e.name === 'heal_class')?.payload.class).toBe(
      'healed',
    );
    const calls = events(outcome.runId).filter(
      (e) => e.type === 'tool_call' && e.name.startsWith('test:'),
    );
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.slice(0, 3).every((e) => e.payload.passed === false)).toBe(true);
    expect(calls.at(-1)?.payload.passed).toBe(true);
  });

  it('does not leave a weakened test after the last failed heal', async () => {
    installCheck('#!/bin/sh\necho original-check\nexit 1\n');
    const spy = healingSpy([
      (cwd) => writeFileSync(join(cwd, 'check.sh'), '#!/bin/sh\necho weakened\nexit 1\n'),
    ]);

    const outcome = await run({ project, healing: spy.support, pipeline: healPipeline() });

    expect(outcome.status).toBe('rejected');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(readFileSync(join(worktree, 'check.sh'), 'utf8')).toContain('original-check');
    expect(readFileSync(join(worktree, 'check.sh'), 'utf8')).not.toContain('weakened');
  });

  it('stops healing when the run is cancelled mid-turn', async () => {
    installCheck('#!/bin/sh\nexit 1\n');
    const opens: string[] = [];
    let cancel: (() => void) | null = null;
    const support: ExecutorDeps['healing'] = {
      attempts: 3,
      model: 'provider/healer',
      reasoningEffort: 'medium',
      open: (cwd) => {
        opens.push(cwd);
        return {
          send: async () => {
            cancel?.();
            return { text: 'stopped' };
          },
          abort: () => undefined,
        };
      },
    };

    const started = start({ project, healing: support, pipeline: healPipeline() });
    cancel = () => started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    // One turn was opened; the cancel landed before a second could start.
    expect(opens).toHaveLength(1);
    // The command was not re-run after the cancel: only the original failure.
    expect(
      events(outcome.runId).filter((e) => e.type === 'tool_call' && e.name.startsWith('test:')),
    ).toHaveLength(1);
  });
});

describe('worktree setup as a gate', () => {
  it('prevents phase 1 when setup exits 1', async () => {
    const outcome = await run({
      project: { setupScript: 'exit 1' },
      pipeline: pipe(
        [
          codePhase(
            'first',
            { argv: ['sh', '-c', 'echo ran-phase-1'] },
            { description: 'Must not start if setup failed.' },
          ),
        ],
        { description: 'setup must block the first phase' },
      ),
    });

    expect(outcome.status).toBe('failed');
    expect(h.tracer.phases(outcome.runId)).toEqual([]);
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toContain('worktree setup failed');
    const setup = events(outcome.runId).find((e) => e.type === 'tool_call' && e.name === 'setup');
    expect(setup?.payload.argv).toEqual(['sh', '-c', 'exit 1']);
    expect(setup?.payload.exitCode).toBe(1);
    expect(typeof setup?.payload.durationMs).toBe('number');
    expect(readFileSync(join(h.tracer.runDir(outcome.runId), 'setup.json'), 'utf8')).toContain(
      '"exitCode": 1',
    );
  });

  it('records a successful setup argv, exit, and duration on the run', async () => {
    const outcome = await run({
      project: { setupScript: 'printf setup-ok' },
      pipeline: pipe(
        [codePhase('ok', { argv: ['true'] }, { description: 'Prove setup recorded success.' })],
        { description: 'successful setup is persisted' },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const setup = events(outcome.runId).find((e) => e.type === 'tool_call' && e.name === 'setup');
    expect(setup?.payload.argv).toEqual(['sh', '-c', 'printf setup-ok']);
    expect(setup?.payload.exitCode).toBe(0);
    expect(setup?.payload.durationMs).toEqual(expect.any(Number));
    const recorded = JSON.parse(
      readFileSync(join(h.tracer.runDir(outcome.runId), 'setup.json'), 'utf8'),
    ) as { argv: string[]; exitCode: number; durationMs: number; passed: boolean };
    expect(recorded).toMatchObject({
      argv: ['sh', '-c', 'printf setup-ok'],
      exitCode: 0,
      passed: true,
    });
    expect(recorded.durationMs).toEqual(expect.any(Number));
  });

  it('does not re-run setup on continue when the worktree still exists', async () => {
    const pipeline = pipe(
      [
        codePhase(
          'stamp',
          { argv: ['sh', '-c', 'echo stamped'] },
          { description: 'A phase that runs after setup.' },
        ),
        agentPhase('build', { description: 'Fail so the run can be continued.' }),
      ],
      {
        description: 'continue must not re-run setup',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      },
    );
    const failed = scriptedAgent([buildEnvelope()], [], [], { dieOnTurns: [0] });
    const first = await run({
      scripted: failed,
      project: { setupScript: 'echo ran >> setup-stamp' },
      pipeline,
    });
    expect(first.status).toBe('rejected');
    const worktree = h.tracer.run(first.runId)!.worktreePath!;
    expect(readFileSync(join(worktree, 'setup-stamp'), 'utf8').trim().split('\n')).toEqual(['ran']);

    const continued = scriptedAgent([buildEnvelope()]);
    const executor = new Executor({
      tracer: h.tracer,
      envelopeRetries: 2,
      gateRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      supportDir: h.support,
      transport: (req) => continued.transport(req),
      agents: [buildAgent()],
      envelopeDefs: [],
      project: { ...h.project, setupScript: 'echo ran >> setup-stamp' },
      pipeline,
      request: 'do the thing',
      runId: first.runId,
      engineer: 'test',
    });
    const outcome = await executor.resume();
    expect(outcome.status).toBe('accepted');
    expect(readFileSync(join(worktree, 'setup-stamp'), 'utf8').trim().split('\n')).toEqual(['ran']);
    expect(
      events(first.runId).filter((e) => e.type === 'tool_call' && e.name === 'setup'),
    ).toHaveLength(1);
  });
});

describe('submodules in the run worktree', () => {
  function addSubmodule(): void {
    const sub = tempDir('foundry-sub-');
    sh(sub, ['git', 'init', '-q', '-b', 'main']);
    sh(sub, ['git', 'config', 'user.email', 'test@foundry.local']);
    sh(sub, ['git', 'config', 'user.name', 'Foundry Test']);
    writeFileSync(join(sub, 'lib.txt'), 'from-sub\n');
    sh(sub, ['git', 'add', '-A']);
    sh(sub, ['git', 'commit', '-qm', 'sub contents']);
    sh(h.repo, ['git', 'config', 'protocol.file.allow', 'always']);
    sh(h.repo, [
      'git',
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      `file://${sub}`,
      'vendor/lib',
    ]);
    sh(h.repo, ['git', 'commit', '-qm', 'add submodule']);
  }

  it('has submodule content in the run worktree and does not write the operator checkout', async () => {
    addSubmodule();
    const beforeStatus = sh(h.repo, ['git', 'status', '--porcelain']);
    const beforeReadme = readFileSync(join(h.repo, 'README.md'), 'utf8');

    const outcome = await run({
      pipeline: pipe(
        [codePhase('ok', { argv: ['true'] }, { description: 'Prove the worktree is usable.' })],
        { description: 'submodule init before phases' },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(readFileSync(join(worktree, 'vendor/lib/lib.txt'), 'utf8')).toBe('from-sub\n');
    expect(readFileSync(join(h.repo, 'README.md'), 'utf8')).toBe(beforeReadme);
    expect(sh(h.repo, ['git', 'status', '--porcelain'])).toBe(beforeStatus);
  });

  it('fails closed before phase 1 when submodule init fails', async () => {
    addSubmodule();
    writeFileSync(
      join(h.repo, '.gitmodules'),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = /nonexistent/foundry-sub\n',
    );
    sh(h.repo, ['git', 'add', '.gitmodules']);
    sh(h.repo, ['git', 'commit', '-qm', 'break submodule url']);
    sh(h.repo, ['git', 'config', 'submodule.vendor/lib.url', '/nonexistent/foundry-sub']);
    sh(h.repo, ['rm', '-rf', join(h.repo, '.git', 'modules')]);

    const outcome = await run({
      pipeline: pipe(
        [
          codePhase(
            'first',
            { argv: ['sh', '-c', 'echo should-not-run'] },
            { description: 'Must not start if submodule init failed.' },
          ),
        ],
        { description: 'failed submodule init blocks phase 1' },
      ),
    });

    expect(outcome.status).toBe('failed');
    expect(h.tracer.phases(outcome.runId)).toEqual([]);
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toMatch(/submodule/i);
  });
});
