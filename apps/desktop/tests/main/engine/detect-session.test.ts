/**
 * "Ask AI to find commands", end to end against a scripted one-shot session.
 *
 * The bug this replaces: the handler only asked an agent when manifest
 * sniffing found nothing, so in any repo with a package.json or Makefile the
 * button did a silent manifest lookup and returned in milliseconds. These tests
 * pin the agent as unconditional, the parse as explained, and a failure as
 * something the panel can show. Transcript fold and registry sweep live in
 * `panel-session.test.ts`.
 *
 * The session is scripted rather than spawned: what is under test is what
 * `DetectSession` does with a turn, and a real one would need a credential, a
 * network, and a model. The tools it is allowed are asserted here too, because
 * detection runs against the operator's own checkout and nothing would revert a
 * write it made.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DetectSession, type DetectionState } from '../../../src/main/engine/detect-session.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import { setResolvedEnvForTest } from '../../../src/main/system/env.js';
import {
  say,
  scriptedOneShots,
  toolCall,
  type ScriptedTurn,
} from '../../helpers/scripted-oneshot.js';

/** A repo whose manifests answer, so a skip-the-agent regression is visible. */
function repoWithManifest(): string {
  const dir = tempDir('foundry-detect-repo-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'echo manifest-test' } }),
  );
  return dir;
}

/** What the agent would have read on its way to an answer. */
function readingTurn(reply: string): ScriptedTurn {
  return {
    events: [
      ...say('Reading the manifests.'),
      ...toolCall({
        callId: 'c1',
        tool: 'read',
        args: { path: '/repo/package.json' },
        result: '{}',
      }),
    ],
    text: reply,
  };
}

async function run(opts: {
  turn: ScriptedTurn | ScriptedTurn[];
  projectPath: string;
  existingCommands?: string[];
}): Promise<{ state: DetectionState; oneShots: ReturnType<typeof scriptedOneShots> }> {
  const oneShots = scriptedOneShots(Array.isArray(opts.turn) ? opts.turn : [opts.turn]);
  const states: DetectionState[] = [];
  const session = new DetectSession({
    projectId: 'p1',
    projectPath: opts.projectPath,
    existingCommands: opts.existingCommands ?? [],
    settings: defaultSettings(),
    model: 'inherit',
    oneShot: oneShots.factory,
    onChange: (state) => states.push(state),
  });
  await session.run();
  expect(states.length).toBeGreaterThan(0);
  return { state: session.snapshot(), oneShots };
}

function commandsReply(
  commands: { name: string; argv: string[]; source?: string }[],
): ScriptedTurn {
  return readingTurn(JSON.stringify({ commands }));
}

function submittedCommands(
  commands: { name: string; argv: string[]; source?: string }[],
): ScriptedTurn {
  return { structuredOutput: { commands } };
}

beforeEach(() => {
  // The commands the fixtures propose are shell builtins, so a minimal PATH is
  // enough to verify them and keeps the test hermetic.
  setResolvedEnvForTest({ path: '/usr/bin:/bin', via: 'login-shell' });
});
afterEach(() => setResolvedEnvForTest(null));

describe('DetectSession', () => {
  it('asks the agent even when the manifests already answered', async () => {
    const { state } = await run({
      turn: commandsReply([{ name: 'test', argv: ['echo', 'from-agent'], source: 'AGENTS.md' }]),
      projectPath: repoWithManifest(),
    });

    // The manifest said `npm test`; the agent said `echo from-agent`. The
    // agent's answer is the one that comes back.
    expect(state.proposals.map((p) => p.argv.join(' '))).toEqual(['echo from-agent']);
    expect(state.status).toBe('done');
  });

  it('cannot write or run anything in the operator’s own checkout', async () => {
    const projectPath = repoWithManifest();
    const { oneShots } = await run({
      turn: commandsReply([{ name: 'test', argv: ['true'] }]),
      projectPath,
    });

    // Detection has no worktree and no boundary diff, so a write here would be
    // permanent. Read-only is a session that has no tool that could make one.
    expect(oneShots.calls).toHaveLength(1);
    expect(oneShots.calls[0]!.access).toBe('read');
    expect(oneShots.calls[0]!.cwd).toBe(projectPath);
  });

  it('shows the manifest findings as context rather than as the answer', async () => {
    const { state } = await run({
      turn: commandsReply([{ name: 'test', argv: ['echo', 'ok'] }]),
      projectPath: repoWithManifest(),
    });
    expect(state.entries.some((e) => e.text.includes('Manifests suggest'))).toBe(true);
  });

  it('verifies each proposal by running it, and records the evidence', async () => {
    const { state } = await run({
      turn: commandsReply([
        { name: 'test', argv: ['true'], source: 'AGENTS.md' },
        { name: 'lint', argv: ['false'], source: 'AGENTS.md' },
      ]),
      projectPath: repoWithManifest(),
    });

    const byName = Object.fromEntries(state.proposals.map((p) => [p.name, p]));
    expect(byName.test!.verify).toBe('pass');
    expect(byName.test!.exitCode).toBe(0);
    expect(byName.lint!.verify).toBe('fail');
    expect(byName.lint!.notFound).toBe(false);
  });

  it('separates a command that could not be spawned from one that ran and failed', async () => {
    const { state } = await run({
      turn: commandsReply([{ name: 'test', argv: ['definitely-not-a-real-binary'] }]),
      projectPath: repoWithManifest(),
    });

    const proposal = state.proposals[0]!;
    expect(proposal.verify).toBe('fail');
    // The distinction the old UI could not draw: this is a PATH problem, and
    // reporting it as a failing test blames the agent for the environment.
    expect(proposal.notFound).toBe(true);
    expect(state.detail).toContain('not found on PATH');
  });

  it('keeps a name outside the four roles, since a project command is free-form', async () => {
    const { state } = await run({
      turn: commandsReply([{ name: 'e2e', argv: ['true'], source: 'README' }]),
      projectPath: repoWithManifest(),
    });
    expect(state.proposals.map((p) => p.name)).toEqual(['e2e']);
  });

  it('reports why a proposal was dropped instead of returning an empty list', async () => {
    const { state } = await run({
      turn: commandsReply([{ name: 'test', argv: ['npm', 'test', '&&', 'lint'] }]),
      projectPath: repoWithManifest(),
    });

    expect(state.proposals).toEqual([]);
    expect(state.rejected).toHaveLength(1);
    expect(state.detail).toContain('none of its 1 proposal(s) were usable');
    expect(state.entries.some((e) => e.text.includes('Ignored a proposal'))).toBe(true);
  });

  it('parses a detect reply that only calls submit_result', async () => {
    const { state, oneShots } = await run({
      turn: submittedCommands([{ name: 'test', argv: ['echo', 'from-tool'], source: 'AGENTS.md' }]),
      projectPath: repoWithManifest(),
    });

    expect(state.proposals.map((p) => p.argv.join(' '))).toEqual(['echo from-tool']);
    expect(state.status).toBe('done');
    expect(oneShots.calls[0]!.outputFormat?.type).toBe('json_schema');
    expect(oneShots.calls[0]!.systemPrompt).toContain('Call submit_result exactly once');
  });

  it('retries once when submit_result is missing, then accepts a structured correction', async () => {
    const { state, oneShots } = await run({
      turn: [
        { text: 'I had a look but there are no tests here.' },
        submittedCommands([{ name: 'test', argv: ['true'], source: 'AGENTS.md' }]),
      ],
      projectPath: repoWithManifest(),
    });

    expect(state.status).toBe('done');
    expect(state.proposals.map((p) => p.argv.join(' '))).toEqual(['true']);
    expect(oneShots.calls).toHaveLength(2);
    expect(oneShots.prompts[1]).toContain('Call submit_result exactly once');
    expect(oneShots.calls[1]!.outputFormat).toBe(oneShots.calls[0]!.outputFormat);
  });

  it('keeps the raw reply when the answer cannot be parsed at all', async () => {
    const { state } = await run({
      turn: [
        { text: 'I had a look but there are no tests here.' },
        { text: 'Still no tests, just prose.' },
      ],
      projectPath: repoWithManifest(),
    });

    expect(state.status).toBe('failed');
    expect(state.rawReply).toContain('Still no tests');
    expect(state.detail).toMatch(/no JSON/);
  });

  it('surfaces a turn that could not run rather than reporting no commands found', async () => {
    const { state } = await run({
      turn: { throws: 'the model ended the turn with an error: blocked by organization policy' },
      projectPath: repoWithManifest(),
    });

    expect(state.status).toBe('failed');
    expect(state.detail).toContain('blocked by organization policy');
    expect(state.entries.some((e) => e.kind === 'error')).toBe(true);
  });

  it('cancels the turn in flight and stops before verifying anything', async () => {
    const oneShots = scriptedOneShots([{ hangUntilAbort: true }]);
    const session = new DetectSession({
      projectId: 'p1',
      projectPath: repoWithManifest(),
      existingCommands: [],
      settings: defaultSettings(),
      model: 'inherit',
      oneShot: oneShots.factory,
      onChange: () => {},
    });

    const running = session.run();
    // The turn is held open, so the cancel has something to interrupt: a
    // cancel that only lands after the answer proves nothing.
    await viWaitFor(() => oneShots.calls.length === 1);
    session.cancel();
    await running;

    const state = session.snapshot();
    expect(state.status).toBe('cancelled');
    expect(state.proposals).toEqual([]);
    expect(state.entries.some((e) => e.text === 'Cancelled.')).toBe(true);
  });
});

async function viWaitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the session');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
