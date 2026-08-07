import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DroidClient } from '../src/main/droid/client.js';
import { labelToolCall, toUsageBreakdown } from '../src/main/droid/events.js';
import { evaluate } from '../src/main/droid/permissions.js';
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
});

function client(
  scenario: string,
  opts: {
    model?: string;
    onPermission?: () => Promise<{ outcome: 'allow' | 'deny' }>;
  } = {},
): DroidClient {
  process.env.FAKE_SCENARIO = scenario;
  const c = new DroidClient({
    droidPath: fakeDroid,
    cwd,
    autonomy: 'medium',
    model: opts.model ?? 'fake-allowed',
    reasoningEffort: 'medium',
    onPermission: opts.onPermission ?? (async () => ({ outcome: 'allow' })),
  });
  open.push(c);
  return c;
}

type PermMethod = 'droid.request_permission' | 'droid.ask_user';
const perm = (
  params: Record<string, unknown>,
  method: PermMethod = 'droid.request_permission',
) => ({ method, params });

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

describe('permission policy', () => {
  const ctx = {
    autonomy: 'medium' as const,
    worktree: '/repo',
    writes: ['src/'],
    protectedPaths: [] as string[],
    allowedCommands: ['bun test'],
  };

  it('auto-approves read-only tools', () => {
    expect(evaluate(perm({ toolName: 'Read' }), ctx).decision).toEqual({ outcome: 'allow' });
  });

  it('auto-approves an in-boundary write inside the worktree', () => {
    const outcome = evaluate(perm({ toolName: 'Edit', file_path: '/repo/src/a.ts' }), ctx);
    expect(outcome.decision).toEqual({ outcome: 'allow' });
  });

  it('denies a write outside the boundary without asking anyone', () => {
    const outcome = evaluate(perm({ toolName: 'Edit', file_path: '/repo/infra/x.tf' }), ctx);
    expect(outcome.decision?.outcome).toBe('deny');
  });

  it('escalates a write outside the worktree entirely', () => {
    const outcome = evaluate(perm({ toolName: 'Edit', file_path: '/etc/hosts' }), ctx);
    expect(outcome.decision).toBeNull();
  });

  it('confirms every write at low autonomy', () => {
    const outcome = evaluate(perm({ toolName: 'Edit', file_path: '/repo/src/a.ts' }), {
      ...ctx,
      autonomy: 'low',
    });
    expect(outcome.decision).toBeNull();
  });

  it('auto-approves an allowlisted command and its arguments', () => {
    const outcome = evaluate(perm({ toolName: 'Execute', command: 'bun test src/a' }), ctx);
    expect(outcome.decision).toEqual({ outcome: 'allow' });
  });

  it('escalates a command that is not allowlisted at medium', () => {
    const outcome = evaluate(perm({ toolName: 'Execute', command: 'rm -rf /' }), ctx);
    expect(outcome.decision).toBeNull();
    expect(outcome.command).toBe('rm -rf /');
  });

  it('runs commands unattended at high autonomy', () => {
    const outcome = evaluate(perm({ toolName: 'Execute', command: 'curl example.com' }), {
      ...ctx,
      autonomy: 'high',
    });
    expect(outcome.decision).toEqual({ outcome: 'allow' });
  });

  it('always sends a question to a human', () => {
    const outcome = evaluate(perm({ question: 'which database?' }, 'droid.ask_user'), {
      ...ctx,
      autonomy: 'high',
    });
    expect(outcome.decision).toBeNull();
    expect(outcome.body).toContain('which database');
  });

  it('reads a command out of a nested tool payload', () => {
    const outcome = evaluate(
      perm({ toolUse: { name: 'Execute', input: { command: 'bun test' } } }),
      ctx,
    );
    expect(outcome.decision).toEqual({ outcome: 'allow' });
  });
});
