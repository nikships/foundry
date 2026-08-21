/**
 * `PiTransport` — the one place a vendor type is allowed to exist.
 *
 * Everything above it is already covered against `tests/scripted-transport.ts`,
 * which is the point of the seam. What is left, and what this file is for, is
 * the translation itself: what Foundry states when it opens a session, how a
 * turn's result is read back out, and the two places where Pi behaves unlike
 * the daemon that came before it (compaction and rewind happen in place).
 *
 * The vendor module is replaced with a scripted session rather than a real one.
 * A real one needs a provider, a credential, and a network, so the alternative
 * is not a better test, it is no test. The fake mirrors only what the transport
 * touches; if the transport starts touching something else, the fake will
 * throw rather than quietly return undefined.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { FoundryToolContext, TransportEvent } from '../../../src/main/pi/transport.js';

/** What `createAgentSession` was handed. Asserted on; never acted upon. */
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

interface SessionManagerCall {
  kind: 'create' | 'open';
  args: string[];
}

/** Every scripted double shares this, so a test can read what the code did. */
const spy = {
  creates: [] as CreateCall[],
  loaders: [] as LoaderCall[],
  settings: [] as Record<string, unknown>[],
  sessionManagers: [] as SessionManagerCall[],
  registeredTools: [] as string[],
  order: [] as string[],
  session: null as ScriptedPiSession | null,
  models: [] as PiModelStub[],
  fallbackMessage: undefined as string | undefined,
};

interface PiModelStub {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown>;
}

interface ScriptedAssistantMessage {
  role: 'assistant';
  stopReason: string;
  errorMessage?: string;
  usage?: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    reasoning?: number;
    cost: { total: number };
  };
}

/**
 * A stand-in for Pi's `AgentSession`, scripted per test.
 *
 * `turn` is what one `prompt()` does: the events it emits and the assistant
 * messages it leaves behind. That is the only asynchrony the transport cares
 * about, so the fake does not model an agent loop beyond it.
 */
class ScriptedPiSession {
  sessionId = 'pi-session-1';
  model: PiModelStub | null = null;
  thinkingLevel = 'medium';
  messages: ScriptedAssistantMessage[] = [];
  state = { messages: this.messages };
  agent = { state: { messages: [] as unknown[] } };
  lastText = '';
  contextUsage: { tokens: number; contextWindow: number } | undefined = undefined;
  activeTools: string[] = [];
  allTools: { name: string; description: string; sourceInfo: { source: string } }[] = [];
  aborts = 0;
  disposed = 0;
  compactions = 0;
  compactRemoves = 0;
  prompts: string[] = [];
  bound = false;
  /** Set by a test to script what one `prompt()` does. */
  turn: (session: ScriptedPiSession) => void | Promise<void> = () => {};
  /** Held open so a test can drive the timeout path. */
  hangUntilAbort = false;

  private subscriber: ((event: unknown) => void) | null = null;

  sessionManager = {
    entries: [] as { id: string; type: string; parentId?: string; message?: { role: string } }[],
    branched: [] as string[],
    resets: 0,
    getEntries(): { id: string; type: string; message?: { role: string } }[] {
      return this.entries;
    },
    getBranch(): { id: string; type: string; message?: { role: string } }[] {
      return this.entries;
    },
    getEntry(id: string): { id: string; parentId?: string } | undefined {
      return this.entries.find((e) => e.id === id);
    },
    branch(id: string): void {
      this.branched.push(id);
    },
    resetLeaf(): void {
      this.resets += 1;
    },
    buildSessionContext(): { messages: unknown[] } {
      return { messages: [{ role: 'user', content: 'rebuilt' }] };
    },
  };

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
    this.bound = true;
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

  getContextUsage(): { tokens: number; contextWindow: number } | undefined {
    return this.contextUsage;
  }

  getActiveToolNames(): string[] {
    return this.activeTools;
  }

  getAllTools(): { name: string; description: string; sourceInfo: { source: string } }[] {
    return this.allTools;
  }

  compact(): Promise<void> {
    this.compactions += 1;
    this.messages.splice(0, this.compactRemoves);
    return Promise.resolve();
  }

  dispose(): void {
    this.disposed += 1;
  }

  /** Convenience for the common "the turn produced one assistant message" case. */
  say(text: string, message: Partial<ScriptedAssistantMessage> = {}): void {
    this.lastText = text;
    this.messages.push({ role: 'assistant', stopReason: 'stop', ...message });
  }
}

vi.mock('@earendil-works/pi-coding-agent', () => ({
  // The real one is identity; the tool surface is covered in tests/pi-tools.test.ts.
  defineTool: (tool: unknown) => tool,
  SettingsManager: {
    inMemory: (settings: Record<string, unknown>, opts: Record<string, unknown>) => {
      spy.settings.push({ ...settings, ...opts });
      return { kind: 'settings' };
    },
  },
  SessionManager: {
    create: (...args: string[]) => {
      spy.sessionManagers.push({ kind: 'create', args });
      return spy.session!.sessionManager;
    },
    open: (...args: string[]) => {
      spy.sessionManagers.push({ kind: 'open', args });
      return spy.session!.sessionManager;
    },
    list: () => Promise.resolve([] as { id: string; path: string }[]),
  },
  DefaultResourceLoader: class {
    constructor(opts: LoaderCall) {
      spy.loaders.push(opts);
      // The factory has to run for the extension's tools to exist at all.
      for (const entry of opts.extensionFactories ?? []) {
        (entry as unknown as { factory: (api: unknown) => void }).factory({
          registerTool: (tool: { name: string }) => spy.registeredTools.push(tool.name),
          on: () => {},
        });
      }
    }
    reload(): Promise<void> {
      return Promise.resolve();
    }
  },
  createAgentSession: (opts: CreateCall & { model?: PiModelStub }) => {
    spy.creates.push(opts);
    spy.order.push('create');
    const session = spy.session!;
    if (opts.model) session.model = opts.model;
    session.thinkingLevel = opts.thinkingLevel;
    return Promise.resolve({
      session,
      ...(spy.fallbackMessage ? { modelFallbackMessage: spy.fallbackMessage } : {}),
    });
  },
}));

vi.mock('../../../src/main/pi/runtime.js', () => ({
  piStateDir: (supportDir: string) => join(supportDir, 'pi'),
  modelRuntime: () => Promise.resolve({ getAvailable: () => Promise.resolve(spy.models) }),
  resetModelRuntimes: () => {},
}));

const { PiTransport } = await import('../../../src/main/pi/pi-transport.js');
const { jsonSchemaFor } = await import('../../../src/main/engine/envelopes.js');

function toolContext(): FoundryToolContext {
  const support = tempDir('foundry-pi-tx-');
  const repo = tempDir('foundry-pi-tx-repo-');
  const tracer = new Tracer(openDb(projectDbPath(support, repo)), projectRunsDir(support, repo));
  return {
    runId: 'run_tx',
    agentName: 'builder',
    phaseId: () => null,
    envelopes: () => new Map(),
    tracer,
  };
}

interface Harness {
  transport: InstanceType<typeof PiTransport>;
  session: ScriptedPiSession;
  events: TransportEvent[];
  warnings: string[];
  supportDir: string;
  cwd: string;
}

function harness(
  opts: { model?: string; reasoningEffort?: string; toolProfile?: 'full' | 'read-only' } = {},
): Harness {
  const supportDir = tempDir('foundry-pi-support-');
  const cwd = tempDir('foundry-pi-cwd-');
  const events: TransportEvent[] = [];
  const warnings: string[] = [];
  const session = new ScriptedPiSession();
  spy.session = session;
  const transport = new PiTransport({
    cwd,
    runId: 'run_tx',
    model: opts.model ?? 'anthropic/claude-sonnet-4',
    reasoningEffort: (opts.reasoningEffort ?? 'medium') as never,
    ...(opts.toolProfile ? { toolProfile: opts.toolProfile } : {}),
    supportDir,
    sessionDir: join(supportDir, 'runs', 'run_tx', 'sessions'),
    tools: toolContext(),
    onPermission: () => ({ outcome: 'allow' }),
    onEvent: (e) => events.push(e),
    onModelWarning: (w) => warnings.push(w),
  });
  return { transport, session, events, warnings, supportDir, cwd };
}

beforeEach(() => {
  spy.creates = [];
  spy.loaders = [];
  spy.settings = [];
  spy.sessionManagers = [];
  spy.registeredTools = [];
  spy.order = [];
  spy.fallbackMessage = undefined;
  spy.models = [
    {
      provider: 'anthropic',
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      contextWindow: 200_000,
      thinkingLevelMap: { off: null, low: 1, medium: 2, high: 3 },
    },
    { provider: 'openai', id: 'gpt-5', name: 'GPT-5', contextWindow: 400_000, reasoning: true },
  ];
});

describe('opening a session', () => {
  it('keeps every path inside Foundry’s own directory, never the user’s ~/.pi', async () => {
    const h = harness();
    await h.transport.start();

    // The failure this guards against is silent: Pi's defaults would read and
    // write the developer's own install, and nothing would say so.
    expect(spy.creates[0]!.agentDir).toBe(join(h.supportDir, 'pi'));
    expect(spy.loaders[0]!.agentDir).toBe(join(h.supportDir, 'pi'));
    expect(spy.sessionManagers[0]!.args).toContain(
      join(h.supportDir, 'runs', 'run_tx', 'sessions'),
    );
    for (const call of [...spy.creates, ...spy.loaders]) {
      expect(JSON.stringify(call)).not.toContain('/.pi');
    }
  });

  it('runs the agent in the worktree', async () => {
    const h = harness();
    await h.transport.start();
    expect(spy.creates[0]!.cwd).toBe(h.cwd);
    expect(spy.loaders[0]!.cwd).toBe(h.cwd);
  });

  it('turns off every form of resource discovery', async () => {
    const h = harness();
    await h.transport.start();
    const loader = spy.loaders[0]!;
    // An agent's tools, prompt, and policy come from the roster and from
    // src/main/pi. Whatever the operator installed for their own pi must not
    // change what a run does.
    expect(loader.noExtensions).toBe(true);
    expect(loader.noSkills).toBe(true);
    expect(loader.noPromptTemplates).toBe(true);
    expect(loader.noThemes).toBe(true);
    expect(loader.noContextFiles).toBe(true);
    expect(loader.appendSystemPromptOverride?.([])).toEqual([]);
    const promptHarness = loader.systemPromptOverride?.(undefined) ?? '';
    expect(promptHarness).toMatch(/Foundry pipeline agent/i);
    expect(promptHarness.match(/submit_envelope/g)).toHaveLength(1);
    expect(promptHarness).toContain('when `approved` is false, report `status: "fail"` too');
  });

  it('installs Foundry’s extension inline, so nothing has to be discovered', async () => {
    const h = harness();
    await h.transport.start();
    expect(spy.loaders[0]!.extensionFactories.map((e) => e.name)).toEqual(['foundry']);
    expect(spy.registeredTools).toContain('report_progress');
    expect(spy.registeredTools).toContain('read_phase_context');
  });

  it('names Foundry’s tools alongside the built-ins, because the list is the allowlist', async () => {
    const h = harness();
    await h.transport.start();
    // A tool absent here is absent from the registry, not merely unadvertised.
    expect(spy.creates[0]!.tools).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'report_progress',
      'read_phase_context',
      'submit_envelope',
    ]);
  });

  it('opens a read-only agent’s session with no editing tool and no shell', async () => {
    const h = harness({ toolProfile: 'read-only' });
    await h.transport.start();
    // The roster says this agent changes nothing, and the tool list is how that
    // is true: `edit`, `write`, and `bash` are absent from the registry rather
    // than refused by a policy the agent can still call into.
    expect(spy.creates[0]!.tools).toEqual([
      'read',
      'grep',
      'find',
      'ls',
      'report_progress',
      'read_phase_context',
      'submit_envelope',
    ]);
    for (const tool of ['edit', 'write', 'bash']) {
      expect(spy.creates[0]!.tools).not.toContain(tool);
    }
  });

  it('gives an agent with no stated profile the full surface', async () => {
    const h = harness({ toolProfile: 'full' });
    await h.transport.start();
    expect(spy.creates[0]!.tools).toContain('bash');
    expect(spy.creates[0]!.tools).toContain('write');
  });

  it('leaves compaction to the engine and lets the runtime retry a flap', async () => {
    const h = harness();
    await h.transport.start();
    expect(spy.settings[0]).toMatchObject({
      compaction: { enabled: false },
      retry: { enabled: true },
      projectTrusted: true,
    });
  });

  it('binds extensions before anything can be prompted', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('done');
    await h.transport.send('go', 1000);
    // Unbound, the foundry extension's tools exist but its tool_call policy is
    // not live — every call in that turn would run unruled.
    expect(spy.order).toEqual(['create', 'bind', 'prompt']);
  });

  it('starts a fresh session when there is no id to resume', async () => {
    const h = harness();
    await h.transport.start();
    expect(spy.sessionManagers[0]!.kind).toBe('create');
  });

  it('starts fresh rather than failing when the id to resume has no file', async () => {
    const h = harness();
    await h.transport.start('pi-session-gone');
    // A missing session file is a resumable situation: losing the transcript
    // costs context, refusing to start costs the run.
    expect(spy.sessionManagers[0]!.kind).toBe('create');
  });
});

describe('choosing a model', () => {
  it('runs the model the roster asked for', async () => {
    const h = harness({ model: 'openai/gpt-5' });
    await h.transport.start();
    expect(spy.creates[0]!.model).toMatchObject({ provider: 'openai', id: 'gpt-5' });
    expect(h.warnings).toEqual([]);
    expect(h.transport.activeModel).toBe('openai/gpt-5');
  });

  it('accepts a bare model id, without the provider prefix', async () => {
    const h = harness({ model: 'gpt-5' });
    await h.transport.start();
    expect(spy.creates[0]!.model).toMatchObject({ id: 'gpt-5' });
  });

  it('states no model at all when the roster declined to choose', async () => {
    const h = harness({ model: 'inherit' });
    await h.transport.start();
    // Stating nothing lets the install's own default stand; stating a guess
    // would override a choice the operator actually made.
    expect(spy.creates[0]!.model).toBeUndefined();
  });

  it('falls back with a warning when the model is not available here', async () => {
    const h = harness({ model: 'anthropic/opus-99' });
    await h.transport.start();
    // The turn still runs, and the trace says what it ran on. A missing model
    // is a misconfiguration, not a reason to lose the run.
    expect(spy.creates[0]!.model).toMatchObject({ id: 'claude-sonnet-4' });
    expect(h.warnings[0]).toMatch(/opus-99 is not available/i);
    expect(h.warnings[0]).toMatch(/runs on anthropic\/claude-sonnet-4/i);
  });

  it('says so plainly when the install has no models at all', async () => {
    spy.models = [];
    const h = harness({ model: 'anthropic/opus-99' });
    await h.transport.start();
    expect(h.warnings[0]).toMatch(/neither is anything else/i);
  });

  it('passes the runtime’s own fallback message through', async () => {
    spy.fallbackMessage = 'that model needs a key; using another';
    const h = harness();
    await h.transport.start();
    expect(h.warnings).toContain('that model needs a key; using another');
  });

  it('reports the models this install can actually reach', async () => {
    const h = harness();
    await h.transport.start();
    expect(h.transport.availableModels.map((m) => m.id)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-5',
    ]);
    // Thinking levels come from the model's own map when it has one.
    expect(h.transport.availableModels[0]!.supportedReasoningEfforts).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(h.transport.availableModels[1]!.supportedReasoningEfforts).toEqual([
      'off',
      'low',
      'medium',
      'high',
    ]);
  });

  it('carries the reasoning effort onto the session', async () => {
    const h = harness({ reasoningEffort: 'high' });
    await h.transport.start();
    expect(spy.creates[0]!.thinkingLevel).toBe('high');
  });
});

describe('running a turn', () => {
  it('sends the user ask only; the role is not concatenated into the prompt', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('done');
    await h.transport.send('do the thing', 1000, { systemPrompt: 'You build.' });
    // The roster persona is installed as the system prompt. Stuffing it into
    // the user turn would replay it every phase and bust the prefix cache.
    expect(h.session.prompts).toEqual(['do the thing']);
  });

  it('returns the final text and the stop reason', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('  the answer  ');
    const result = await h.transport.send('go', 1000);
    expect(result.text).toBe('the answer');
    expect(result.reason).toBe('stop');
    expect(result.interrupted).toBe(false);
  });

  it('sums usage across the turn’s messages rather than reporting the last one', async () => {
    const h = harness();
    await h.transport.start();
    const usage = (input: number) => ({
      input,
      output: 10,
      cacheWrite: 1,
      cacheRead: 2,
      reasoning: 3,
      cost: { total: 0 },
    });
    h.session.turn = (s) => {
      s.emit({ type: 'message_end', message: { role: 'assistant', usage: usage(100) } });
      s.emit({ type: 'message_end', message: { role: 'assistant', usage: usage(50) } });
      s.say('done');
    };
    const result = await h.transport.send('go', 1000);
    // A turn is several assistant messages; billing the last one would
    // undercount every turn that used a tool.
    expect(result.usage).toEqual({
      inputTokens: 150,
      outputTokens: 20,
      cacheCreationTokens: 2,
      cacheReadTokens: 4,
      thinkingTokens: 6,
    });
  });

  it('starts each turn’s usage from zero', async () => {
    const h = harness();
    await h.transport.start();
    const emitUsage = (s: ScriptedPiSession): void =>
      s.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          usage: { input: 10, output: 1, cacheWrite: 0, cacheRead: 0, cost: { total: 0.001 } },
        },
      });
    h.session.turn = (s) => {
      emitUsage(s);
      s.say('one');
    };
    await h.transport.send('first', 1000);
    const second = await h.transport.send('second', 1000);
    // Usage is per turn in the trace; carrying it forward would make the last
    // phase of a run look like it used the whole run.
    expect(second.usage).toMatchObject({ inputTokens: 10 });
  });

  it('reports no usage for a turn the provider never accounted for', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('done');
    // Null rather than a row of zeros: an unmetered turn and a free turn are
    // different facts, and the trace should not claim the second one.
    expect((await h.transport.send('go', 1000)).usage).toBeNull();
  });

  it('ignores usage on a message that is not the assistant’s', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => {
      s.emit({
        type: 'message_end',
        message: {
          role: 'user',
          usage: { input: 999, output: 999, cacheWrite: 0, cacheRead: 0, cost: { total: 9 } },
        },
      });
      s.say('done');
    };
    expect((await h.transport.send('go', 1000)).usage).toBeNull();
  });

  it('reports an aborted turn as interrupted instead of throwing', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('partial', { stopReason: 'aborted' });
    const result = await h.transport.send('go', 1000);
    // A kill is an operator action, not a fault: the caller settles the run.
    expect(result.interrupted).toBe(true);
    expect(result.reason).toBe('aborted');
  });

  it('fails the turn loudly when the model ended in error', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('', { stopReason: 'error', errorMessage: 'provider said no' });
    await expect(h.transport.send('go', 1000)).rejects.toThrow(/provider said no/);
  });

  it('aborts and fails a turn that outlasts its timeout', async () => {
    const h = harness();
    await h.transport.start();
    h.session.hangUntilAbort = true;
    await expect(h.transport.send('go', 20)).rejects.toThrow(/timed out after 20ms/);
    // Abort, not just reject: an orphaned agent loop would keep writing to the
    // worktree after the phase was declared failed.
    expect(h.session.aborts).toBe(1);
  });

  it('refuses to run a turn before the session is open', async () => {
    const h = harness();
    await expect(h.transport.send('go', 1000)).rejects.toThrow(/not open/);
  });

  it('refuses to run a turn on a killed session', async () => {
    const h = harness();
    await h.transport.start();
    h.transport.kill();
    await expect(h.transport.send('go', 1000)).rejects.toThrow(/not (open|alive)/);
  });
});

describe('the envelope tool', () => {
  const build = jsonSchemaFor('build') as unknown as Record<string, unknown>;
  const review = jsonSchemaFor('review') as unknown as Record<string, unknown>;

  it('installs the phase’s schema when the turn asks for one', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('done');
    await h.transport.send('go', 1000, { outputFormat: { type: 'json_schema', schema: build } });
    expect(spy.registeredTools).toContain('submit_envelope');
  });

  it('does not re-register the same schema turn after turn', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('done');
    const format = { type: 'json_schema', schema: build } as const;
    await h.transport.send('one', 1000, { outputFormat: format });
    const after = spy.registeredTools.filter((t) => t === 'submit_envelope').length;
    await h.transport.send('two', 1000, { outputFormat: format });
    // The runtime caches a compiled validator against the schema object it
    // first saw, so re-registering an identical shape churns for nothing.
    expect(spy.registeredTools.filter((t) => t === 'submit_envelope').length).toBe(after);
  });

  it('swaps in a new tool when the phase’s schema changes', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('done');
    await h.transport.send('one', 1000, {
      outputFormat: { type: 'json_schema', schema: build },
    });
    const before = spy.registeredTools.filter((t) => t === 'submit_envelope').length;
    await h.transport.send('two', 1000, {
      outputFormat: { type: 'json_schema', schema: review },
    });
    // Mutating the live definition would keep the previous phase's validator,
    // so the whole definition is handed over.
    expect(spy.registeredTools.filter((t) => t === 'submit_envelope').length).toBe(before + 1);
  });

  it('reports nothing structured when the model never called the tool', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => s.say('prose only');
    const result = await h.transport.send('go', 1000, {
      outputFormat: { type: 'json_schema', schema: build },
    });
    // Null is what makes the caller fall back to parsing the text, which is
    // the whole point of treating structured output as a candidate.
    expect(result.structuredOutput).toBeNull();
  });
});

describe('translating the session’s events', () => {
  it('maps text, thinking, tools, and usage into neutral events', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => {
      s.emit({ type: 'message_start' });
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hel' },
      });
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'lo' },
      });
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', contentIndex: 0 },
      });
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', delta: 'hmm' },
      });
      s.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_end' } });
      s.emit({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'ls' },
      });
      s.emit({
        type: 'tool_execution_update',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'ls' },
        partialResult: { content: [{ type: 'text', text: 'a' }] },
      });
      s.emit({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        result: { content: [{ type: 'text', text: 'a.ts' }] },
        isError: false,
      });
      s.say('hello');
    };
    await h.transport.send('go', 1000);

    expect(h.events).toEqual([
      { type: 'text_delta', messageId: '1', blockIndex: 0, delta: 'hel' },
      { type: 'text_delta', messageId: '1', blockIndex: 0, delta: 'lo' },
      { type: 'text_end', messageId: '1', blockIndex: 0 },
      { type: 'thinking_delta', messageId: '1', delta: 'hmm' },
      { type: 'thinking_end', messageId: '1' },
      { type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'ls' } },
      { type: 'tool_output', callId: 'c1', content: 'a' },
      { type: 'tool_result', callId: 'c1', content: 'a.ts', isError: false },
    ]);
  });

  it('does not treat a user message_start as a new assistant id', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => {
      s.emit({ type: 'message_start', message: { role: 'user' } });
      s.emit({ type: 'message_start', message: { role: 'assistant' } });
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' },
      });
      s.say('hi');
    };
    await h.transport.send('go', 1000);
    expect(h.events.find((e) => e.type === 'text_delta')).toMatchObject({ messageId: '1' });
  });

  it('separates the text blocks of different messages', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => {
      s.emit({ type: 'message_start' });
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'first' },
      });
      s.emit({ type: 'message_start' });
      s.emit({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'second' },
      });
      s.say('done');
    };
    await h.transport.send('go', 1000);
    // Same block index, different message: without distinct ids the folder
    // would append the second message's prose onto the first one's row.
    const ids = h.events.map((e) => (e.type === 'text_delta' ? e.messageId : null));
    expect(ids).toEqual(['1', '2']);
  });

  it('joins a tool result’s text blocks and drops the rest', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => {
      s.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: {} });
      s.emit({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        result: {
          content: [
            { type: 'text', text: 'line one' },
            { type: 'image', data: 'ignored' },
            { type: 'text', text: 'line two' },
          ],
        },
        isError: false,
      });
      s.say('done');
    };
    await h.transport.send('go', 1000);
    const result = h.events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ content: 'line one\nline two' });
  });

  it('records a failed tool call as an error', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => {
      s.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: {} });
      s.emit({ type: 'tool_execution_end', toolCallId: 'c1', result: 'boom', isError: true });
      s.say('done');
    };
    await h.transport.send('go', 1000);
    expect(h.events.find((e) => e.type === 'tool_result')).toMatchObject({
      content: 'boom',
      isError: true,
    });
  });

  it('tolerates a tool call whose arguments are not an object', async () => {
    const h = harness();
    await h.transport.start();
    h.session.turn = (s) => {
      s.emit({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: 'nope' });
      s.say('done');
    };
    await h.transport.send('go', 1000);
    // A malformed frame must not take the run down; an empty object is the
    // honest reading and the policy still gets to rule on it.
    expect(h.events.find((e) => e.type === 'tool_call')).toMatchObject({ input: {} });
  });
});

describe('compaction and rewind', () => {
  it('compacts in place, keeping the same session', async () => {
    const h = harness();
    await h.transport.start();
    h.session.messages.push(...Array(5).fill({ role: 'assistant', stopReason: 'stop' }));
    h.session.compactRemoves = 3;
    const before = h.transport.id;

    expect(await h.transport.compact()).toEqual({ removedCount: 3 });
    // Unlike the daemon, there is no successor to adopt: nothing to swap, no
    // id to re-persist, no notifications to re-subscribe.
    expect(h.transport.id).toBe(before);
    expect(h.session.compactions).toBe(1);
  });

  it('has nothing to compact before the session is open', async () => {
    const h = harness();
    expect(await h.transport.compact()).toBeNull();
  });

  it('offers no files to restore, because the session keeps none', async () => {
    const h = harness();
    await h.transport.start();
    h.session.sessionManager.entries = [{ id: 'm1', type: 'message' }];
    // Empty lists are the honest answer; the worktree half of a rewind is
    // boundary.restoreToPhaseStart's job, from git.
    expect(await h.transport.getRewindInfo('m1')).toEqual({
      availableFiles: [],
      createdFiles: [],
      evictedFiles: [],
    });
  });

  it('declines to rewind to a message the session does not have', async () => {
    const h = harness();
    await h.transport.start();
    expect(await h.transport.getRewindInfo('nope')).toBeNull();
    expect(
      await h.transport.rewind({
        messageId: 'nope',
        filesToRestore: [],
        filesToDelete: [],
        forkTitle: 'x',
      }),
    ).toBeNull();
  });

  it('branches before the anchor, so the phase prompt is not replayed twice', async () => {
    const h = harness();
    await h.transport.start();
    h.session.sessionManager.entries = [
      { id: 'm0', type: 'message' },
      { id: 'm1', type: 'message', parentId: 'm0' },
    ];
    await h.transport.rewind({
      messageId: 'm1',
      filesToRestore: [],
      filesToDelete: [],
      forkTitle: 'retry',
    });
    // The anchor IS the phase's own first user message. Branching at it would
    // leave that prompt in context and the next turn would answer it twice.
    expect(h.session.sessionManager.branched).toEqual(['m0']);
    expect(h.session.agent.state.messages).toEqual([{ role: 'user', content: 'rebuilt' }]);
  });

  it('resets to the root when the anchor is the first message', async () => {
    const h = harness();
    await h.transport.start();
    h.session.sessionManager.entries = [{ id: 'm0', type: 'message' }];
    await h.transport.rewind({
      messageId: 'm0',
      filesToRestore: [],
      filesToDelete: [],
      forkTitle: 'retry',
    });
    expect(h.session.sessionManager.resets).toBe(1);
  });

  it('anchors a rewind on the last user message', async () => {
    const h = harness();
    await h.transport.start();
    h.session.sessionManager.entries = [
      { id: 'u1', type: 'message', message: { role: 'user' } },
      { id: 'a1', type: 'message', message: { role: 'assistant' } },
      { id: 'u2', type: 'message', message: { role: 'user' } },
      { id: 'a2', type: 'message', message: { role: 'assistant' } },
    ];
    expect(h.transport.lastUserMessageId).toBe('u2');
  });

  it('has no anchor before the session is open', () => {
    const h = harness();
    expect(h.transport.lastUserMessageId).toBeNull();
  });
});

describe('what the session can report', () => {
  it('reports context occupancy', async () => {
    const h = harness();
    await h.transport.start();
    h.session.contextUsage = { tokens: 30_000, contextWindow: 200_000 };
    expect(await h.transport.contextStats()).toEqual({
      used: 30_000,
      limit: 200_000,
      remaining: 170_000,
    });
  });

  it('reports nothing when the session has no usage yet', async () => {
    const h = harness();
    await h.transport.start();
    expect(await h.transport.contextStats()).toBeNull();
  });

  it('declines to invent a context breakdown', async () => {
    const h = harness();
    await h.transport.start();
    // Pi accounts for context as one number. Null leaves the last known
    // breakdown in place rather than showing a made-up composition.
    expect(await h.transport.contextBreakdown()).toBeNull();
  });

  it('has nothing to re-assert, and reports the model that is running', async () => {
    const h = harness({ model: 'openai/gpt-5' });
    await h.transport.start();
    // Model and thinking level are stated once at create and cannot drift, so
    // the reply exists only so the caller need not know which transport it is.
    expect(await h.transport.applySettings()).toEqual({ model: 'openai/gpt-5' });
  });

  it('owns no child process', async () => {
    const h = harness();
    await h.transport.start();
    // In-process: there is no pid to trace and nothing for killRun to signal.
    expect(h.transport.pid).toBeUndefined();
  });
});

describe('shutting down', () => {
  it('is not alive until it is started', () => {
    const h = harness();
    expect(h.transport.alive).toBe(false);
    expect(h.transport.id).toBeNull();
  });

  it('aborts, unsubscribes, and disposes on close', async () => {
    const h = harness();
    await h.transport.start();
    await h.transport.close();
    expect(h.session.aborts).toBe(1);
    expect(h.session.disposed).toBe(1);
    expect(h.transport.alive).toBe(false);
    // Unsubscribed, so a late event from the runtime cannot reach a folder
    // that has already closed its rows.
    h.session.emit({ type: 'message_start' });
    expect(h.events).toEqual([]);
  });

  it('disposes even when there was nothing running to abort', async () => {
    const h = harness();
    await h.transport.start();
    h.session.abort = () => Promise.reject(new Error('nothing running'));
    await h.transport.close();
    expect(h.session.disposed).toBe(1);
  });

  it('closes at most once', async () => {
    const h = harness();
    await h.transport.start();
    await h.transport.close();
    await h.transport.close();
    expect(h.session.disposed).toBe(1);
  });

  it('can be reopened after a kill', async () => {
    const h = harness();
    await h.transport.start();
    h.transport.kill();
    expect(h.transport.alive).toBe(false);
    await h.transport.start();
    // A run that lost its session mid-phase reopens rather than failing the
    // whole run; the executor's retry budget decides whether it is worth it.
    expect(h.transport.alive).toBe(true);
  });
});
