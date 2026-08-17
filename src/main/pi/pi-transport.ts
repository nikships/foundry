/**
 * `AgentTransport` over an in-process Pi agent session.
 *
 * The agent runs inside this process rather than behind a daemon or a child,
 * which is the point of the migration: no wire protocol, no second permission
 * model, no MCP server to stand up for two tools. Everything below is the
 * translation between what `AgentSession` asks for and what Pi offers, kept in
 * one file so nothing above it names a vendor.
 *
 * Two things are deliberately different from the daemon transport:
 * - Compaction happens in place. Pi compacts the same session rather than
 *   handing back a successor, so there is nothing to swap or re-persist.
 * - Rewind is a leaf move in the session tree, not a file restore. Pi keeps no
 *   file snapshots, so the worktree half is `boundary.restoreToPhaseStart`'s
 *   job (it already was, for everything the daemon could not restore either).
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession as PiAgentSession,
  type AgentSessionEvent,
  type getLastAssistantUsage,
} from '@earendil-works/pi-coding-agent';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextBreakdown } from '@shared/types.js';
import { INHERIT_MODEL } from '../droid/turn.js';
import { foundryExtension } from './policy-extension.js';
import { modelRuntime } from './runtime.js';
import { submitEnvelopeTool, type EnvelopeTool } from './tools.js';
import type {
  AgentTransport,
  AgentTransportOptions,
  ContextStats,
  FoundryToolContext,
  RewindInfo,
  RewindOutcome,
  RewindParams,
  SessionTool,
  TransportEvent,
  TransportModel,
  TurnOptions,
  TurnResult,
  TurnUsage,
} from './transport.js';

/** Pi's built-ins. Foundry runs all of them; none of them prompts a human. */
const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * Pi's model, thinking-level, and usage types, derived from its own surface.
 *
 * Their declaring packages (`pi-agent-core`, `pi-ai`) are transitive
 * dependencies of `pi-coding-agent` rather than Foundry's own, so naming them
 * in an import would be a dependency this app does not declare. Reading them
 * back off the API keeps them exact without adding one.
 */
type PiModel = NonNullable<PiAgentSession['model']>;
type PiThinkingLevel = PiAgentSession['thinkingLevel'];
type PiUsage = NonNullable<ReturnType<typeof getLastAssistantUsage>>;

export interface PiTransportOptions extends AgentTransportOptions {
  /** Foundry's Application Support directory; pi state lives under it. */
  supportDir: string;
  /** Where this run's session files go — under the run's own trace directory. */
  sessionDir: string;
  /** What Foundry's own tools close over. */
  tools: FoundryToolContext;
}

export class PiTransport implements AgentTransport {
  private session: PiAgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly extension: ReturnType<typeof foundryExtension>;
  private envelopeTool: EnvelopeTool | null = null;
  private envelopeSchemaKey = '';
  private models: TransportModel[] = [];
  private resolvedModel: PiModel | null = null;
  private closed = false;
  /** Distinguishes text blocks of different messages in the folded trace. */
  private messageSeq = 0;
  private turnUsage: TurnUsage | null = null;

  constructor(private readonly opts: PiTransportOptions) {
    this.extension = foundryExtension({
      tools: opts.tools,
      decide: (ask) => opts.onPermission(ask),
    });
  }

  get id(): string | null {
    return this.session?.sessionId ?? null;
  }

  get alive(): boolean {
    return !!this.session && !this.closed;
  }

  /** In-process: there is no child to record or kill. */
  get pid(): number | undefined {
    return undefined;
  }

  get lastUserMessageId(): string | null {
    const session = this.session;
    if (!session) return null;
    const entries = session.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type === 'message' && entry.message.role === 'user') return entry.id;
    }
    return null;
  }

  get availableModels(): TransportModel[] {
    return this.models;
  }

  get activeModel(): string {
    const model = this.session?.model ?? this.resolvedModel;
    return model ? `${model.provider}/${model.id}` : this.opts.model;
  }

  async start(existingSessionId?: string | null): Promise<void> {
    this.closed = false;
    const runtime = await modelRuntime(this.opts.supportDir);
    const available = await runtime.getAvailable();
    this.models = available.map(toTransportModel);

    const picked = this.pickModel(available);
    this.resolvedModel = picked.model;
    if (picked.warning) this.opts.onModelWarning?.(picked.warning);

    mkdirSync(this.opts.sessionDir, { recursive: true });
    const sessionManager = this.openSessionManager(existingSessionId);
    // Compaction off: the engine compacts between phases, where it can trace
    // what it did. Retry on: a dropped stream is a transport flap, and failing
    // the phase for one would spend an envelope attempt on nothing.
    const settingsManager = SettingsManager.inMemory(
      { compaction: { enabled: false }, retry: { enabled: true } },
      { projectTrusted: true },
    );
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.opts.cwd,
      // Every discoverable resource is off: an agent's tools, prompt, and
      // policy come from the roster and this file, so whatever the operator
      // has installed for their own pi must not change what a run does.
      agentDir: join(this.opts.supportDir, 'pi'),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [{ name: 'foundry', factory: this.extension.factory, hidden: true }],
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd: this.opts.cwd,
      agentDir: join(this.opts.supportDir, 'pi'),
      modelRuntime: runtime,
      ...(picked.model ? { model: picked.model } : {}),
      thinkingLevel: thinkingLevelFor(this.opts.reasoningEffort),
      // Also the allowlist: a tool absent here is absent from the registry, so
      // Foundry's own tools have to be named alongside the built-ins.
      tools: [...BUILTIN_TOOLS, 'report_progress', 'read_phase_context', 'submit_envelope'],
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    if (created.modelFallbackMessage) this.opts.onModelWarning?.(created.modelFallbackMessage);

    const session = created.session;
    this.session = session;
    // Extensions must bind before the first prompt: unbound, the foundry
    // extension's tools are registered but its tool_call policy is not live.
    await session.bindExtensions({
      mode: 'print',
      onError: (err) =>
        this.opts.onModelWarning?.(`extension error (${err.extensionPath}): ${err.error}`),
    });
    this.unsubscribe = session.subscribe((event) => this.absorb(event));
  }

  async send(text: string, timeoutMs: number, opts: TurnOptions = {}): Promise<TurnResult> {
    const session = this.session;
    if (!session) throw new Error('pi session is not open');
    if (!this.alive) throw new Error('pi session is not alive');

    // Between turns is the only safe moment to change the envelope tool: the
    // model is looking at whatever schema was live when the turn started.
    this.useEnvelopeSchema(opts.outputFormat?.schema ?? null);
    this.turnUsage = null;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, timeoutMs);
    try {
      await session.prompt(text, { expandPromptTemplates: false, source: 'extension' });
      // prompt() resolves when the agent loop exits; a retry or an auto
      // continuation can still be in flight behind it.
      await session.waitForIdle();
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new Error(`turn timed out after ${timeoutMs}ms`);

    const last = lastAssistant(session);
    const interrupted = last?.stopReason === 'aborted';
    if (last?.stopReason === 'error') {
      throw new Error(last.errorMessage || 'the model ended the turn with an error');
    }

    return {
      text: (session.getLastAssistantText() ?? '').trim(),
      usage: this.turnUsage,
      reason: last?.stopReason ?? 'stop',
      interrupted,
      structuredOutput: this.envelopeTool?.submitted() ?? null,
    };
  }

  /**
   * Model and thinking level are stated at create and never drift, so there is
   * nothing to re-assert. The reply exists so the caller does not have to know
   * which transport it is talking to.
   */
  applySettings(): Promise<{ model: string; warning?: string }> {
    return Promise.resolve({ model: this.activeModel });
  }

  contextStats(): Promise<ContextStats | null> {
    const usage = this.session?.getContextUsage();
    if (!usage) return Promise.resolve(null);
    const used = usage.tokens ?? 0;
    return Promise.resolve({
      used,
      limit: usage.contextWindow,
      remaining: Math.max(0, usage.contextWindow - used),
    });
  }

  /**
   * Pi accounts for context as a single number, not by category, so there is
   * no honest breakdown to give. Null leaves the last known one in place
   * rather than showing an invented composition.
   */
  contextBreakdown(): Promise<ContextBreakdown | null> {
    return Promise.resolve(null);
  }

  /**
   * Compacts the live session in place. Pi summarizes and keeps the same
   * session, so unlike the daemon there is no successor to adopt and no id to
   * re-persist.
   */
  async compact(): Promise<{ removedCount: number } | null> {
    const session = this.session;
    if (!session) return null;
    const before = session.messages.length;
    await session.compact();
    return { removedCount: Math.max(0, before - session.messages.length) };
  }

  /**
   * Pi keeps no file snapshots, so nothing can be restored from the session
   * itself. The empty lists are the honest answer, and the caller reads them
   * as "rewind the conversation, restore the worktree from git".
   */
  getRewindInfo(messageId: string): Promise<RewindInfo | null> {
    const session = this.session;
    if (!session) return Promise.resolve(null);
    if (!session.sessionManager.getEntry(messageId)) return Promise.resolve(null);
    return Promise.resolve({ availableFiles: [], createdFiles: [], evictedFiles: [] });
  }

  /**
   * Move the session's leaf back to the anchor message. The session is
   * append-only: the abandoned branch stays on disk, and the next turn becomes
   * a sibling of the message that went wrong rather than a reply to it.
   */
  rewind(params: RewindParams): Promise<RewindOutcome | null> {
    const session = this.session;
    if (!session) return Promise.resolve(null);
    const entry = session.sessionManager.getEntry(params.messageId);
    if (!entry) return Promise.resolve(null);

    // Branch before the anchor, not at it: the anchor IS the phase's first
    // user message, and keeping it would replay the phase prompt twice.
    if (entry.parentId) session.sessionManager.branch(entry.parentId);
    else session.sessionManager.resetLeaf();
    session.agent.state.messages = session.sessionManager.buildSessionContext().messages;

    return Promise.resolve({
      restoredCount: 0,
      deletedCount: 0,
      failedRestoreCount: 0,
      failedDeleteCount: 0,
    });
  }

  listTools(): Promise<SessionTool[]> {
    const session = this.session;
    if (!session) return Promise.resolve([]);
    const active = new Set(session.getActiveToolNames());
    return Promise.resolve(
      session.getAllTools().map((tool) => ({
        id: tool.name,
        displayName: tool.name,
        description: tool.description,
        category: tool.sourceInfo.source,
        defaultAllowed: true,
        allowed: active.has(tool.name),
      })),
    );
  }

  async interrupt(): Promise<void> {
    await this.session?.abort();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      await session.abort();
    } catch {
      // Nothing was running; disposal is what matters.
    }
    session.dispose();
  }

  kill(): void {
    this.closed = true;
    void this.close();
  }

  /**
   * Swap in the tool that carries this phase's envelope schema.
   *
   * Keyed on the schema, not called blindly: pi-ai caches a compiled validator
   * against the schema object it first saw, so re-registering the same shape
   * every turn would churn the registry for nothing, and mutating the live
   * definition would keep the previous phase's validator.
   */
  private useEnvelopeSchema(schema: Record<string, unknown> | null): void {
    if (!schema) return;
    const key = JSON.stringify(schema);
    if (key === this.envelopeSchemaKey && this.envelopeTool) return;
    this.envelopeSchemaKey = key;
    this.envelopeTool = submitEnvelopeTool(schema);
    this.extension.useEnvelopeTool(this.envelopeTool);
  }

  /**
   * Resume the run's own session file when there is one, otherwise start a new
   * session in the run's directory. Sessions live with the run's other raw
   * records, never in the user's `~/.pi`.
   */
  private openSessionManager(existingSessionId?: string | null): SessionManager {
    if (existingSessionId) {
      const file = this.sessionFileFor(existingSessionId);
      if (file) return SessionManager.open(file, this.opts.sessionDir, this.opts.cwd);
    }
    return SessionManager.create(this.opts.cwd, this.opts.sessionDir);
  }

  private sessionFileFor(sessionId: string): string | null {
    try {
      const match = readdirSync(this.opts.sessionDir).find((name) =>
        name.endsWith(`_${sessionId}.jsonl`),
      );
      return match ? join(this.opts.sessionDir, match) : null;
    } catch {
      return null;
    }
  }

  /**
   * Pick the model the roster asked for. A roster may decline to choose, and a
   * model the install cannot reach is a warning rather than a failure: the
   * turn still runs, on something, and the trace says what happened.
   */
  private pickModel(available: readonly PiModel[]): {
    model: PiModel | null;
    warning?: string;
  } {
    const wanted = this.opts.model;
    if (!wanted || wanted === INHERIT_MODEL) return { model: null };
    const match = available.find(
      (model) => `${model.provider}/${model.id}` === wanted || model.id === wanted,
    );
    if (match) return { model: match };
    const fallback = available[0] ?? null;
    return {
      model: fallback,
      warning: fallback
        ? `${wanted} is not available to this install; this session runs on ${fallback.provider}/${fallback.id}`
        : `${wanted} is not available to this install, and neither is anything else`,
    };
  }

  /** Pi's session events, translated into the neutral stream the folder eats. */
  private absorb(event: AgentSessionEvent): void {
    const emit = (e: TransportEvent): void => this.opts.onEvent?.(e);
    switch (event.type) {
      case 'message_start':
        this.messageSeq += 1;
        return;
      case 'message_update': {
        const inner = event.assistantMessageEvent;
        const messageId = String(this.messageSeq);
        if (inner.type === 'text_delta') {
          emit({
            type: 'text_delta',
            messageId,
            blockIndex: inner.contentIndex,
            delta: inner.delta,
          });
        } else if (inner.type === 'text_end') {
          emit({ type: 'text_end', messageId, blockIndex: inner.contentIndex });
        } else if (inner.type === 'thinking_delta') {
          emit({ type: 'thinking_delta', messageId, delta: inner.delta });
        } else if (inner.type === 'thinking_end') {
          emit({ type: 'thinking_end', messageId });
        }
        return;
      }
      case 'message_end': {
        const message = event.message;
        if (message.role !== 'assistant') return;
        // Usage arrives per assistant message; a turn is several of them, so
        // the turn's figure is the sum rather than the last one.
        this.turnUsage = addUsage(this.turnUsage, message.usage);
        if (this.turnUsage) emit({ type: 'usage', usage: this.turnUsage });
        return;
      }
      case 'tool_execution_start':
        emit({
          type: 'tool_call',
          callId: event.toolCallId,
          tool: event.toolName,
          input: asRecord(event.args),
        });
        return;
      case 'tool_execution_end':
        emit({
          type: 'tool_result',
          callId: event.toolCallId,
          content: resultText(event.result),
          isError: event.isError,
        });
        return;
      default:
        return;
    }
  }
}

/** Pi's thinking levels are a superset of `ReasoningEffort`, name for name. */
function thinkingLevelFor(effort: string): PiThinkingLevel {
  return effort as PiThinkingLevel;
}

function toTransportModel(model: PiModel): TransportModel {
  const levels = model.thinkingLevelMap
    ? Object.entries(model.thinkingLevelMap)
        .filter(([, value]) => value !== null)
        .map(([level]) => level)
    : model.reasoning
      ? ['off', 'low', 'medium', 'high']
      : ['off'];
  return {
    id: `${model.provider}/${model.id}`,
    displayName: model.name,
    provider: model.provider,
    supportedReasoningEfforts: levels,
    defaultReasoningEffort: levels.includes('medium') ? 'medium' : (levels[0] ?? 'off'),
    contextWindow: model.contextWindow,
  };
}

function addUsage(current: TurnUsage | null, usage: PiUsage | undefined): TurnUsage | null {
  if (!usage) return current;
  const base = current ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    cost: 0,
  };
  return {
    inputTokens: base.inputTokens + usage.input,
    outputTokens: base.outputTokens + usage.output,
    cacheCreationTokens: base.cacheCreationTokens + usage.cacheWrite,
    cacheReadTokens: base.cacheReadTokens + usage.cacheRead,
    thinkingTokens: base.thinkingTokens + (usage.reasoning ?? 0),
    cost: base.cost + usage.cost.total,
  };
}

function lastAssistant(session: PiAgentSession): {
  stopReason: string;
  errorMessage?: string;
} | null {
  const messages = session.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'assistant') {
      return {
        stopReason: message.stopReason,
        ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      };
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A tool answers with content blocks; the trace row wants one string. */
function resultText(result: unknown): string {
  const content = asRecord(result).content;
  if (!Array.isArray(content)) return typeof result === 'string' ? result : '';
  return content
    .map((block) => {
      const item = asRecord(block);
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}
