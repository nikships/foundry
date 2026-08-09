import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  DroidClient,
  type PermissionAsk,
  type PermissionDecision,
} from '../src/main/droid/client.js';
import { labelToolCall, toUsageBreakdown } from '../src/main/droid/events.js';
import { writeFakeDroid } from './fake-droid.js';

let fakeDroid: string;
let cwd: string;
const open: DroidClient[] = [];

beforeAll(() => {
  fakeDroid = writeFakeDroid();
  cwd = mkdtempSync(join(tmpdir(), 'foundry-client-'));
});

afterEach(() => {
  while (open.length > 0) open.pop()?.kill();
  delete process.env.FAKE_FRAMES;
});

function client(
  scenario: string,
  opts: {
    model?: string;
    onPermission?: (ask: PermissionAsk) => Promise<PermissionDecision>;
  } = {},
): DroidClient {
  process.env.FAKE_SCENARIO = scenario;
  const c = new DroidClient({
    droidPath: fakeDroid,
    cwd,
    model: opts.model ?? 'fake-allowed',
    reasoningEffort: 'medium',
    onPermission: opts.onPermission ?? (async () => ({ outcome: 'allow' })),
  });
  open.push(c);
  return c;
}

/** Captures every frame the client writes, so the wire itself can be asserted. */
function recordFrames(): () => Record<string, unknown>[] {
  const path = join(mkdtempSync(join(tmpdir(), 'foundry-frames-')), 'frames.jsonl');
  writeFileSync(path, '');
  process.env.FAKE_FRAMES = path;
  return () =>
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('session lifecycle', () => {
  it('initialises, learns its session id, and reads the catalog', async () => {
    const c = client('happy');
    await c.start();
    expect(c.id).toBe('fake-session-1');
    expect(c.availableModels.map((m) => m.id)).toContain('fake-allowed');
  });

  it('applies the roster model to the live session', async () => {
    const c = client('happy');
    await c.start();
    expect(c.activeSettings.modelId).toBe('fake-allowed');
  });

  it('keeps the session when a model is refused, and says which model won', async () => {
    const c = client('reject-model');
    await c.start();
    // Policy refusal is configuration, not a reason to drop the session.
    expect(c.activeSettings.modelId).toBe('gpt-fake-default');
    const applied = await c.applySettings();
    expect(applied.warning).toContain('fake-allowed');
    expect(applied.model).toBe('gpt-fake-default');
  });

  it('reports context occupancy for the lane bar', async () => {
    const c = client('happy');
    await c.start();
    const stats = await c.contextStats();
    expect(stats).toMatchObject({ used: 1234, limit: 100000 });
  });

  it('lists tools for the tool-policy editor', async () => {
    const c = client('happy');
    await c.start();
    const tools = await c.listTools();
    expect(tools[0]).toMatchObject({ llmId: 'Execute' });
  });
});

describe('the autonomy level on the wire', () => {
  it('spawns at --auto high whatever the session is for', () => {
    const args = client('happy').spawnArgs();
    expect(args[args.indexOf('--auto') + 1]).toBe('high');
  });

  it('states autonomyLevel high explicitly on a fresh session', async () => {
    const frames = recordFrames();
    const c = client('happy');
    await c.start();
    const applied = frames().filter((f) => f.method === 'droid.update_session_settings');
    expect(applied.length).toBeGreaterThan(0);
    for (const frame of applied) {
      expect((frame.params as Record<string, unknown>).autonomyLevel).toBe('high');
    }
  });

  it('re-states it on a resumed session, which starts from stored settings', async () => {
    const frames = recordFrames();
    const c = client('happy');
    await c.start('fake-session-1');
    const loaded = frames().find((f) => f.method === 'droid.load_session');
    expect(loaded).toBeDefined();
    const applied = frames().filter((f) => f.method === 'droid.update_session_settings');
    expect(applied.length).toBeGreaterThan(0);
    for (const frame of applied) {
      expect((frame.params as Record<string, unknown>).autonomyLevel).toBe('high');
    }
  });
});

describe('turns', () => {
  it('returns the committed assistant text, not the delta stream', async () => {
    const c = client('happy');
    await c.start();
    const result = await c.send('do the thing', 20_000);
    expect(JSON.parse(result.text).status).toBe('success');
    expect(result.reason).toBe('completed');
  });

  it('reports usage from the completed turn', async () => {
    const c = client('happy');
    await c.start();
    const result = await c.send('do the thing', 20_000);
    const usage = toUsageBreakdown(result.usage);
    expect(usage.reported).toBe(true);
    expect(usage.cacheReadTokens).toBe(900);
  });

  it('reuses one session across turns', async () => {
    const c = client('happy');
    await c.start();
    await c.send('first', 20_000);
    await c.send('second', 20_000);
    expect(c.id).toBe('fake-session-1');
  });

  it('surfaces a child that dies mid-turn as an error, not a hang', async () => {
    const c = client('die-on-first-turn');
    await c.start();
    await expect(c.send('this kills it', 20_000)).rejects.toThrow(/exited/);
  });

  it('answers a server permission request so the turn can proceed', async () => {
    let asked = 0;
    const c = client('ask-permission', {
      onPermission: async () => {
        asked++;
        return { outcome: 'allow' };
      },
    });
    await c.start();
    const result = await c.send('needs permission', 20_000);
    expect(asked).toBe(1);
    expect(JSON.parse(result.text).status).toBe('success');
  });

  it('answers ask_user with one answer per question, not a verdict', async () => {
    const c = client('ask-user', {
      onPermission: async (ask) => {
        expect(ask.method).toBe('droid.ask_user');
        return {
          outcome: 'allow',
          answers: [{ index: 0, question: 'which database?', answer: 'postgres' }],
        };
      },
    });
    await c.start();
    const result = await c.send('needs an answer', 20_000);
    // The fake echoes back whatever it received, so this asserts the wire shape.
    const echoed = JSON.parse(JSON.parse(result.text).notes_for_next_agent) as {
      answers: { answer: string }[];
    };
    expect(echoed.answers).toEqual([{ index: 0, question: 'which database?', answer: 'postgres' }]);
  });

  it('cancels the questionnaire when the policy declines to answer', async () => {
    const c = client('ask-user', {
      onPermission: async () => ({ outcome: 'deny', reason: 'nope' }),
    });
    await c.start();
    const result = await c.send('needs an answer', 20_000);
    const echoed = JSON.parse(JSON.parse(result.text).notes_for_next_agent) as {
      cancelled?: boolean;
    };
    expect(echoed.cancelled).toBe(true);
  });
});

describe('tool-call labelling', () => {
  it('names a shell call by its command', () => {
    expect(
      labelToolCall({
        type: 'tool_use',
        id: '1',
        name: 'Execute',
        input: { command: 'bun test\nmore' },
      }),
    ).toBe('bash: bun test');
  });

  it('shortens a deep path but keeps the tail', () => {
    const label = labelToolCall({
      type: 'tool_use',
      id: '1',
      name: 'Read',
      input: { file_path: '/a/b/c/d/e.ts' },
    });
    expect(label).toBe('read: …/d/e.ts');
  });

  it('falls back to the tool name before arguments have arrived', () => {
    expect(labelToolCall({ type: 'tool_use', id: '1', name: 'Execute', input: {} })).toBe('bash');
  });

  it('is honest when usage was never reported', () => {
    expect(toUsageBreakdown(null).reported).toBe(false);
    expect(toUsageBreakdown(null).inputTokens).toBe(0);
  });
});
