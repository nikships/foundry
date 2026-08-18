/**
 * The Pi side of the one-shot seam.
 *
 * The five call sites are covered against `tests/scripted-oneshot.ts`, which is
 * what the seam is for. Left over, and what this file is for, is the part no
 * scripted double can check: what Foundry actually states when it opens one of
 * these sessions. Two of those statements are load-bearing.
 *
 * The first is the tool list. Detection and the run-start fill run in the
 * operator's own checkout — no worktree, no boundary diff, nothing that would
 * revert a write — so "read-only" has to mean the session was never given a
 * tool that could write, not that a policy would have said no.
 *
 * The second is where the session's state lives. Pi's defaults read the
 * developer's own `~/.pi`, so an unset path is not a crash, it is a session
 * quietly inheriting extensions and skills that this app never chose.
 *
 * As in `tests/pi-transport.test.ts`, the vendor module is replaced with a
 * scripted session: a real one needs a provider, a credential, and a network,
 * so the alternative is not a better test, it is no test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tempDir } from './tmp.js';
import type { TransportEvent } from '../src/main/pi/transport.js';

interface CreateCall {
  cwd: string;
  agentDir: string;
  tools: string[];
  thinkingLevel: string;
  model?: { provider: string; id: string };
}

interface LoaderCall {
  cwd: string;
  agentDir: string;
  noExtensions: boolean;
  noSkills: boolean;
  noPromptTemplates: boolean;
  noThemes: boolean;
  noContextFiles?: boolean;
  systemPromptOverride?: (base: string | undefined) => string | undefined;
  appendSystemPromptOverride?: (base: string[]) => string[];
  extensionFactories: { name: string; hidden?: boolean }[];
}

const spy = {
  creates: [] as CreateCall[],
  loaders: [] as LoaderCall[],
  settings: [] as Record<string, unknown>[],
  /** How the session store was made. `inMemory` means no file on disk. */
  sessionManagers: [] as { kind: string; args: unknown[] }[],
  order: [] as string[],
  session: null as ScriptedPiSession | null,
  models: [] as { provider: string; id: string; name: string; contextWindow: number }[],
};

/** A stand-in for Pi's `AgentSession`, scripted per test. */
class ScriptedPiSession {
  messages: { role: string; stopReason: string; errorMessage?: string }[] = [];
  state = { messages: this.messages };
  lastText = '';
  aborts = 0;
  disposed = 0;
  prompts: string[] = [];
  turn: (session: ScriptedPiSession) => void | Promise<void> = (s) => s.say('done');
  /** Held open so a test can drive the timeout and the abort paths. */
  hangUntilAbort = false;

  private subscriber: ((event: unknown) => void) | null = null;

  subscribe(cb: (event: unknown) => void): () => void {
    this.subscriber = cb;
    return () => {
      this.subscriber = null;
    };
  }

  emit(event: unknown): void {
    this.subscriber?.(event);
  }

  bindExtensions(): Promise<void> {
    spy.order.push('bind');
    return Promise.resolve();
  }

  async prompt(text: string): Promise<void> {
    spy.order.push('prompt');
    this.prompts.push(text);
    if (this.hangUntilAbort) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (this.aborts > 0) {
            clearInterval(check);
            resolve();
          }
        }, 5);
      });
      return;
    }
    await this.turn(this);
  }

  waitForIdle(): Promise<void> {
    return Promise.resolve();
  }

  abort(): Promise<void> {
    this.aborts += 1;
    return Promise.resolve();
  }

  getLastAssistantText(): string {
    return this.lastText;
  }

  dispose(): void {
    this.disposed += 1;
  }

  say(text: string, message: Partial<{ stopReason: string; errorMessage: string }> = {}): void {
    this.lastText = text;
    this.messages.push({ role: 'assistant', stopReason: 'stop', ...message });
  }
}

vi.mock('@earendil-works/pi-coding-agent', () => ({
  defineTool: (tool: unknown) => tool,
  SettingsManager: {
    inMemory: (settings: Record<string, unknown>, opts: Record<string, unknown>) => {
      spy.settings.push({ ...settings, ...opts });
      return { kind: 'settings' };
    },
  },
  SessionManager: {
    inMemory: (...args: unknown[]) => {
      spy.sessionManagers.push({ kind: 'inMemory', args });
      return { kind: 'sessions' };
    },
    create: (...args: unknown[]) => {
      spy.sessionManagers.push({ kind: 'create', args });
      return { kind: 'sessions' };
    },
    open: (...args: unknown[]) => {
      spy.sessionManagers.push({ kind: 'open', args });
      return { kind: 'sessions' };
    },
    list: () => Promise.resolve([] as { id: string; path: string }[]),
  },
  DefaultResourceLoader: class {
    constructor(opts: LoaderCall) {
      spy.loaders.push(opts);
    }
    reload(): Promise<void> {
      return Promise.resolve();
    }
  },
  createAgentSession: (opts: CreateCall) => {
    spy.creates.push(opts);
    spy.order.push('create');
    return Promise.resolve({ session: spy.session! });
  },
}));

vi.mock('../src/main/pi/runtime.js', () => ({
  piStateDir: (supportDir: string) => join(supportDir, 'pi'),
  modelRuntime: () => Promise.resolve({ getAvailable: () => Promise.resolve(spy.models) }),
  resetModelRuntimes: () => {},
}));

const { piOneShots } = await import('../src/main/pi/pi-oneshot.js');

interface Harness {
  session: ScriptedPiSession;
  scripted: ScriptedPiSession;
  events: TransportEvent[];
  warnings: string[];
  supportDir: string;
  cwd: string;
  open: (access?: 'read' | 'write') => ReturnType<ReturnType<typeof piOneShots>>;
}

function harness(opts: { model?: string } = {}): Harness {
  const supportDir = tempDir('foundry-oneshot-support-');
  const cwd = tempDir('foundry-oneshot-cwd-');
  const events: TransportEvent[] = [];
  const warnings: string[] = [];
  const scripted = new ScriptedPiSession();
  spy.session = scripted;
  const factory = piOneShots(supportDir);
  return {
    session: scripted,
    scripted,
    events,
    warnings,
    supportDir,
    cwd,
    open: (access = 'read') =>
      factory({
        cwd,
        model: opts.model ?? 'anthropic/claude-sonnet-4',
        reasoningEffort: 'off',
        access,
        onEvent: (e) => events.push(e),
        onWarning: (w) => warnings.push(w),
      }),
  };
}

beforeEach(() => {
  spy.creates = [];
  spy.loaders = [];
  spy.settings = [];
  spy.sessionManagers = [];
  spy.order = [];
  spy.models = [
    {
      provider: 'anthropic',
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      contextWindow: 200_000,
    },
  ];
});

describe('what a one-shot session is allowed to do', () => {
  it('hands a read-only session the four read tools and nothing else', async () => {
    const h = harness();
    await h.open('read').send('go', 1000);
    // Detection and the run-start fill run in the operator's own checkout.
    // There is no worktree to diff and nothing to revert a write, so the
    // absence of a write tool is the guarantee — not a policy that refuses.
    expect(spy.creates[0]!.tools).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('gives a write-capable session the built-ins it needs to do the job', async () => {
    const h = harness();
    await h.open('write').send('go', 1000);
    // Repair rebases and the readiness fix edits files; both run on an
    // isolated branch, which is what makes the wider list safe.
    expect(spy.creates[0]!.tools).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  });

  it('registers no Foundry tools, because a one-shot has no run to report to', async () => {
    const h = harness();
    await h.open().send('go', 1000);
    // The phase tools (report_progress, submit_envelope) need a run id and a
    // tracer. A one-shot has neither; offering them would be an invitation to
    // call something that cannot work.
    expect(spy.creates[0]!.tools).not.toContain('report_progress');
    expect(spy.creates[0]!.tools).not.toContain('submit_envelope');
    expect(spy.loaders[0]!.extensionFactories.map((e) => e.name)).toEqual(['foundry']);
  });
});

describe('where a one-shot session lives', () => {
  it('keeps every path inside Foundry’s own directory, never the user’s ~/.pi', async () => {
    const h = harness();
    await h.open().send('go', 1000);
    expect(spy.creates[0]!.agentDir).toBe(join(h.supportDir, 'pi'));
    expect(spy.loaders[0]!.agentDir).toBe(join(h.supportDir, 'pi'));
    for (const call of [...spy.creates, ...spy.loaders]) {
      expect(JSON.stringify(call)).not.toContain('/.pi');
    }
  });

  it('runs in the directory it was asked about', async () => {
    const h = harness();
    await h.open().send('go', 1000);
    expect(spy.creates[0]!.cwd).toBe(h.cwd);
    expect(spy.loaders[0]!.cwd).toBe(h.cwd);
  });

  it('writes no session file, because the answer is used and thrown away', async () => {
    const h = harness();
    await h.open().send('go', 1000);
    // A detection click should not leave a transcript on disk next to the
    // trace directories that runs own.
    expect(spy.sessionManagers.map((s) => s.kind)).toEqual(['inMemory']);
  });

  it('turns off every form of resource discovery', async () => {
    const h = harness();
    await h.open().send('go', 1000);
    const loader = spy.loaders[0]!;
    // Same rule as a run: whatever the operator installed for their own pi
    // must not change what this app does on their behalf.
    expect(loader.noExtensions).toBe(true);
    expect(loader.noSkills).toBe(true);
    expect(loader.noPromptTemplates).toBe(true);
    expect(loader.noThemes).toBe(true);
    expect(loader.noContextFiles).toBe(true);
    expect(loader.appendSystemPromptOverride?.([])).toEqual([]);
    expect(loader.systemPromptOverride?.(undefined)).toMatch(/Foundry helper/i);
  });

  it('leaves compaction off, since one bounded question cannot need it', async () => {
    const h = harness();
    await h.open().send('go', 1000);
    expect(spy.settings[0]).toMatchObject({
      compaction: { enabled: false },
      retry: { enabled: true },
    });
  });

  it('binds extensions before anything can be prompted', async () => {
    const h = harness();
    await h.open('write').send('go', 1000);
    // Unbound, the policy hook is registered but not live, and every tool call
    // in the turn would run unruled.
    expect(spy.order).toEqual(['create', 'bind', 'prompt']);
  });
});

describe('running one turn', () => {
  it('returns the final text, trimmed', async () => {
    const h = harness();
    h.session.turn = (s) => s.say('  the answer  ');
    const result = await h.open().send('go', 1000);
    expect(result.text).toBe('the answer');
    expect(result.reason).toBe('stop');
    expect(result.interrupted).toBe(false);
  });

  it('disposes the session as soon as the answer arrives', async () => {
    const h = harness();
    await h.open().send('go', 1000);
    // Holding a session open would keep a model connection alive for a click
    // that has already been answered.
    expect(h.session.disposed).toBe(1);
  });

  it('disposes even when the turn failed', async () => {
    const h = harness();
    h.session.turn = (s) => s.say('', { stopReason: 'error', errorMessage: 'provider said no' });
    await expect(h.open().send('go', 1000)).rejects.toThrow(/provider said no/);
    expect(h.session.disposed).toBe(1);
  });

  it('aborts and fails a turn that outlasts its timeout', async () => {
    const h = harness();
    h.session.hangUntilAbort = true;
    await expect(h.open().send('go', 20)).rejects.toThrow(/timed out after 20ms/);
    // Abort, not just reject: an orphaned agent loop would keep working in a
    // directory nobody is watching any more.
    expect(h.session.aborts).toBe(1);
    expect(h.session.disposed).toBe(1);
  });

  it('reports a cancelled turn as interrupted rather than throwing', async () => {
    const h = harness();
    h.session.hangUntilAbort = true;
    const one = h.open();
    const running = one.send('go', 5_000);
    await waitFor(() => h.session.prompts.length === 1);
    one.abort();
    const result = await running;
    // A cancel is an operator action, not a fault: the caller shows
    // "Cancelled." rather than an error.
    expect(result.interrupted).toBe(true);
    expect(h.session.aborts).toBe(1);
  });

  it('does not run a turn at all when the cancel beat the session opening', async () => {
    const h = harness();
    const one = h.open();
    one.abort();
    const result = await one.send('go', 1000);
    expect(result.interrupted).toBe(true);
    // The window between the click and the first token is where a cancel most
    // often lands, and a turn started there is one nobody is waiting for.
    expect(h.session.prompts).toEqual([]);
  });

  it('streams the turn’s events out in neutral form', async () => {
    const h = harness();
    h.session.turn = (s) => {
      s.emit({ type: 'message_start' });
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'looking' },
      });
      s.emit({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'read',
        args: { path: 'package.json' },
      });
      s.emit({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        result: { content: [{ type: 'text', text: '{}' }] },
        isError: false,
      });
      s.say('done');
    };
    await h.open().send('go', 1000);

    // The same event shapes a phase produces, so the detection panel and the
    // run inspector fold identical rows.
    expect(h.events).toEqual([
      { type: 'text_delta', messageId: '1', blockIndex: 0, delta: 'looking' },
      { type: 'tool_call', callId: 'c1', tool: 'read', input: { path: 'package.json' } },
      { type: 'tool_result', callId: 'c1', content: '{}', isError: false },
    ]);
  });

  it('warns rather than failing when the requested model is not installed', async () => {
    const h = harness({ model: 'anthropic/opus-99' });
    await h.open().send('go', 1000);
    // A one-shot is a button the operator pressed; substituting a model and
    // saying so beats refusing to answer.
    expect(spy.creates[0]!.model).toMatchObject({ id: 'claude-sonnet-4' });
    expect(h.warnings[0]).toMatch(/opus-99 is not available/i);
  });

  it('states no model when the caller inherits, letting the install decide', async () => {
    const h = harness({ model: 'inherit' });
    await h.open().send('go', 1000);
    expect(spy.creates[0]!.model).toBeUndefined();
  });
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the session');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
