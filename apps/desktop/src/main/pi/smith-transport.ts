/**
 * `AgentTransport` for Smith's chat, over an in-process Pi session.
 *
 * A sibling of `pi-transport.ts` rather than a mode on it: a run's transport
 * carries the engine's tools, an envelope schema, and a trace; Smith carries
 * none of those, and the shared shape would be all conditionals. What the two
 * do share — model resolution, discovery-off session setup, event translation —
 * is shared through `model.ts`, `open-session.ts`, and `vendor-events.ts`,
 * so the flags cannot drift.
 *
 * Persistence: the session file lives in the caller-supplied `sessionDir`
 * (pinned under `<supportDir>/pi/`, never `~/.pi`) and is resumed by id on
 * the next start, which is what lets the chat survive an app relaunch — and
 * what makes a mid-conversation model switch a successor session over the
 * same history file.
 */

import {
  SessionManager,
  type AgentSession as PiAgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextBreakdown, ReasoningEffort } from '@shared/types.js';
import {
  clampEffortToModel,
  pickModel,
  requireModel,
  thinkingLevelFor,
  toTransportModel,
  type PiModel,
} from './model.js';
import { foundryResourceLoader, foundrySettings, openFoundrySession } from './open-session.js';
import { smithExtension } from './policy-extension.js';
import { modelRuntime } from './runtime.js';
import { BUILTIN_TOOLS } from './tools.js';
import { lastAssistantStop, VendorEventReader } from './vendor-events.js';
import { ModelNotChosen } from './transport.js';
import type {
  AgentTransport,
  ContextStats,
  PermissionAsk,
  PermissionDecision,
  RewindInfo,
  RewindOutcome,
  RewindParams,
  TransportEvent,
  TransportModel,
  TurnOptions,
  TurnResult,
} from './transport.js';

export interface SmithTransportOptions {
  /** The project checkout Smith works in. Resolved by the caller. */
  cwd: string;
  /** Foundry's Application Support directory; pi state lives under it. */
  supportDir: string;
  /** Where the chat's session files go — under `<supportDir>/pi/`. */
  sessionDir: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Standing identity, installed as the system prompt at create. */
  harness: string;
  /** Smith's own tools (entity, readiness), via the tool-definition seam. */
  customTools: readonly ToolDefinition[];
  onPermission: (ask: PermissionAsk) => PermissionDecision | Promise<PermissionDecision>;
  onEvent?: (event: TransportEvent) => void;
  onModelWarning?: (warning: string) => void;
}

export class SmithPiTransport implements AgentTransport {
  private session: PiAgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly extension: ReturnType<typeof smithExtension>;
  private models: TransportModel[] = [];
  private resolvedModel: PiModel | null = null;
  private effort: ReasoningEffort;
  private closed = false;
  private readonly events = new VendorEventReader();

  constructor(private readonly opts: SmithTransportOptions) {
    this.effort = opts.reasoningEffort;
    this.extension = smithExtension({
      tools: opts.customTools,
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
    const entries = session.sessionManager.getBranch();
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

  get activeReasoningEffort(): ReasoningEffort {
    return this.effort;
  }

  async start(existingSessionId?: string | null): Promise<void> {
    this.closed = false;
    const runtime = await modelRuntime(this.opts.supportDir);
    const available = await runtime.getAvailable();
    this.models = available.map(toTransportModel);

    // Smith refuses rather than substitutes. A run can fall back to another
    // model and say so in the trace, but a chat is a conversation the operator
    // is having with a model they named: answering as a different one, or as
    // whichever the runtime happened to reach first, is not a lesser version
    // of the request. Refusing keeps the picker's label honest.
    const required = requireModel(available, this.opts.model);
    if (!required.ok) throw new ModelNotChosen(required.reason, required.message);

    const picked = pickModel(available, this.opts.model);
    this.resolvedModel = picked.model;
    if (picked.warning) this.opts.onModelWarning?.(picked.warning);
    // The chat may hold an effort the newly resolved model does not offer —
    // a model switch, or a setting stored before a catalog change. Clamping
    // here is what keeps an unsupported level from reaching the provider.
    this.effort = clampEffortToModel(this.opts.reasoningEffort, picked.model);

    mkdirSync(this.opts.sessionDir, { recursive: true });
    const sessionManager = await this.openSessionManager(existingSessionId);
    const agentDir = join(this.opts.supportDir, 'pi');
    const settingsManager = foundrySettings();
    const resourceLoader = foundryResourceLoader({
      cwd: this.opts.cwd,
      agentDir,
      settingsManager,
      harness: this.opts.harness,
      extensionFactory: this.extension.factory,
    });
    const opened = await openFoundrySession({
      cwd: this.opts.cwd,
      agentDir,
      modelRuntime: runtime,
      model: picked.model,
      thinkingLevel: thinkingLevelFor(this.effort),
      // Full builtins plus Smith's own tools: the list is the allowlist, and
      // Smith is a full coding agent in the operator's checkout on purpose.
      tools: [...BUILTIN_TOOLS, ...this.opts.customTools.map((tool) => tool.name)],
      resourceLoader,
      settingsManager,
      sessionManager,
      onExtensionError: (message) => this.opts.onModelWarning?.(message),
    });
    if (opened.modelFallbackMessage) this.opts.onModelWarning?.(opened.modelFallbackMessage);

    const session = opened.session;
    this.session = session;
    this.unsubscribe = session.subscribe((event) =>
      this.events.absorb(event, (e) => this.opts.onEvent?.(e)),
    );
  }

  async send(text: string, opts: TurnOptions = {}): Promise<TurnResult> {
    const session = this.session;
    if (!session) throw new Error('smith session is not open');
    if (!this.alive) throw new Error('smith session is not alive');

    // The per-turn slot carries the screen context; between turns only.
    this.extension.useSystemPrompt(opts.systemPrompt ?? null);
    this.events.startTurn();

    // No turn deadline: Smith is interactive, the operator is present, and
    // cancel is the interrupt (deadlines were removed repo-wide with #171).
    await session.prompt(text, { expandPromptTemplates: false, source: 'extension' });
    await session.waitForIdle();

    const last = lastAssistantStop(session);
    if (last?.stopReason === 'error') {
      throw new Error(last.errorMessage || 'the model ended the turn with an error');
    }

    return {
      text: (session.getLastAssistantText() ?? '').trim(),
      usage: this.events.turnUsage,
      reason: last?.stopReason ?? 'stop',
      interrupted: last?.stopReason === 'aborted',
      structuredOutput: null,
    };
  }

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

  contextBreakdown(): Promise<ContextBreakdown | null> {
    const usage = this.session?.getContextUsage();
    if (!usage) return Promise.resolve(null);
    const model = this.session?.model ?? this.resolvedModel;
    const used = usage.tokens ?? 0;
    return Promise.resolve({
      modelId: this.activeModel,
      modelDisplayName: model?.name ?? this.activeModel,
      contextBudget: usage.contextWindow,
      usedTokens: used,
      freeTokens: Math.max(0, usage.contextWindow - used),
    });
  }

  async compact(): Promise<{ removedCount: number } | null> {
    const session = this.session;
    if (!session) return null;
    const before = session.messages.length;
    await session.compact();
    return { removedCount: Math.max(0, before - session.messages.length) };
  }

  /** A chat never rewinds; correcting Smith is just the next message. */
  getRewindInfo(messageId: string): Promise<RewindInfo | null> {
    void messageId;
    return Promise.resolve(null);
  }

  rewind(params: RewindParams): Promise<RewindOutcome | null> {
    void params;
    return Promise.resolve(null);
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
   * Resume the chat's own session file when there is one, otherwise start a
   * new session in the chat's directory. A missing file is a fresh chat, not
   * a failure — losing the transcript costs context, refusing to start costs
   * the conversation.
   */
  private async openSessionManager(existingSessionId?: string | null): Promise<SessionManager> {
    if (existingSessionId) {
      try {
        const listed = await SessionManager.list(this.opts.cwd, this.opts.sessionDir);
        const match = listed.find((entry) => entry.id === existingSessionId);
        if (match) return SessionManager.open(match.path, this.opts.sessionDir, this.opts.cwd);
      } catch {
        // Fall through to a fresh session.
      }
    }
    return SessionManager.create(this.opts.cwd, this.opts.sessionDir);
  }
}
