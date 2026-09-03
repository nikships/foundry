/**
 * Healing against real git and a scripted agent, with the command replaced by
 * a function whose verdict the loop has to take at face value.
 *
 * What these pin down: only the command's exit code decides, the loop is
 * bounded, a protected write is reverted before the re-run judges it, a
 * cancelled run stops without another turn, and the model attribution is the
 * setting the operator chose.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import type { CommandResult } from '../../../src/shared/types.js';
import {
  HEALING_SYSTEM,
  heal,
  healingAgent,
  healingSupport,
  healingSystemRole,
  resolveHealingModel,
  type HealingAgent,
} from '../../../src/main/engine/healing.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import { scriptedOneShots } from '../../helpers/scripted-oneshot.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function scratchRepo(): string {
  const dir = tempDir('foundry-heal-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'src.txt'), 'broken\n');
  mkdirSync(join(dir, '.foundry'), { recursive: true });
  writeFileSync(join(dir, '.foundry', 'secret.txt'), 'do not touch\n');
  sh(dir, ['git', 'add', '-A', '-f']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

function failure(over: Partial<CommandResult> = {}): CommandResult {
  return {
    name: 'test',
    command: './check.sh',
    exitCode: 1,
    passed: false,
    durationMs: 5,
    outputTail: 'src.txt is broken',
    timedOut: false,
    ...over,
  };
}

function pass(): CommandResult {
  return { ...failure(), exitCode: 0, passed: true, outputTail: 'ok' };
}

const agentThat = (work: () => void, text = 'Fixed the one line.'): HealingAgent => ({
  send: async () => {
    work();
    return { text };
  },
  abort: () => undefined,
});

describe('heal', () => {
  it('accepts a fix only once the exact command exits 0', async () => {
    const cwd = scratchRepo();
    const commands: string[] = [];
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 2,
      protectedPaths: [],
      agent: agentThat(() => writeFileSync(join(cwd, 'src.txt'), 'fixed\n')),
      rerun: async () => {
        commands.push('rerun');
        return pass();
      },
      cancelled: () => false,
    });

    expect(outcome.healed).toBe(true);
    expect(outcome.detail).toBe('healed on attempt 1 of 2');
    expect(outcome.attempts).toHaveLength(1);
    expect(commands).toHaveLength(1);
    expect(outcome.result.passed).toBe(true);
  });

  it('does not believe an agent that says it fixed a command still failing', async () => {
    const cwd = scratchRepo();
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 1,
      protectedPaths: [],
      agent: agentThat(() => undefined, 'All green now, I promise.'),
      rerun: async () => failure(),
      cancelled: () => false,
    });

    expect(outcome.healed).toBe(false);
    expect(outcome.result.passed).toBe(false);
    expect(outcome.attempts[0]!.reply).toContain('All green');
  });

  it('stops at its attempt budget rather than looping', async () => {
    const cwd = scratchRepo();
    let turns = 0;
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 3,
      protectedPaths: [],
      agent: agentThat(() => {
        turns += 1;
      }),
      rerun: async () => failure(),
      cancelled: () => false,
    });

    expect(turns).toBe(3);
    expect(outcome.attempts).toHaveLength(3);
    expect(outcome.detail).toContain('after 3 healing attempt(s)');
  });

  it('keeps healing across attempts until the command agrees', async () => {
    const cwd = scratchRepo();
    let turns = 0;
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 3,
      protectedPaths: [],
      agent: agentThat(() => {
        turns += 1;
        writeFileSync(join(cwd, `attempt-${turns}.txt`), 'work\n');
      }),
      // Only the second attempt's file satisfies it.
      rerun: async () => (existsSync(join(cwd, 'attempt-2.txt')) ? pass() : failure()),
      cancelled: () => false,
    });

    expect(outcome.healed).toBe(true);
    expect(outcome.attempts).toHaveLength(2);
  });

  it('reverts a write to a protected path and reports it', async () => {
    const cwd = scratchRepo();
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 1,
      protectedPaths: ['secrets/'],
      agent: agentThat(() => {
        mkdirSync(join(cwd, 'secrets'), { recursive: true });
        writeFileSync(join(cwd, 'secrets', 'key.txt'), 'exfiltrated\n');
        writeFileSync(join(cwd, 'src.txt'), 'fixed\n');
      }),
      rerun: async () => pass(),
      cancelled: () => false,
    });

    expect(outcome.healed).toBe(true);
    const violations = outcome.attempts[0]!.violations.map((v) => v.path);
    expect(violations).toContain('secrets/key.txt');
    expect(existsSync(join(cwd, 'secrets', 'key.txt'))).toBe(false);
    // The allowed part of the same turn survives.
    expect(existsSync(join(cwd, 'src.txt'))).toBe(true);
  });

  it('always protects .foundry and .git, whatever the project declares', async () => {
    const cwd = scratchRepo();
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 1,
      protectedPaths: [],
      agent: agentThat(() => {
        writeFileSync(join(cwd, '.foundry', 'secret.txt'), 'rewritten\n');
      }),
      rerun: async () => failure(),
      cancelled: () => false,
    });

    expect(outcome.attempts[0]!.violations.map((v) => v.path)).toContain('.foundry/secret.txt');
    expect(sh(cwd, ['git', 'status', '--porcelain'])).not.toContain('.foundry/secret.txt');
  });

  it('stops before the first turn when the run was already cancelled', async () => {
    const cwd = scratchRepo();
    let turns = 0;
    let aborted = false;
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 2,
      protectedPaths: [],
      agent: {
        send: async () => {
          turns += 1;
          return { text: '' };
        },
        abort: () => {
          aborted = true;
        },
      },
      rerun: async () => pass(),
      cancelled: () => true,
    });

    expect(turns).toBe(0);
    expect(aborted).toBe(true);
    expect(outcome.healed).toBe(false);
    expect(outcome.detail).toBe('cancelled');
  });

  it('does not re-run the command when the cancel lands during a turn', async () => {
    const cwd = scratchRepo();
    let cancelled = false;
    let reruns = 0;
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 2,
      protectedPaths: [],
      agent: agentThat(() => {
        cancelled = true;
      }),
      rerun: async () => {
        reruns += 1;
        return pass();
      },
      cancelled: () => cancelled,
    });

    expect(reruns).toBe(0);
    expect(outcome.healed).toBe(false);
    expect(outcome.detail).toBe('cancelled');
  });

  it('aborts the session when the work around the turn throws, not just the turn', async () => {
    const cwd = scratchRepo();
    let aborted = 0;
    await expect(
      heal({
        phase: 'test',
        request: 'make it work',
        cwd,
        failure: failure(),
        attempts: 2,
        protectedPaths: [],
        agent: {
          send: async () => ({ text: 'fixed' }),
          abort: () => {
            aborted += 1;
          },
        },
        // The trace write inside the real `rerun` can throw on a full disk;
        // whatever the cause, the session must not outlive the call.
        rerun: async () => {
          throw new Error('disk full');
        },
        cancelled: () => false,
      }),
    ).rejects.toThrow('disk full');

    expect(aborted).toBe(1);
  });

  it('reports an agent that threw, and still enforces the boundary', async () => {
    const cwd = scratchRepo();
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 2,
      protectedPaths: [],
      agent: {
        send: async () => {
          writeFileSync(join(cwd, '.foundry', 'secret.txt'), 'rewritten\n');
          throw new Error('provider ended the healing turn');
        },
        abort: () => undefined,
      },
      rerun: async () => pass(),
      cancelled: () => false,
    });

    expect(outcome.healed).toBe(false);
    expect(outcome.detail).toContain('provider ended');
    expect(outcome.attempts[0]!.violations.map((v) => v.path)).toContain('.foundry/secret.txt');
  });

  it('hands the healer the frozen command, its exit metadata, and the tail', async () => {
    const cwd = scratchRepo();
    let prompt = '';
    await heal({
      phase: 'lint',
      request: 'add the widget',
      cwd,
      failure: failure({ command: 'npm run lint', exitCode: 2, outputTail: 'no-unused-vars' }),
      attempts: 1,
      protectedPaths: ['dist/'],
      agent: {
        send: async (text) => {
          prompt = text;
          return { text: '' };
        },
        abort: () => undefined,
      },
      rerun: async () => pass(),
      cancelled: () => false,
    });

    expect(prompt).toContain('npm run lint');
    expect(prompt).toContain('exited 2');
    expect(prompt).toContain('no-unused-vars');
    expect(prompt).toContain('add the widget');
    expect(prompt).toContain('dist/');
    expect(prompt).toContain('attempt 1 of 1');
  });

  it('says a timeout was a timeout rather than an exit code', async () => {
    const cwd = scratchRepo();
    let prompt = '';
    await heal({
      phase: 'test',
      request: 'x',
      cwd,
      failure: failure({ exitCode: null, timedOut: true }),
      attempts: 1,
      protectedPaths: [],
      agent: {
        send: async (text) => {
          prompt = text;
          return { text: '' };
        },
        abort: () => undefined,
      },
      rerun: async () => pass(),
      cancelled: () => false,
    });

    expect(prompt).toContain('timed out');
  });

  it('tells the last attempt to revert in-phase edits rather than weaken the check', async () => {
    const cwd = scratchRepo();
    let prompt = '';
    await heal({
      phase: 'test',
      request: 'x',
      cwd,
      failure: failure(),
      attempts: 2,
      protectedPaths: [],
      agent: {
        send: async (text) => {
          prompt = text;
          return { text: '' };
        },
        abort: () => undefined,
      },
      rerun: async () => pass(),
      cancelled: () => false,
    });
    expect(prompt).toContain('attempt 1 of 2');
    expect(prompt).not.toContain('This is the last attempt');

    prompt = '';
    await heal({
      phase: 'test',
      request: 'x',
      cwd,
      failure: failure(),
      attempts: 1,
      protectedPaths: [],
      agent: {
        send: async (text) => {
          prompt = text;
          return { text: '' };
        },
        abort: () => undefined,
      },
      rerun: async () => pass(),
      cancelled: () => false,
    });
    expect(prompt).toContain('This is the last attempt');
    expect(prompt).toContain('revert every in-phase edit');
  });

  it('reverts in-phase edits when healing is exhausted', async () => {
    const cwd = scratchRepo();
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 1,
      protectedPaths: [],
      agent: agentThat(() => {
        writeFileSync(join(cwd, 'src.txt'), 'weakened\n');
        writeFileSync(join(cwd, 'extra.txt'), 'partial\n');
      }),
      rerun: async () => failure(),
      cancelled: () => false,
    });

    expect(outcome.healed).toBe(false);
    expect(outcome.detail).toContain('in-phase edits reverted');
    expect(readFileSync(join(cwd, 'src.txt'), 'utf8')).toBe('broken\n');
    expect(existsSync(join(cwd, 'extra.txt'))).toBe(false);
  });

  it('does not revert earlier-phase files that were already dirty at heal start', async () => {
    const cwd = scratchRepo();
    writeFileSync(join(cwd, 'prior.txt'), 'from an earlier phase\n');
    const outcome = await heal({
      phase: 'test',
      request: 'make it work',
      cwd,
      failure: failure(),
      attempts: 1,
      protectedPaths: [],
      agent: agentThat(() => writeFileSync(join(cwd, 'src.txt'), 'weakened\n')),
      rerun: async () => failure(),
      cancelled: () => false,
    });

    expect(outcome.healed).toBe(false);
    expect(readFileSync(join(cwd, 'prior.txt'), 'utf8')).toBe('from an earlier phase\n');
    expect(readFileSync(join(cwd, 'src.txt'), 'utf8')).toBe('broken\n');
  });
});

describe('resolveHealingModel', () => {
  it('follows the install default when healing is left on inherit', () => {
    const resolved = resolveHealingModel({
      ...defaultSettings(),
      defaultModel: 'provider/default',
      defaultReasoningEffort: 'high',
      healingModel: 'inherit',
      healingReasoningEffort: 'low',
    });
    expect(resolved).toEqual({ model: 'provider/default', reasoningEffort: 'high' });
  });

  it('uses the healing pair once a concrete model is chosen', () => {
    const resolved = resolveHealingModel({
      ...defaultSettings(),
      defaultModel: 'provider/default',
      defaultReasoningEffort: 'high',
      healingModel: 'provider/healer',
      healingReasoningEffort: 'max',
    });
    expect(resolved).toEqual({ model: 'provider/healer', reasoningEffort: 'max' });
  });

  it('stays on inherit when neither is pinned', () => {
    expect(resolveHealingModel(defaultSettings()).model).toBe('inherit');
  });
});

describe('healingAgent', () => {
  it('opens a write-capable session on the healing model, scoped to the worktree', async () => {
    const cwd = scratchRepo();
    const oneShots = scriptedOneShots([{ text: 'done' }]);
    const support = healingSupport(
      oneShots.factory,
      { ...defaultSettings(), healingModel: 'provider/healer', healingReasoningEffort: 'max' },
      2,
    );

    expect(support.model).toBe('provider/healer');
    expect(support.attempts).toBe(2);
    await support.open(cwd).send('fix it');

    expect(oneShots.calls).toHaveLength(1);
    expect(oneShots.calls[0]!.access).toBe('write');
    expect(oneShots.calls[0]!.cwd).toBe(cwd);
    expect(oneShots.calls[0]!.model).toBe('provider/healer');
    expect(oneShots.calls[0]!.reasoningEffort).toBe('max');
    expect(oneShots.calls[0]!.systemPrompt).toBe(HEALING_SYSTEM);
  });

  it('appends the repository card, prior envelope, and project commands', async () => {
    const cwd = scratchRepo();
    const oneShots = scriptedOneShots([{ text: 'done' }]);
    const support = healingSupport(
      oneShots.factory,
      { ...defaultSettings(), healingModel: 'provider/healer', healingReasoningEffort: 'max' },
      1,
    );

    await support
      .open(cwd, {
        repositoryContext: '## Stack\nTypeScript\n## Verification\n`npm test`',
        envelopeSummaries: [{ phase: 'build', summary: 'added the widget' }],
        commands: [
          { name: 'test', argv: ['npm', 'test'] },
          { name: 'lint', argv: ['npm', 'run', 'lint'] },
        ],
      })
      .send('fix it');

    const system = oneShots.calls[0]!.systemPrompt ?? '';
    expect(system.startsWith(HEALING_SYSTEM)).toBe(true);
    expect(system).toContain('# Repository context');
    expect(system).toContain('## Stack');
    expect(system).toContain('## Verification');
    expect(system).toContain('added the widget');
    expect(system).toContain('npm test');
    expect(system).toContain('npm run lint');
  });

  it('bounds the turn so a stuck healer cannot hold a run open forever', async () => {
    const cwd = scratchRepo();
    const oneShots = scriptedOneShots([{ hangUntilAbort: true }]);
    const agent = healingAgent(
      oneShots.factory,
      { model: 'provider/healer', reasoningEffort: 'low' },
      cwd,
    );
    const turn = agent.send('fix it');
    agent.abort();
    await expect(turn).resolves.toMatchObject({ text: '' });
  });

  it('forbids weakening the check in its standing rules', () => {
    expect(HEALING_SYSTEM).toContain('smallest change');
    expect(HEALING_SYSTEM).toContain('Never weaken the check');
    expect(HEALING_SYSTEM).toContain('revert every edit you made in this phase');
    expect(HEALING_SYSTEM).toContain('do not revert earlier phases');
  });
});

describe('healingSystemRole', () => {
  it('keeps the standing rules and appends the card, envelope, and commands when set', () => {
    const role = healingSystemRole({
      repositoryContext: '## Stack\nTypeScript\n## Verification\n`npm test`',
      envelopeSummaries: [{ phase: 'build', summary: 'added the widget' }],
      commands: [{ name: 'test', argv: ['npm', 'test'] }],
    });
    expect(role.startsWith(HEALING_SYSTEM)).toBe(true);
    expect(role).toContain('## Stack');
    expect(role).toContain('## Verification');
    expect(role).toContain('added the widget');
    expect(role).toContain('npm test');
  });

  it('stays on the standing rules when the card is empty', () => {
    expect(healingSystemRole()).toBe(HEALING_SYSTEM);
    expect(healingSystemRole({ repositoryContext: '  ' })).toBe(HEALING_SYSTEM);
  });
});
