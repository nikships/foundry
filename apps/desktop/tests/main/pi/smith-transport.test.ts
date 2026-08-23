/**
 * `SmithPiTransport` — what Foundry states when it opens Smith's chat session.
 *
 * Like `pi-transport.test.ts`, the vendor module is replaced with a scripted
 * session: a real one needs a provider, a credential, and a network. What is
 * asserted is the statement — paths pinned under the support dir, discovery
 * off, the Smith harness installed, full builtins plus the caller's custom
 * tools as the allowlist, and history resumed by id so a relaunch (or a model
 * switch's successor session) carries the transcript forward.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import type { ToolDefinition } from '../../../src/main/pi/tool-definition.js';
import type { ReasoningEffort } from '../../../src/shared/types.js';

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

const spy = {
  creates: [] as CreateCall[],
  loaders: [] as LoaderCall[],
  sessionManagers: [] as SessionManagerCall[],
  registeredTools: [] as string[],
  listed: [] as { id: string; path: string }[],
  session: null as ScriptedPiSession | null,
  models: [] as {
    provider: string;
    id: string;
    name: string;
    contextWindow: number;
    reasoning?: boolean;
    /** pi's own map; a null entry is a level this model does not have. */
    thinkingLevelMap?: Record<string, unknown>;
  }[],
};

class ScriptedPiSession {
  sessionId = 'smith-session-1';
  model: { provider: string; id: string; name: string } | null = null;
  thinkingLevel = 'medium';
  messages: { role: string; stopReason: string }[] = [];
  state = { messages: this.messages };
  lastText = '';
  prompts: string[] = [];
  aborts = 0;
  disposed = 0;

  private subscriber: ((event: unknown) => void) | null = null;

  sessionManager = {
    getBranch: () => [] as { id: string; type: string; message?: { role: string } }[],
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
    return Promise.resolve();
  }

  prompt(text: string): Promise<void> {
    this.prompts.push(text);
    this.lastText = 'answered';
    this.messages.push({ role: 'assistant', stopReason: 'stop' });
    return Promise.resolve();
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

  getContextUsage(): undefined {
    return undefined;
  }

  dispose(): void {
    this.disposed += 1;
  }
}

vi.mock('@earendil-works/pi-coding-agent', () => ({
  defineTool: (tool: unknown) => tool,
  SettingsManager: {
    inMemory: () => ({ kind: 'settings' }),
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
    list: () => Promise.resolve(spy.listed),
  },
  DefaultResourceLoader: class {
    constructor(opts: LoaderCall) {
      spy.loaders.push(opts);
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
  createAgentSession: (opts: CreateCall & { model?: { provider: string; id: string } }) => {
    spy.creates.push(opts);
    const session = spy.session!;
    if (opts.model) session.model = opts.model as ScriptedPiSession['model'];
    return Promise.resolve({ session });
  },
}));

vi.mock('../../../src/main/pi/runtime.js', () => ({
  piStateDir: (supportDir: string) => join(supportDir, 'pi'),
  modelRuntime: () => Promise.resolve({ getAvailable: () => Promise.resolve(spy.models) }),
  resetModelRuntimes: () => {},
}));

const { SmithPiTransport } = await import('../../../src/main/pi/smith-transport.js');
const { SMITH_CHAT_HARNESS } = await import('../../../src/main/smith/system-prompt.js');

// The vendor's defineTool is mocked to identity above, so a plain object
// carries through; the cast states the type the real seam would produce.
const entityTool = {
  name: 'smith_list',
  label: 'List entities',
  description: 'list',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: () =>
    Promise.resolve({ content: [{ type: 'text' as const, text: '[]' }], details: undefined }),
} as unknown as ToolDefinition;

function harness(
  opts: {
    model?: string;
    customTools?: ToolDefinition[];
    reasoningEffort?: ReasoningEffort;
  } = {},
) {
  const supportDir = tempDir('smith-tx-support-');
  const cwd = tempDir('smith-tx-cwd-');
  const warnings: string[] = [];
  const session = new ScriptedPiSession();
  spy.session = session;
  const transport = new SmithPiTransport({
    cwd,
    supportDir,
    sessionDir: join(supportDir, 'pi', 'smith', 'proj_1'),
    model: opts.model ?? 'anthropic/claude-sonnet-4',
    reasoningEffort: opts.reasoningEffort ?? 'medium',
    harness: SMITH_CHAT_HARNESS,
    customTools: opts.customTools ?? [entityTool],
    onPermission: () => ({ outcome: 'allow' }),
    onModelWarning: (w) => warnings.push(w),
  });
  return { transport, session, warnings, supportDir, cwd };
}

beforeEach(() => {
  spy.creates = [];
  spy.loaders = [];
  spy.sessionManagers = [];
  spy.registeredTools = [];
  spy.listed = [];
  spy.models = [
    {
      provider: 'anthropic',
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      contextWindow: 200_000,
      // No thinkingLevelMap: a reasoning model without one gets the
      // conservative off–high set every provider supports.
      reasoning: true,
    },
  ];
});

describe('opening the chat session', () => {
  it('pins every path under Foundry’s support dir, never ~/.pi', async () => {
    const h = harness();
    await h.transport.start();
    expect(spy.creates[0]!.agentDir).toBe(join(h.supportDir, 'pi'));
    expect(spy.sessionManagers[0]!.args).toContain(join(h.supportDir, 'pi', 'smith', 'proj_1'));
    for (const call of [...spy.creates, ...spy.loaders]) {
      expect(JSON.stringify(call)).not.toContain('/.pi');
    }
  });

  it('runs in the project checkout, not a worktree', async () => {
    const h = harness();
    await h.transport.start();
    expect(spy.creates[0]!.cwd).toBe(h.cwd);
  });

  it('keeps discovery off and installs the Smith harness as the system prompt', async () => {
    const h = harness();
    await h.transport.start();
    const loader = spy.loaders[0]!;
    expect(loader.noExtensions).toBe(true);
    expect(loader.noSkills).toBe(true);
    expect(loader.noPromptTemplates).toBe(true);
    expect(loader.noThemes).toBe(true);
    expect(loader.noContextFiles).toBe(true);
    expect(loader.systemPromptOverride?.(undefined)).toContain(
      "You are Smith, Foundry's entity-smith",
    );
  });

  it('opens with the full builtins plus the caller’s custom tools', async () => {
    const h = harness();
    await h.transport.start();
    // Smith is a full coding agent in the checkout on purpose; the entity
    // tools ride alongside because the list is the allowlist.
    expect(spy.creates[0]!.tools).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'smith_list',
    ]);
    expect(spy.registeredTools).toContain('smith_list');
  });

  it('resumes the persisted session by id — the relaunch and successor path', async () => {
    spy.listed = [{ id: 'smith-session-1', path: '/support/pi/smith/proj_1/s.jsonl' }];
    const h = harness();
    await h.transport.start('smith-session-1');
    expect(spy.sessionManagers[0]!.kind).toBe('open');
    expect(spy.sessionManagers[0]!.args[0]).toBe('/support/pi/smith/proj_1/s.jsonl');
  });

  it('starts fresh rather than failing when the id to resume has no file', async () => {
    const h = harness();
    await h.transport.start('gone-session');
    expect(spy.sessionManagers[0]!.kind).toBe('create');
  });

  it('falls back with a warning when the model is not available here', async () => {
    const h = harness({ model: 'provider/unreachable' });
    await h.transport.start();
    expect(h.warnings[0]).toMatch(/unreachable is not available/i);
    expect(spy.creates[0]!.model).toMatchObject({ id: 'claude-sonnet-4' });
  });
});

describe('reasoning effort', () => {
  it('states the requested level when the model offers it', async () => {
    const h = harness({ reasoningEffort: 'high' });
    await h.transport.start();
    expect(spy.creates[0]!.thinkingLevel).toBe('high');
    expect(h.transport.activeReasoningEffort).toBe('high');
  });

  it('clamps a level the model does not offer to that model’s default', async () => {
    spy.models = [
      {
        provider: 'anthropic',
        id: 'claude-sonnet-4',
        name: 'Claude Sonnet 4',
        contextWindow: 200_000,
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: null },
      },
    ];
    const h = harness({ reasoningEffort: 'max' });
    await h.transport.start();
    // `max` is null in this model's map: sending it would be rejected upstream.
    expect(spy.creates[0]!.thinkingLevel).toBe('medium');
    expect(h.transport.activeReasoningEffort).toBe('medium');
  });

  it('does not clamp a level a partial map adds rather than withholds', async () => {
    spy.models = [
      {
        provider: 'anthropic',
        id: 'claude-sonnet-4',
        name: 'Claude Sonnet 4',
        contextWindow: 200_000,
        reasoning: true,
        // The common shape: `max` on top of the standard four, nothing withheld.
        thinkingLevelMap: { max: 'max' },
      },
    ];
    const h = harness({ reasoningEffort: 'medium' });
    await h.transport.start();
    // Reading the map as an allowlist would have raised this to `max`.
    expect(spy.creates[0]!.thinkingLevel).toBe('medium');
  });

  it('keeps thinking on for a model that cannot turn it off', async () => {
    spy.models = [
      {
        provider: 'google',
        id: 'always-thinking',
        name: 'Always Thinking',
        contextWindow: 1_000_000,
        reasoning: true,
        thinkingLevelMap: { off: null },
      },
    ];
    const h = harness({ model: 'google/always-thinking', reasoningEffort: 'off' });
    await h.transport.start();
    // `off` is the one level this model does not have; it must not be sent.
    expect(spy.creates[0]!.thinkingLevel).toBe('medium');
  });

  it('clamps to off for a model with no reasoning at all', async () => {
    spy.models = [
      {
        provider: 'openai',
        id: 'plain-model',
        name: 'Plain',
        contextWindow: 128_000,
        reasoning: false,
      },
    ];
    const h = harness({ model: 'openai/plain-model', reasoningEffort: 'high' });
    await h.transport.start();
    expect(spy.creates[0]!.thinkingLevel).toBe('off');
  });

  it('takes the level as given when the runtime picked the model itself', async () => {
    // `inherit` resolves to no explicit model, so there is nothing to clamp
    // against — the runtime's own default model decides.
    const h = harness({ model: 'inherit', reasoningEffort: 'max' });
    await h.transport.start();
    expect(spy.creates[0]!.thinkingLevel).toBe('max');
  });
});

describe('running a chat turn', () => {
  it('sends the user message only and reads the final text back', async () => {
    const h = harness();
    await h.transport.start();
    const result = await h.transport.send('hello smith');
    expect(h.session.prompts).toEqual(['hello smith']);
    expect(result.text).toBe('answered');
    expect(result.structuredOutput).toBeNull();
  });

  it('never offers a rewind — correcting a chat is the next message', async () => {
    const h = harness();
    await h.transport.start();
    expect(await h.transport.getRewindInfo('m1')).toBeNull();
    expect(
      await h.transport.rewind({
        messageId: 'm1',
        filesToRestore: [],
        filesToDelete: [],
        forkTitle: 'x',
      }),
    ).toBeNull();
  });

  it('aborts, unsubscribes, and disposes on close', async () => {
    const h = harness();
    await h.transport.start();
    await h.transport.close();
    expect(h.session.aborts).toBe(1);
    expect(h.session.disposed).toBe(1);
    expect(h.transport.alive).toBe(false);
  });
});
