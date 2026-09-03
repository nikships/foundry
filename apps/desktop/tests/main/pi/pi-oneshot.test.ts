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
import { tempDir } from '../../helpers/tmp.js';
import type { OutputFormat, TransportEvent } from '../../../src/main/pi/transport.js';

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

interface PiModelStub {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  input: ('text' | 'image')[];
}

const spy = {
  creates: [] as CreateCall[],
  loaders: [] as LoaderCall[],
  settings: [] as Record<string, unknown>[],
  /** How the session store was made. `inMemory` means no file on disk. */
  sessionManagers: [] as { kind: string; args: unknown[] }[],
  order: [] as string[],
  session: null as ScriptedPiSession | null,
  models: [] as PiModelStub[],
  registeredTools: [] as {
    name: string;
    parameters: unknown;
    execute: (...args: unknown[]) => Promise<unknown>;
  }[],
};

/** A stand-in for Pi's `AgentSession`, scripted per test. */
class ScriptedPiSession {
  messages: { role: string; stopReason: string; errorMessage?: string }[] = [];
  state = { messages: this.messages };
  agent = { state: { messages: this.messages as unknown[] } };
  model: PiModelStub | null = null;
  thinkingLevel = 'off';
  lastText = '';
  aborts = 0;
  disposed = 0;
  prompts: string[] = [];
  promptOptions: unknown[] = [];
  customMessages: string[] = [];
  cycles = 0;
  turn: (session: ScriptedPiSession) => void | Promise<void> = (s) => s.say('done');
  /** Held open so a test can drive explicit cancellation. */
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

  async prompt(text: string, options?: unknown): Promise<void> {
    spy.order.push('prompt');
    this.prompts.push(text);
    this.promptOptions.push(options);
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

  async cycleModel(): Promise<
    | {
        model: PiModelStub;
        thinkingLevel: string;
        isScoped: boolean;
      }
    | undefined
  > {
    if (spy.models.length <= 1) return undefined;
    const current = spy.models.findIndex(
      (model) => model.provider === this.model?.provider && model.id === this.model.id,
    );
    const model = spy.models[(current + 1) % spy.models.length]!;
    this.model = model;
    this.cycles += 1;
    return { model, thinkingLevel: this.thinkingLevel, isScoped: false };
  }

  async sendCustomMessage(message: { content: string }): Promise<void> {
    this.customMessages.push(message.content);
    await this.turn(this);
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
      for (const entry of opts.extensionFactories) {
        (
          entry as unknown as {
            factory: (api: {
              registerTool: (tool: (typeof spy.registeredTools)[number]) => void;
              on: () => void;
            }) => void;
          }
        ).factory({
          registerTool: (tool) => {
            const at = spy.registeredTools.findIndex((candidate) => candidate.name === tool.name);
            if (at >= 0) spy.registeredTools[at] = tool;
            else spy.registeredTools.push(tool);
          },
          on: () => {},
        });
      }
    }
    reload(): Promise<void> {
      return Promise.resolve();
    }
  },
  createAgentSession: (opts: CreateCall) => {
    spy.creates.push(opts);
    spy.order.push('create');
    const session = spy.session!;
    session.model = opts.model
      ? (spy.models.find(
          (model) => model.provider === opts.model?.provider && model.id === opts.model.id,
        ) ?? null)
      : (spy.models[0] ?? null);
    return Promise.resolve({ session });
  },
}));

vi.mock('../../../src/main/pi/runtime.js', () => ({
  piStateDir: (supportDir: string) => join(supportDir, 'pi'),
  modelRuntime: () => Promise.resolve({ getAvailable: () => Promise.resolve(spy.models) }),
  resetModelRuntimes: () => {},
}));

const { piOneShots } = await import('../../../src/main/pi/pi-oneshot.js');

interface Harness {
  session: ScriptedPiSession;
  scripted: ScriptedPiSession;
  events: TransportEvent[];
  warnings: string[];
  supportDir: string;
  cwd: string;
  open: (access?: 'read' | 'write') => ReturnType<ReturnType<typeof piOneShots>>;
  openWithOutput: (outputFormat: OutputFormat) => ReturnType<ReturnType<typeof piOneShots>>;
}

function harness(opts: { model?: string; hiddenModelIds?: () => readonly string[] } = {}): Harness {
  const supportDir = tempDir('foundry-oneshot-support-');
  const cwd = tempDir('foundry-oneshot-cwd-');
  const events: TransportEvent[] = [];
  const warnings: string[] = [];
  const scripted = new ScriptedPiSession();
  spy.session = scripted;
  const factory = piOneShots(supportDir, opts.hiddenModelIds);
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
    openWithOutput: (outputFormat) =>
      factory({
        cwd,
        model: opts.model ?? 'anthropic/claude-sonnet-4',
        reasoningEffort: 'off',
        access: 'read',
        outputFormat,
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
  spy.registeredTools = [];
  spy.models = [
    {
      provider: 'anthropic',
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      contextWindow: 200_000,
      input: ['text', 'image'],
    },
  ];
});

describe('what a one-shot session is allowed to do', () => {
  it('hands a read-only session the four read tools and nothing else', async () => {
    const h = harness();
    await h.open('read').send('go');
    // Detection and the run-start fill run in the operator's own checkout.
    // There is no worktree to diff and nothing to revert a write, so the
    // absence of a write tool is the guarantee — not a policy that refuses.
    expect(spy.creates[0]!.tools).toEqual(['read', 'grep', 'find', 'ls']);
  });

  it('gives a write-capable session the built-ins it needs to do the job', async () => {
    const h = harness();
    await h.open('write').send('go');
    // Repair rebases and the readiness fix edits files; both run on an
    // isolated branch, which is what makes the wider list safe.
    expect(spy.creates[0]!.tools).toEqual(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  });

  it('registers no Foundry tools, because a one-shot has no run to report to', async () => {
    const h = harness();
    await h.open().send('go');
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
    await h.open().send('go');
    expect(spy.creates[0]!.agentDir).toBe(join(h.supportDir, 'pi'));
    expect(spy.loaders[0]!.agentDir).toBe(join(h.supportDir, 'pi'));
    for (const call of [...spy.creates, ...spy.loaders]) {
      expect(JSON.stringify(call)).not.toContain('/.pi');
    }
  });

  it('runs in the directory it was asked about', async () => {
    const h = harness();
    await h.open().send('go');
    expect(spy.creates[0]!.cwd).toBe(h.cwd);
    expect(spy.loaders[0]!.cwd).toBe(h.cwd);
  });

  it('writes no session file, because the answer is used and thrown away', async () => {
    const h = harness();
    await h.open().send('go');
    // A detection click should not leave a transcript on disk next to the
    // trace directories that runs own.
    expect(spy.sessionManagers.map((s) => s.kind)).toEqual(['inMemory']);
  });

  it('turns off every form of resource discovery', async () => {
    const h = harness();
    await h.open().send('go');
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

  it('leaves compaction off for a short-lived helper session', async () => {
    const h = harness();
    await h.open().send('go');
    expect(spy.settings[0]).toMatchObject({
      compaction: { enabled: false },
      httpIdleTimeoutMs: 300_000,
      retry: {
        enabled: true,
        maxRetries: 5,
        baseDelayMs: 2_000,
        provider: { maxRetries: 0 },
      },
    });
  });

  it('binds extensions before anything can be prompted', async () => {
    const h = harness();
    await h.open('write').send('go');
    // Unbound, the policy hook is registered but not live, and every tool call
    // in the turn would run unruled.
    expect(spy.order).toEqual(['create', 'bind', 'prompt']);
  });
});

describe('running one turn', () => {
  it('maps Foundry attachments onto Pi ImageContent, not the sdk.md source wrapper', async () => {
    const h = harness();
    await h.open().send('look', [{ mediaType: 'image/png', data: 'aaaa' }]);
    expect(h.session.promptOptions[0]).toMatchObject({
      expandPromptTemplates: false,
      source: 'extension',
      images: [{ type: 'image', data: 'aaaa', mimeType: 'image/png' }],
    });
    expect(JSON.stringify(h.session.promptOptions[0])).not.toContain('"source":{"type":"base64"');
  });

  it('refuses images before prompting a text-only model', async () => {
    spy.models[0]!.input = ['text'];
    const h = harness();

    await expect(h.open().send('look', [{ mediaType: 'image/png', data: 'aaaa' }])).rejects.toThrow(
      'anthropic/claude-sonnet-4 does not support image input. Choose an image-capable Orchestrator model.',
    );
    expect(h.session.prompts).toEqual([]);
    expect(h.session.disposed).toBe(1);
  });

  it('omits images on a text-only send', async () => {
    const h = harness();
    await h.open().send('look');
    expect(h.session.promptOptions[0]).toEqual({
      expandPromptTemplates: false,
      source: 'extension',
    });
  });

  it('returns the final text, trimmed', async () => {
    const h = harness();
    h.session.turn = (s) => s.say('  the answer  ');
    const result = await h.open().send('go');
    expect(result.text).toBe('the answer');
    expect(result.reason).toBe('stop');
    expect(result.interrupted).toBe(false);
    expect(result.structuredOutput).toBeNull();
  });

  it('captures a schema-bound submit_result separately from assistant prose', async () => {
    const h = harness();
    const schema = {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    h.session.turn = async (session) => {
      const tool = spy.registeredTools.find((candidate) => candidate.name === 'submit_result')!;
      await tool.execute('call-1', { answer: 'structured' });
      session.say('prose that the caller must not parse');
    };

    const result = await h
      .openWithOutput({ type: 'json_schema', schema })
      .send('return the answer');

    expect(spy.creates[0]!.tools).toEqual(['read', 'grep', 'find', 'ls', 'submit_result']);
    expect(
      spy.registeredTools.find((candidate) => candidate.name === 'submit_result')?.parameters,
    ).toBe(schema);
    expect(result.structuredOutput).toEqual({ answer: 'structured' });
    expect(result.text).toBe('prose that the caller must not parse');
  });

  it('disposes the session as soon as the answer arrives', async () => {
    const h = harness();
    await h.open().send('go');
    // Holding a session open would keep a model connection alive for a click
    // that has already been answered.
    expect(h.session.disposed).toBe(1);
  });

  it('disposes even when the turn failed', async () => {
    const h = harness();
    h.session.turn = (s) => s.say('', { stopReason: 'error', errorMessage: 'provider said no' });
    await expect(h.open().send('go')).rejects.toThrow(/provider said no/);
    expect(h.session.disposed).toBe(1);
  });

  it('continues a helper turn on the next model after retries are exhausted', async () => {
    spy.models.push({
      provider: 'openai',
      id: 'gpt-5',
      name: 'GPT-5',
      contextWindow: 400_000,
      input: ['text', 'image'],
    });
    const h = harness();
    let attempt = 0;
    h.session.turn = (s) => {
      if (attempt++ === 0) {
        s.emit({
          type: 'auto_retry_start',
          attempt: 5,
          maxAttempts: 5,
          delayMs: 32_000,
          errorMessage: 'rate limited',
        });
        s.emit({
          type: 'auto_retry_end',
          success: false,
          attempt: 5,
          finalError: 'rate limited',
        });
        s.say('', { stopReason: 'error', errorMessage: 'rate limited' });
        return;
      }
      s.say('recovered');
    };

    expect((await h.open().send('go')).text).toBe('recovered');
    expect(h.session.prompts).toEqual(['go']);
    expect(h.session.customMessages).toHaveLength(1);
    expect(h.session.cycles).toBe(1);
    expect(h.warnings.at(-1)).toContain('continuing this turn on openai/gpt-5');
  });

  it('skips a hidden fallback and continues on the next visible model', async () => {
    spy.models.push(
      {
        provider: 'openai',
        id: 'gpt-5',
        name: 'GPT-5',
        contextWindow: 400_000,
        input: ['text', 'image'],
      },
      {
        provider: 'google',
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        contextWindow: 1_000_000,
        input: ['text', 'image'],
      },
    );
    const h = harness({ hiddenModelIds: () => ['openai/gpt-5'] });
    let attempt = 0;
    h.session.turn = (s) => {
      if (attempt++ === 0) {
        s.emit({
          type: 'auto_retry_start',
          attempt: 5,
          maxAttempts: 5,
          delayMs: 32_000,
          errorMessage: 'rate limited',
        });
        s.emit({
          type: 'auto_retry_end',
          success: false,
          attempt: 5,
          finalError: 'rate limited',
        });
        s.say('', { stopReason: 'error', errorMessage: 'rate limited' });
        return;
      }
      s.say('recovered on visible');
    };

    expect((await h.open().send('go')).text).toBe('recovered on visible');
    expect(h.session.customMessages).toHaveLength(1);
    expect(h.warnings.at(-1)).toContain('continuing this turn on google/gemini-2.5-pro');
  });

  it('skips a text-only fallback when the interrupted turn has images', async () => {
    spy.models.push(
      {
        provider: 'openai',
        id: 'gpt-5',
        name: 'GPT-5',
        contextWindow: 400_000,
        input: ['text'],
      },
      {
        provider: 'google',
        id: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        contextWindow: 1_000_000,
        input: ['text', 'image'],
      },
    );
    const h = harness();
    let attempt = 0;
    h.session.turn = (session) => {
      if (attempt++ === 0) {
        session.emit({
          type: 'auto_retry_start',
          attempt: 5,
          maxAttempts: 5,
          delayMs: 32_000,
          errorMessage: 'rate limited',
        });
        session.emit({
          type: 'auto_retry_end',
          success: false,
          attempt: 5,
          finalError: 'rate limited',
        });
        session.say('', { stopReason: 'error', errorMessage: 'rate limited' });
        return;
      }
      session.say('recovered with images');
    };

    const result = await h.open().send('look', [{ mediaType: 'image/png', data: 'aaaa' }]);

    expect(result.text).toBe('recovered with images');
    expect(h.session.cycles).toBe(2);
    expect(h.session.customMessages).toHaveLength(1);
    expect(h.warnings.at(-1)).toContain('continuing this turn on google/gemini-2.5-pro');
  });

  it('keeps a turn alive until explicit cancellation, then reports it as interrupted', async () => {
    const h = harness();
    h.session.hangUntilAbort = true;
    const one = h.open();
    const running = one.send('go');
    await waitFor(() => h.session.prompts.length === 1);
    expect(h.session.aborts).toBe(0);
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
    const result = await one.send('go');
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
    await h.open().send('go');

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
    await h.open().send('go');
    // A one-shot is a button the operator pressed; substituting a model and
    // saying so beats refusing to answer.
    expect(spy.creates[0]!.model).toMatchObject({ id: 'claude-sonnet-4' });
    expect(h.warnings[0]).toMatch(/opus-99 is not available/i);
  });

  it('states no model when the caller inherits, letting the install decide', async () => {
    const h = harness({ model: 'inherit' });
    await h.open().send('go');
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
