/**
 * "Ask AI to find commands", end to end against a fake `droid exec`.
 *
 * The bug this replaces: the handler only asked an agent when manifest
 * sniffing found nothing, so in any repo with a package.json or Makefile the
 * button did a silent manifest lookup and returned in milliseconds. These tests
 * pin the agent as unconditional, the transcript as populated, and a failure as
 * something the panel can explain.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DetectSession, type DetectionState } from '../src/main/engine/detect-session.js';
import { defaultSettings } from '../src/main/store/settings.js';
import { __setResolvedEnvForTest } from '../src/main/system/env.js';
import type { AppSettings } from '../src/shared/types.js';

/**
 * A stand-in for `droid exec -o stream-json`: prints the same line shapes the
 * real CLI does (captured from it), then the `completion` envelope.
 */
function writeFakeCli(opts: { reply?: string; exitCode?: number; stderr?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-fake-cli-'));
  const js = join(dir, 'fake.mjs');
  writeFileSync(
    js,
    `
const reply = ${JSON.stringify(opts.reply ?? '')};
const stderr = ${JSON.stringify(opts.stderr ?? '')};
const code = ${opts.exitCode ?? 0};
if (stderr) process.stderr.write(stderr);
if (code === 0) {
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  out({ type: 'system', subtype: 'init', session_id: 's1', model: 'fake-model' });
  out({ type: 'message', role: 'assistant', id: 'm1', text: 'Reading the manifests.' });
  out({ type: 'tool_call', id: 'c1', toolId: 'Read', toolName: 'Read', parameters: { file_path: '/repo/package.json' } });
  out({ type: 'tool_result', id: 'c1', toolId: 'Read', isError: false, value: '{}' });
  out({ type: 'message', role: 'assistant', id: 'm2', text: reply });
  out({ type: 'completion', finalText: reply, session_id: 's1', usage: { input_tokens: 10, output_tokens: 2 } });
}
process.exit(code);
`,
  );
  const bin = join(dir, 'droid');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A repo whose manifests answer, so a skip-the-agent regression is visible. */
function repoWithManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-detect-repo-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'x', scripts: { test: 'echo manifest-test' } }),
  );
  return dir;
}

function settingsWith(cliPath: string): AppSettings {
  const base = defaultSettings();
  return { ...base, clis: { ...base.clis, droid: { path: cliPath, extraArgs: [] } } };
}

async function run(opts: {
  cliPath: string;
  projectPath: string;
  existingCommands?: string[];
}): Promise<DetectionState> {
  const states: DetectionState[] = [];
  const session = new DetectSession({
    projectId: 'p1',
    projectPath: opts.projectPath,
    existingCommands: opts.existingCommands ?? [],
    settings: settingsWith(opts.cliPath),
    vendor: 'droid',
    model: 'inherit',
    onChange: (state) => states.push(state),
  });
  await session.run();
  expect(states.length).toBeGreaterThan(0);
  return session.snapshot();
}

beforeEach(() => {
  // The fake CLI is a shell script needing /bin; the commands it proposes are
  // shell builtins, so a minimal PATH is enough and keeps the test hermetic.
  __setResolvedEnvForTest({ path: '/usr/bin:/bin', via: 'login-shell' });
});
afterEach(() => __setResolvedEnvForTest(null));

describe('DetectSession', () => {
  it('asks the agent even when the manifests already answered', async () => {
    const cli = writeFakeCli({
      reply: JSON.stringify({
        commands: [{ name: 'test', argv: ['echo', 'from-agent'], source: 'AGENTS.md' }],
      }),
    });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });

    // The manifest said `npm test`; the agent said `echo from-agent`. The
    // agent's answer is the one that comes back.
    expect(state.proposals.map((p) => p.argv.join(' '))).toEqual(['echo from-agent']);
    expect(state.status).toBe('done');
  });

  it('shows the manifest findings as context rather than as the answer', async () => {
    const cli = writeFakeCli({
      reply: JSON.stringify({ commands: [{ name: 'test', argv: ['echo', 'ok'] }] }),
    });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });
    expect(state.entries.some((e) => e.text.includes('Manifests suggest'))).toBe(true);
  });

  it('builds a transcript of what the agent read, not just a final answer', async () => {
    const cli = writeFakeCli({
      reply: JSON.stringify({ commands: [{ name: 'test', argv: ['echo', 'ok'] }] }),
    });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });

    expect(
      state.entries.some((e) => e.kind === 'text' && e.text.includes('Reading the manifests')),
    ).toBe(true);
    const tool = state.entries.find((e) => e.kind === 'tool');
    expect(tool?.text).toContain('package.json');
    // A tool row must close, or the panel shows a call that never returns.
    expect(tool?.done).toBe(true);
    expect(tool?.failed).toBe(false);
  });

  it('verifies each proposal by running it, and records the evidence', async () => {
    const cli = writeFakeCli({
      reply: JSON.stringify({
        commands: [
          { name: 'test', argv: ['true'], source: 'AGENTS.md' },
          { name: 'lint', argv: ['false'], source: 'AGENTS.md' },
        ],
      }),
    });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });

    const byName = Object.fromEntries(state.proposals.map((p) => [p.name, p]));
    expect(byName.test!.verify).toBe('pass');
    expect(byName.test!.exitCode).toBe(0);
    expect(byName.lint!.verify).toBe('fail');
    expect(byName.lint!.notFound).toBe(false);
  });

  it('separates a command that could not be spawned from one that ran and failed', async () => {
    const cli = writeFakeCli({
      reply: JSON.stringify({
        commands: [{ name: 'test', argv: ['definitely-not-a-real-binary'] }],
      }),
    });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });

    const proposal = state.proposals[0]!;
    expect(proposal.verify).toBe('fail');
    // The distinction the old UI could not draw: this is a PATH problem, and
    // reporting it as a failing test blames the agent for the environment.
    expect(proposal.notFound).toBe(true);
    expect(state.detail).toContain('not found on PATH');
  });

  it('keeps a name outside the four roles, since a project command is free-form', async () => {
    const cli = writeFakeCli({
      reply: JSON.stringify({ commands: [{ name: 'e2e', argv: ['true'], source: 'README' }] }),
    });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });
    expect(state.proposals.map((p) => p.name)).toEqual(['e2e']);
  });

  it('reports why a proposal was dropped instead of returning an empty list', async () => {
    const cli = writeFakeCli({
      reply: JSON.stringify({ commands: [{ name: 'test', argv: ['npm', 'test', '&&', 'lint'] }] }),
    });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });

    expect(state.proposals).toEqual([]);
    expect(state.rejected).toHaveLength(1);
    expect(state.detail).toContain('none of its 1 proposal(s) were usable');
    expect(state.entries.some((e) => e.text.includes('Ignored a proposal'))).toBe(true);
  });

  it('keeps the raw reply when the answer cannot be parsed at all', async () => {
    const cli = writeFakeCli({ reply: 'I had a look but there are no tests here.' });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });

    expect(state.status).toBe('failed');
    expect(state.rawReply).toContain('no tests here');
    expect(state.detail).toMatch(/no JSON/);
  });

  it('surfaces a CLI that refused to run rather than reporting no commands found', async () => {
    const cli = writeFakeCli({
      exitCode: 1,
      stderr: 'Model blocked by organization policy: \n\nRun droid settings.',
    });
    const state = await run({ cliPath: cli, projectPath: repoWithManifest() });

    expect(state.status).toBe('failed');
    expect(state.detail).toContain('Model blocked by organization policy');
  });
});
