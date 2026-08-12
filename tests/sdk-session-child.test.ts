/**
 * SdkSession over a real child process, against the `tests/fake-droid.ts` stub.
 *
 * The scripted-transport suite in `sdk-session.test.ts` injects a transport and
 * therefore never exercises `spawnTransport()`: the pid the trace records, the
 * stderr pipe the doctor reads, and the exit code that must fail an in-flight
 * turn instead of hanging all only exist on this path.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SdkSession } from '../src/main/droid/sdk/session.js';
import { toUsageBreakdown } from '../src/main/droid/events.js';
import { writeFakeDroid } from './fake-droid.js';

let fakeDroid: string;
let cwd: string;
const open: SdkSession[] = [];

beforeAll(() => {
  fakeDroid = writeFakeDroid();
  cwd = mkdtempSync(join(tmpdir(), 'foundry-sdk-child-'));
});

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
  delete process.env.FAKE_SCENARIO;
});

function session(scenario: string): SdkSession {
  process.env.FAKE_SCENARIO = scenario;
  const sdk = new SdkSession({
    droidPath: fakeDroid,
    cwd,
    model: 'fake-allowed',
    reasoningEffort: 'medium',
    onPermission: () => ({ outcome: 'allow' }),
  });
  open.push(sdk);
  return sdk;
}

describe('a spawned session', () => {
  it('starts a child, records its pid, and applies the roster model', async () => {
    const sdk = session('happy');
    await sdk.start();
    expect(sdk.id).toBe('fake-session-1');
    expect(sdk.pid).toBeGreaterThan(0);
    expect(sdk.activeModel).toBe('fake-allowed');
    expect(sdk.availableModels.map((m) => m.id)).toContain('fake-allowed');
  });

  it('runs a turn to committed text with usage the cost rows can read', async () => {
    const sdk = session('happy');
    await sdk.start();
    const result = await sdk.send('do the thing', 20_000);
    expect(JSON.parse(result.text).status).toBe('success');
    expect(result.reason).toBe('completed');
    expect(toUsageBreakdown(result.usage).cacheReadTokens).toBe(900);
  });

  it('keeps the session when the model is refused, and says which model won', async () => {
    const warnings: string[] = [];
    process.env.FAKE_SCENARIO = 'reject-model';
    const sdk = new SdkSession({
      droidPath: fakeDroid,
      cwd,
      model: 'fake-allowed',
      reasoningEffort: 'medium',
      onPermission: () => ({ outcome: 'allow' }),
      onModelWarning: (warning) => warnings.push(warning),
    });
    open.push(sdk);
    await sdk.start();
    // A refused model is configuration, not a reason to drop a live child.
    expect(sdk.alive).toBe(true);
    const result = await sdk.send('do the thing', 20_000);
    expect(JSON.parse(result.text).status).toBe('success');
    expect(sdk.activeModel).toBe('gpt-fake-default');
    expect(warnings.join(' ')).toContain('fake-allowed');
  });

  it('surfaces a child that dies mid-turn as an error, not a hang', async () => {
    const sdk = session('die-on-first-turn');
    await sdk.start();
    await expect(sdk.send('this kills it', 20_000)).rejects.toThrow();
    expect(sdk.alive).toBe(false);
  });

  it('answers a server permission ask so the turn can proceed', async () => {
    process.env.FAKE_SCENARIO = 'ask-permission';
    let asked = 0;
    const sdk = new SdkSession({
      droidPath: fakeDroid,
      cwd,
      model: 'fake-allowed',
      reasoningEffort: 'medium',
      onPermission: () => {
        asked++;
        return { outcome: 'allow' };
      },
    });
    open.push(sdk);
    await sdk.start();
    const result = await sdk.send('needs permission', 20_000);
    expect(asked).toBe(1);
    expect(JSON.parse(result.text).status).toBe('success');
  });

  it('answers ask_user with one answer per question, not a verdict', async () => {
    process.env.FAKE_SCENARIO = 'ask-user';
    const answers = [{ index: 0, question: 'which database?', answer: 'postgres' }];
    const sdk = new SdkSession({
      droidPath: fakeDroid,
      cwd,
      model: 'fake-allowed',
      reasoningEffort: 'medium',
      onPermission: (ask) => {
        expect(ask.method).toBe('droid.ask_user');
        return { outcome: 'allow', answers };
      },
    });
    open.push(sdk);
    await sdk.start();
    const result = await sdk.send('needs an answer', 20_000);
    // The stub echoes back what it received, so this asserts the wire shape.
    const echoed = JSON.parse(JSON.parse(result.text).notes_for_next_agent) as {
      answers: { answer: string }[];
    };
    expect(echoed.answers).toEqual(answers);
  });

  it('cancels the questionnaire only when the decision carries no answers at all', async () => {
    process.env.FAKE_SCENARIO = 'ask-user';
    const sdk = new SdkSession({
      droidPath: fakeDroid,
      cwd,
      model: 'fake-allowed',
      reasoningEffort: 'medium',
      onPermission: () => ({ outcome: 'deny', reason: 'nope' }),
    });
    open.push(sdk);
    await sdk.start();
    const result = await sdk.send('needs an answer', 20_000);
    const echoed = JSON.parse(JSON.parse(result.text).notes_for_next_agent) as {
      cancelled?: boolean;
    };
    expect(echoed.cancelled).toBe(true);
  });
});
