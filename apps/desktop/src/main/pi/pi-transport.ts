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

import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextBreakdown, ReasoningEffort } from '@shared/types.js';
import { modelKey, pickModel, thinkingLevelFor, toTransportModel, type PiModel } from './model.js';
import { continueWithModelFailover } from './model-failover.js';
import {
  closeLiveSession,
  compactSession,
  foundryResourceLoader,
  foundrySettings,
  lastAssistantText,
  lastUserMessageId,
  openFoundrySession,
  openOrCreateSessionManager,
  promptUntilIdle,
  sessionContextBreakdown,
  sessionContextStats,
} from './open-session.js';
import { foundryExtension } from './policy-extension.js';
import { modelRuntime } from './runtime.js';
import { FOUNDRY_RUN_HARNESS } from './system-prompt.js';
import { runToolsFor } from './tool-names.js';
import { submitEnvelopeTool, type SubmissionTool } from './tools.js';
import { subscribeSessionEvents, VendorEventReader } from './vendor-events.js';
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
  /**
   * Models the operator hid in Settings. Failover skips them. Read live at
   * send time so a hide mid-run takes effect on the next exhausted retry.
   */
  hiddenModelIds?: () => readonly string[];
}

export class PiTransport implements AgentTransport {
  private session: PiAgentSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly extension: ReturnType<typeof foundryExtension>;
  private envelopeTool: SubmissionTool | null = null;
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
    return lastUserMessageId(this.session);
  }

  get availableModels(): TransportModel[] {
    return this.models;
  }

  get activeModel(): string {
    const model = this.session?.model ?? this.resolvedModel;
    return model ? modelKey(model) : this.opts.model;
  }

  /**
   * The roster's level, verbatim. A run agent's effort is not clamped here:
   * the roster is the operator's stated intent, pi maps an unsupported level
   * down itself, and a mid-turn model failover would make any clamp computed
   * at open stale anyway.
   */
  get activeReasoningEffort(): ReasoningEffort {
    return this.opts.reasoningEffort;
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
    const sessionManager = await openOrCreateSessionManager(
      this.opts.cwd,
      this.opts.sessionDir,
      existingSessionId,
    );
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
      // Foundry's own tools have to be named alongside the built-ins, and a
      // read-only agent simply has no editing or shell tool to call.
      tools: runToolsFor(this.opts.toolProfile),
      resourceLoader,
      settingsManager,
      sessionManager,
      onExtensionError: (message) => this.opts.onModelWarning?.(message),
    });
    if (opened.modelFallbackMessage) this.opts.onModelWarning?.(opened.modelFallbackMessage);

    this.session = opened.session;
    this.unsubscribe = subscribeSessionEvents(opened.session, this.events, this.opts.onEvent);
  }

  async send(text: string, opts: TurnOptions = {}): Promise<TurnResult> {
    const session = this.session;
    if (!session) throw new Error('pi session is not open');
    if (!this.alive) throw new Error('pi session is not alive');

    // Between turns is the only safe moment to change the envelope tool: the
    // model is looking at whatever schema was live when the turn started.
    this.useEnvelopeSchema(opts.outputFormat?.schema ?? null);
    this.extension.useSystemPrompt(opts.systemPrompt ?? null);
    this.events.startTurn();

    const last = await promptUntilIdle(session, text, () =>
      continueWithModelFailover({
        session,
        events: this.events,
        availableModelCount: this.models.length,
        hiddenModelIds: this.opts.hiddenModelIds?.() ?? [],
        onWarning: (warning) => this.opts.onModelWarning?.(warning),
      }),
    );

    return {
      text: lastAssistantText(session),
      usage: this.events.turnUsage,
      reason: last?.stopReason ?? 'stop',
      interrupted: last?.stopReason === 'aborted',
      structuredOutput: this.envelopeTool?.submitted() ?? null,
    };
  }

  /**
   * Failover deliberately changes the session's model. Do not reset it to the
   * roster default between phases; report what the session is actually using.
   */
  applySettings(): Promise<{ model: string; warning?: string }> {
    return Promise.resolve({ model: this.activeModel });
  }

  contextStats(): Promise<ContextStats | null> {
    return Promise.resolve(sessionContextStats(this.session));
  }

  contextBreakdown(): Promise<ContextBreakdown | null> {
    return Promise.resolve(
      sessionContextBreakdown(this.session, this.resolvedModel, this.activeModel),
    );
  }

  /**
   * Compacts the live session in place. Pi summarizes and keeps the same
   * session, so unlike the daemon there is no successor to adopt and no id to
   * re-persist.
   */
  compact(): Promise<{ removedCount: number } | null> {
    return compactSession(this.session);
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
    await closeLiveSession(session);
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
}
