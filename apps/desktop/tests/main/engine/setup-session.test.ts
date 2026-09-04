/**
 * Setup-script generation: prompt, parse, and the read-only one-shot.
 * Cap/cancel/sweep live in panel-session.test.ts.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { describe, expect, it } from 'vitest';
import { SetupSession, type SetupState } from '../../../src/main/engine/setup-session.js';
import { defaultSettings } from '../../../src/main/store/settings.js';
import { say, scriptedOneShots, type ScriptedTurn } from '../../helpers/scripted-oneshot.js';

function repoWithPackage(): string {
  const dir = tempDir('foundry-setup-repo-');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
  writeFileSync(join(dir, 'package-lock.json'), '{}');
  return dir;
}

async function run(opts: { turn: ScriptedTurn | ScriptedTurn[]; projectPath: string }): Promise<{
  state: SetupState;
  oneShots: ReturnType<typeof scriptedOneShots>;
}> {
  const oneShots = scriptedOneShots(Array.isArray(opts.turn) ? opts.turn : [opts.turn]);
  const session = new SetupSession({
    projectId: 'p1',
    projectPath: opts.projectPath,
    settings: defaultSettings(),
    model: 'inherit',
    oneShot: oneShots.factory,
    onChange: () => {},
  });
  await session.run();
  return { state: session.snapshot(), oneShots };
}

describe('SetupSession', () => {
  it('asks the agent even when manifests already suggested a script', async () => {
    const { state } = await run({
      turn: { events: say('Looking.'), text: JSON.stringify({ script: 'npm ci' }) },
      projectPath: repoWithPackage(),
    });
    expect(state.script).toBe('npm ci');
    expect(state.status).toBe('done');
    expect(state.entries.some((e) => e.text.includes('Manifests suggest'))).toBe(true);
  });

  it('cannot write in the operator’s own checkout', async () => {
    const projectPath = repoWithPackage();
    const { oneShots } = await run({
      turn: { text: JSON.stringify({ script: 'npm ci' }) },
      projectPath,
    });
    expect(oneShots.calls).toHaveLength(1);
    expect(oneShots.calls[0]!.access).toBe('read');
    expect(oneShots.calls[0]!.cwd).toBe(projectPath);
  });

  it('parses a setup reply that only calls submit_result', async () => {
    const { state, oneShots } = await run({
      turn: { structuredOutput: { script: 'npm ci' } },
      projectPath: repoWithPackage(),
    });
    expect(state.script).toBe('npm ci');
    expect(state.status).toBe('done');
    expect(oneShots.calls[0]!.outputFormat?.type).toBe('json_schema');
    expect(oneShots.calls[0]!.systemPrompt).toContain('Call submit_result exactly once');
  });

  it('retries once when submit_result is missing, then accepts a structured correction', async () => {
    const { state, oneShots } = await run({
      turn: [{ text: 'I would run npm install.' }, { structuredOutput: { script: 'npm ci' } }],
      projectPath: repoWithPackage(),
    });
    expect(state.status).toBe('done');
    expect(state.script).toBe('npm ci');
    expect(oneShots.calls).toHaveLength(2);
    expect(oneShots.prompts[1]).toContain('Call submit_result exactly once');
  });

  it('keeps the raw reply when the answer cannot be parsed', async () => {
    const { state } = await run({
      turn: [{ text: 'I would run npm install.' }, { text: 'Still just prose.' }],
      projectPath: repoWithPackage(),
    });
    expect(state.status).toBe('failed');
    expect(state.rawReply).toContain('Still just prose');
    expect(state.detail).toMatch(/no JSON/);
  });
});
