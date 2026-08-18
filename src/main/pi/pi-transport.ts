/**
 * `AgentTransport` over an in-process Pi agent session.
 *
 * The agent runs inside this process: no wire protocol, no second permission
 * model, no MCP server to stand up for two tools. Everything below is the
 * translation between what `AgentSession` asks for and what Pi offers, kept in
 * one file so nothing above it names a vendor.
 *
 * Compaction happens in place. Pi compacts the same session rather than
 * handing back a successor, so there is nothing to swap or re-persist.
 * Rewind is a leaf move in the session tree, not a file restore. Pi keeps no
 * file snapshots, so the worktree half is `boundary.restoreToPhaseStart`'s job.
 */

import {
  SessionManager,
  type AgentSession as PiAgentSession,
} from '@earendil-works/pi-coding-agent';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextBreakdown } from '@shared/types.js';
import { pickModel, thinkingLevelFor, toTransportModel, type PiModel } from './model.js';
import { foundryResourceLoader, foundrySettings, openFoundrySession } from './open-session.js';
import { foundryExtension } from './policy-extension.js';
import { modelRuntime } from './runtime.js';
import { FOUNDRY_RUN_HARNESS } from './system-prompt.js';
import { BUILTIN_TOOLS, submitEnvelopeTool, type EnvelopeTool } from './tools.js';
import { lastAssistantStop, VendorEventReader } from './vendor-events.js';
import type {
  AgentTransport,
  AgentTransportOptions,
  ContextStats,
  FoundryToolContext,
  RewindInfo,
  RewindOutcome,
  RewindParams,
  TransportModel,
  TurnOptions,
  TurnResult,
} from './transport.js';

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
  private readonly events = new VendorEventReader();

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
    // The live branch, not the append-only file: after a rewind the abandoned
    // leaf is still in getEntries() and must not become the next anchor.
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

  async start(existingSessionId?: string | null): Promise<void> {
    this.closed = false;
    const runtime = await modelRuntime(this.opts.supportDir);
    const available = await runtime.getAvailable();
    this.models = available.map(toTransportModel);

    const picked = pickModel(available, this.opts.model);
    this.resolvedModel = picked.model;
    if (picked.warning) this.opts.onModelWarning?.(picked.warning);

    mkdirSync(this.opts.sessionDir, { recursive: true });
    const sessionManager = await this.openSessionManager(existingSessionId);
    const agentDir = join(this.opts.supportDir, 'pi');
    const settingsManager = foundrySettings();
    const resourceLoader = foundryResourceLoader({
      cwd: this.opts.cwd,
      agentDir,
      settingsManager,
      harness: FOUNDRY_RUN_HARNESS,
      extensionFactory: this.extension.factory,
    });
    const opened = await openFoundrySession({
      cwd: this.opts.cwd,
      agentDir,
      modelRuntime: runtime,
      model: picked.model,
      thinkingLevel: thinkingLevelFor(this.opts.reasoningEffort),
      // Also the allowlist: a tool absent here is absent from the registry, so
      // Foundry's own tools have to be named alongside the built-ins.
      tools: [...BUILTIN_TOOLS, 'report_progress', 'read_phase_context', 'submit_envelope'],
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

  async send(text: string, timeoutMs: number, opts: TurnOptions = {}): Promise<TurnResult> {
    const session = this.session;
    if (!session) throw new Error('pi session is not open');
    if (!this.alive) throw new Error('pi session is not alive');

    // Between turns is the only safe moment to change the envelope tool: the
    // model is looking at whatever schema was live when the turn started.
    this.useEnvelopeSchema(opts.outputFormat?.schema ?? null);
    this.extension.useSystemPrompt(opts.systemPrompt ?? null);
    this.events.startTurn();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, timeoutMs);
    try {
      await session.prompt(text, { expandPromptTemplates: false, source: 'extension' });
      // prompt() already waits through retries and queued continuations.
      // waitForIdle() is the documented settle API and is a no-op when idle.
      await session.waitForIdle();
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) throw new Error(`turn timed out after ${timeoutMs}ms`);

    const last = lastAssistantStop(session);
    const interrupted = last?.stopReason === 'aborted';
    if (last?.stopReason === 'error') {
      throw new Error(last.errorMessage || 'the model ended the turn with an error');
    }

    return {
      text: (session.getLastAssistantText() ?? '').trim(),
      usage: this.events.turnUsage,
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
   * Pi accounts for context as one estimate for the whole conversation rather
   * than by source, so the breakdown is the model and its occupancy and
   * nothing else. Inventing a composition to fill the panel would be a
   * fabricated one; four honest numbers are the answer pi can give.
   */
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
  private async openSessionManager(existingSessionId?: string | null): Promise<SessionManager> {
    if (existingSessionId) {
      try {
        const listed = await SessionManager.list(this.opts.cwd, this.opts.sessionDir);
        const match = listed.find((entry) => entry.id === existingSessionId);
        if (match) return SessionManager.open(match.path, this.opts.sessionDir, this.opts.cwd);
      } catch {
        // A missing or unreadable session dir is a fresh start, not a failed run.
      }
    }
    return SessionManager.create(this.opts.cwd, this.opts.sessionDir);
  }
}
