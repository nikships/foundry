/**
 * DaemonSession — ConnectedDroidSession behind the TransportSession surface.
 *
 * Daemon-specific semantics (spike V6 + architecture §9.2):
 * - Permission/askUser handlers attach PER SESSION at create/resume. The
 *   closure IS the binding; no registry. Connection-level handlers are a
 *   fail-closed safety net only.
 * - compact/rewind return {newSessionId}; the source handle stays usable
 *   (opposite of subprocess retire). We resume the successor, swap, detach
 *   the source attachment, and never stream it again.
 * - No per-session child pid: kill() = interrupt + close best-effort.
 * - contextBreakdown via sessions.getContextBreakdown; contextStats derived
 *   from it (daemon has no getContextStats on the high-level handle).
 * - autonomyLevel High is stated on every create and re-asserted after every
 *   resume/successor load — never rely on the default.
 */

import {
  AutonomyLevel,
  ReasoningEffort as SdkReasoningEffort,
  ToolConfirmationOutcome,
  type AskUserRequestParams,
  type AskUserResult,
  type DroidResultMessage,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import type { ContextBreakdown, ReasoningEffort, UserMcpServer } from '@shared/types.js';
import {
  AUTONOMY_LEVEL,
  type AvailableModel,
  type ContextStatsResult,
  type DroidNotification,
  type SessionSettings,
  type TokenUsage,
} from '../protocol.js';
import { INHERIT_MODEL, type TurnOptions, type TurnResult } from '../turn.js';
import { DroidProtocolError } from './errors.js';
import { createFoundryMcpServer, FOUNDRY_TOOL_IDS, type FoundryMcpContext } from './mcp-tools.js';
import {
  toAskUserAsk,
  toAskUserResult,
  toPermissionAsk,
  toPermissionHandlerResult,
} from './policy-adapters.js';
import type { SessionTool, TransportSession, TransportSessionOptions } from './transport.js';
import { TurnCollector } from './turn-collector.js';

/**
 * The one level Foundry runs at. Reuses the same AutonomyLevel enum the SDK
 * wants (not the string literal) — session.ts's pattern, shared here so
 * daemon create/resume cannot drift.
 */
export const DAEMON_AUTONOMY = AutonomyLevel.High satisfies typeof AutonomyLevel.High;

/** Stream messages we care about from a daemon handle (result is enough for turns). */
export type DaemonStreamMessage = DroidResultMessage | { readonly type: string };

export interface DaemonHandle {
  readonly id: string;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly cwd: string | undefined;
  stream(
    prompt: string,
    options?: { abortSignal?: AbortSignal; outputFormat?: TurnOptions['outputFormat'] },
  ): AsyncIterable<DaemonStreamMessage>;
  interrupt(): Promise<void>;
  compact(customInstructions?: string): Promise<{ newSessionId: string; removedCount: number }>;
  rewind(params: {
    messageId: string;
    filesToRestore: { filePath: string; contentHash: string; size: number }[];
    filesToDelete: { filePath: string }[];
    forkTitle: string;
  }): Promise<{
    newSessionId: string;
    restoredCount: number;
    deletedCount: number;
    failedRestoreCount: number;
    failedDeleteCount: number;
  }>;
  detach(): Promise<void>;
  close(): Promise<void>;
  /**
   * Subscribe to raw session notifications (inner payload shape). The real
   * ConnectedDroidSession does not expose this; the production adapter taps
   * the controller. Scripted seams implement it directly.
   */
  subscribeNotifications(handler: (n: DroidNotification) => void): () => void;
}

/**
 * Wire MCP config the daemon create/resume schema accepts. In-process
 * SdkMcpServer objects are rejected by the public daemon schema — start them
 * first and pass the resulting HTTP config (type/url/headers).
 */
export type DaemonMcpServerConfig =
  | { type: 'stdio'; name: string; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'http';
      name: string;
      url: string;
      oauth?: false;
      headers?: { name: string; value: string }[];
    }
  | {
      type: 'sse';
      name: string;
      url: string;
      oauth?: false;
      headers?: { name: string; value: string }[];
    };

export interface DaemonSessionsFacade {
  create(options: {
    cwd: string;
    autonomyLevel: typeof DAEMON_AUTONOMY;
    machineId: string;
    permissionHandler: (
      params: RequestPermissionRequestParams,
    ) => Promise<RequestPermissionHandlerResult> | RequestPermissionHandlerResult;
    askUserHandler: (params: AskUserRequestParams) => Promise<AskUserResult> | AskUserResult;
    mcpServers?: DaemonMcpServerConfig[];
  }): Promise<DaemonHandle>;
  resume(
    sessionId: string,
    options?: {
      permissionHandler?: (
        params: RequestPermissionRequestParams,
      ) => Promise<RequestPermissionHandlerResult> | RequestPermissionHandlerResult;
      askUserHandler?: (params: AskUserRequestParams) => Promise<AskUserResult> | AskUserResult;
      mcpServers?: DaemonMcpServerConfig[];
    },
  ): Promise<DaemonHandle>;
  updateSettings(
    sessionId: string,
    params: {
      autonomyLevel?: typeof DAEMON_AUTONOMY;
      modelId?: string;
      reasoningEffort?: SdkReasoningEffort;
      disabledToolIds?: string[];
    },
  ): Promise<unknown>;
  getContextBreakdown(sessionId: string): Promise<ContextBreakdown>;
  getRewindInfo(
    sessionId: string,
    messageId: string,
  ): Promise<{
    availableFiles: { filePath: string; contentHash: string; size: number }[];
    createdFiles: { filePath: string }[];
    evictedFiles: { filePath: string; reason: string }[];
  }>;
  listTools?(sessionId: string): Promise<SessionTool[]>;
}

export interface DaemonSessionOptions extends TransportSessionOptions {
  /** Multiplexed daemon connection's sessions resource (or a scripted seam). */
  sessions: DaemonSessionsFacade;
  /** Models known at create/resume time when the facade can supply them. */
  availableModels?: AvailableModel[];
  foundryMcp?: FoundryMcpContext;
  toolRefreshDelayMs?: number;
}

const EFFORTS: Record<ReasoningEffort, SdkReasoningEffort> = {
  off: SdkReasoningEffort.Off,
  low: SdkReasoningEffort.Low,
  medium: SdkReasoningEffort.Medium,
  high: SdkReasoningEffort.High,
};

const MCP_TOOL_SETTLE_MS = 1_500;

/**
 * Connection-level safety net: any ask that reaches it (no per-session
 * handler, or missing/mismatched associatedSessionIds upstream) is denied.
 * Wired by DaemonManager on connectToDaemon.
 */
export function failClosedPermissionHandler(
  params: RequestPermissionRequestParams,
): RequestPermissionHandlerResult {
  const ids = params.associatedSessionIds;
  const reason =
    !ids || ids.length === 0
      ? 'connection safety-net: missing associatedSessionIds'
      : 'connection safety-net: no session handler';
  return {
    selectedOption: ToolConfirmationOutcome.Cancel,
    comment: reason,
  };
}

export function failClosedAskUserHandler(_params: AskUserRequestParams): AskUserResult {
  void _params;
  return { cancelled: true, answers: [] };
}

export class DaemonSession implements TransportSession {
  private handle: DaemonHandle | null = null;
  private unsubNotifications: (() => void) | null = null;
  private collector: TurnCollector | null = null;
  private closed = false;
  private settings: SessionSettings = {};
  private models: AvailableModel[] = [];
  private droidDefaultModel: string | null = null;
  private modelRefused = false;
  private appliedDisabledTools: string[] | null = null;
  private toolRefresh: NodeJS.Timeout | null = null;
  private toolRefreshDelay = 0;
  private foundryServer: ReturnType<typeof createFoundryMcpServer> | null = null;
  private userMessageId: string | null = null;

  constructor(private readonly opts: DaemonSessionOptions) {
    this.models = opts.availableModels ?? [];
  }

  get id(): string | null {
    return this.handle?.id ?? null;
  }

  get alive(): boolean {
    return !!this.handle && !this.closed;
  }

  get lastUserMessageId(): string | null {
    return this.userMessageId;
  }

  /** Daemon sessions have no per-session child; the daemon process is recorded once. */
  get pid(): number | undefined {
    return undefined;
  }

  get availableModels(): AvailableModel[] {
    return this.models;
  }

  get activeModel(): string {
    return this.settings.modelId ?? (this.wantsModel() ? this.opts.model : 'droid default');
  }

  /** No per-session argv; the daemon child is recorded by DaemonManager. */
  spawnArgs(): string[] {
    return [];
  }

  async start(existingSessionId?: string | null): Promise<void> {
    this.closed = false;
    this.toolRefreshDelay = this.opts.toolRefreshDelayMs ?? MCP_TOOL_SETTLE_MS;

    // Daemon create/resume validates mcpServers against the wire schema only
    // (stdio/http/sse). SdkMcpServer is an in-process object the subprocess
    // path starts for us; here we start it and pass the HTTP config so the
    // daemon worker can reach the app-local loopback server.
    let mcpServers: DaemonMcpServerConfig[] | undefined;
    const userServers: DaemonMcpServerConfig[] = (this.opts.userMcpServers ?? [])
      .filter((s) => !s.disabled)
      .map(mapUserMcpToDaemon);
    if (this.opts.foundryMcp) {
      const server = createFoundryMcpServer(this.opts.foundryMcp);
      this.foundryServer = server;
      try {
        const config = await server.start();
        mcpServers = [
          {
            type: 'http',
            name: config.name,
            url: config.url,
            oauth: false,
            headers: config.headers?.map((h) => ({ name: h.name, value: h.value })),
          },
          ...userServers,
        ];
      } catch (e) {
        await this.closeFoundryServer();
        throw e;
      }
    } else if (userServers.length) {
      mcpServers = [...userServers];
    }

    const handlers = {
      permissionHandler: (params: RequestPermissionRequestParams) => this.onPermission(params),
      askUserHandler: (params: AskUserRequestParams) => this.onAskUser(params),
    };

    // machineId: 'default' is required on daemon create (spike V6). The SDK
    // 0.7.0 forces LOCAL_MACHINE_ID='local' internally when using the real
    // client; scripted seams and future SDK versions still see our value.
    try {
      this.handle = existingSessionId
        ? await this.opts.sessions.resume(existingSessionId, {
            ...handlers,
            ...(mcpServers ? { mcpServers } : {}),
          })
        : await this.opts.sessions.create({
            cwd: this.opts.cwd,
            autonomyLevel: DAEMON_AUTONOMY,
            machineId: 'default',
            ...handlers,
            ...(mcpServers ? { mcpServers } : {}),
          });
    } catch (e) {
      await this.closeFoundryServer();
      throw e;
    }

    this.bindNotifications(this.handle);
    this.settings = { ...(this.handle.settings as SessionSettings) };
    this.droidDefaultModel = this.settings.modelId ?? this.droidDefaultModel;

    if (existingSessionId) await this.verifyResumedCwd(existingSessionId);

    const applied = await this.applySettings();
    if (applied.warning) this.opts.onModelWarning?.(applied.warning);
    await this.applyToolPolicy();
  }

  async applySettings(): Promise<{ model: string; warning?: string }> {
    const handle = this.handle;
    if (!handle) return { model: this.activeModel };

    const wantsModel = this.wantsModel() && !this.modelRefused;
    await this.updateSettings({
      autonomyLevel: DAEMON_AUTONOMY,
      ...(wantsModel ? { modelId: this.opts.model } : {}),
      ...(wantsModel ? this.effortFor(this.opts.model, this.models) : {}),
    });

    if (wantsModel && this.models.length && !this.models.some((m) => m.id === this.opts.model)) {
      return {
        model: this.opts.model,
        warning: `${this.opts.model} is not in this session's available models; turns may come back empty`,
      };
    }
    return { model: this.activeModel };
  }

  async listTools(): Promise<SessionTool[]> {
    if (!this.handle) return [];
    if (!this.opts.sessions.listTools) return [];
    return this.opts.sessions.listTools(this.handle.id);
  }

  async send(text: string, timeoutMs: number, opts: TurnOptions = {}): Promise<TurnResult> {
    try {
      return await this.runTurn(text, timeoutMs, opts);
    } catch (error) {
      if (!this.canSubstituteModel(error)) throw error;
      this.opts.onModelWarning?.(await this.dropModelOverride(errorText(error)));
      return this.runTurn(text, timeoutMs, opts);
    }
  }

  private async runTurn(text: string, timeoutMs: number, opts: TurnOptions): Promise<TurnResult> {
    const handle = this.handle;
    if (!handle) throw new DroidProtocolError('session not initialised');
    if (!this.alive) throw new DroidProtocolError('daemon session is not alive');

    const collector = new TurnCollector();
    this.collector = collector;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    let result: DroidResultMessage | null = null;
    try {
      const stream = handle.stream(text, {
        abortSignal: controller.signal,
        ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
      });
      for await (const message of stream) {
        if (isResultMessage(message)) result = message;
      }
    } catch (error) {
      if (timedOut) throw new DroidProtocolError(`turn timed out after ${timeoutMs}ms`);
      throw asProtocolError(error);
    } finally {
      clearTimeout(timer);
      this.collector = null;
    }

    if (!result) throw new DroidProtocolError('droid ended the turn without a result');
    if (!result.success && !result.interrupted && result.subtype !== 'error_structured_output') {
      throw new DroidProtocolError(result.error?.message ?? `turn failed: ${result.subtype}`);
    }

    return {
      text: (result.text || collector.text).trim(),
      usage: (result.tokenUsage as TokenUsage | null) ?? collector.usage,
      reason: collector.reason ?? (result.interrupted ? 'cancelled' : 'completed'),
      interrupted: result.interrupted,
      structuredOutput: asJsonObject(result.structuredOutput),
    };
  }

  async interrupt(): Promise<void> {
    if (!this.handle || !this.alive) return;
    try {
      await this.handle.interrupt();
    } catch {
      // Best-effort; kill is the guarantee.
    }
  }

  async contextStats(): Promise<ContextStatsResult | null> {
    const breakdown = await this.contextBreakdown();
    if (!breakdown) return null;
    return {
      used: breakdown.usedTokens,
      remaining: breakdown.freeTokens,
      limit: breakdown.contextBudget,
      accuracy: 'breakdown',
    };
  }

  async contextBreakdown(): Promise<ContextBreakdown | null> {
    if (!this.handle) return null;
    try {
      return await this.opts.sessions.getContextBreakdown(this.handle.id);
    } catch {
      return null;
    }
  }

  /**
   * Daemon compact returns {newSessionId}; resume the successor, swap, detach
   * the source attachment so we never stream it again.
   */
  async compact(): Promise<{ removedCount: number } | null> {
    const handle = this.handle;
    if (!handle) return null;
    const outcome = await handle.compact();
    await this.adoptSuccessor(outcome.newSessionId);
    return { removedCount: outcome.removedCount };
  }

  async getRewindInfo(messageId: string): Promise<{
    availableFiles: { filePath: string; contentHash: string; size: number }[];
    createdFiles: { filePath: string }[];
    evictedFiles: { filePath: string; reason: string }[];
  } | null> {
    if (!this.handle) return null;
    return this.opts.sessions.getRewindInfo(this.handle.id, messageId);
  }

  async rewind(params: {
    messageId: string;
    filesToRestore: { filePath: string; contentHash: string; size: number }[];
    filesToDelete: { filePath: string }[];
    forkTitle: string;
  }): Promise<{
    restoredCount: number;
    deletedCount: number;
    failedRestoreCount: number;
    failedDeleteCount: number;
  } | null> {
    const handle = this.handle;
    if (!handle) return null;
    const outcome = await handle.rewind(params);
    await this.adoptSuccessor(outcome.newSessionId);
    this.userMessageId = params.messageId;
    return {
      restoredCount: outcome.restoredCount,
      deletedCount: outcome.deletedCount,
      failedRestoreCount: outcome.failedRestoreCount,
      failedDeleteCount: outcome.failedDeleteCount,
    };
  }

  /**
   * Resume the successor on the same connection, re-bind handlers +
   * notifications, detach the source handle, re-assert settings.
   */
  private async adoptSuccessor(newSessionId: string): Promise<void> {
    const previous = this.handle;
    const handlers = {
      permissionHandler: (params: RequestPermissionRequestParams) => this.onPermission(params),
      askUserHandler: (params: AskUserRequestParams) => this.onAskUser(params),
    };
    const successor = await this.opts.sessions.resume(newSessionId, handlers);
    this.handle = successor;
    this.bindNotifications(successor);
    this.settings = { ...this.settings, ...(successor.settings as SessionSettings) };

    // Detach the source attachment so this connection never streams it again.
    // The daemon keeps the old session on disk; we just drop our handle.
    if (previous && previous.id !== successor.id) {
      try {
        await previous.detach();
      } catch {
        // Source may already be gone; the swap is what matters.
      }
    }

    const applied = await this.applySettings();
    if (applied.warning) this.opts.onModelWarning?.(applied.warning);
  }

  async close(): Promise<void> {
    if (this.toolRefresh) clearTimeout(this.toolRefresh);
    this.toolRefresh = null;
    this.unsubNotifications?.();
    this.unsubNotifications = null;
    const handle = this.handle;
    this.handle = null;
    this.closed = true;
    if (handle) {
      try {
        // detach keeps the daemon-side session alive for later resume.
        await handle.detach();
      } catch {
        try {
          await handle.close();
        } catch {
          // Already gone.
        }
      }
    }
    await this.closeFoundryServer();
  }

  /**
   * No per-session child to SIGKILL. Best-effort interrupt + close; the daemon
   * process itself is owned by DaemonManager.
   */
  kill(): void {
    const handle = this.handle;
    this.closed = true;
    this.unsubNotifications?.();
    this.unsubNotifications = null;
    // Kill latches; best-effort interrupt+close with detach fallback.
    // Every catch traces to no diagnostic: the operator already ended the run.
    this.handle = null;
    if (handle) {
      void handle
        .interrupt()
        .catch(() => undefined)
        .then(() => handle.close())
        .catch(() => handle.detach().catch(() => undefined));
    }
    void this.closeFoundryServer();
  }

  private bindNotifications(handle: DaemonHandle): void {
    this.unsubNotifications?.();
    this.unsubNotifications = handle.subscribeNotifications((n) => this.deliver(n));
  }

  private async closeFoundryServer(): Promise<void> {
    const server = this.foundryServer;
    this.foundryServer = null;
    if (!server) return;
    try {
      await server.close();
    } catch {
      // Already closed.
    }
  }

  private async verifyResumedCwd(sessionId: string): Promise<void> {
    const sessionCwd = this.handle?.cwd;
    if (!sessionCwd || pathsMatch(sessionCwd, this.opts.cwd)) return;
    await this.close();
    throw new DroidProtocolError(
      `session ${sessionId} runs in ${sessionCwd}, not this run's worktree ${this.opts.cwd}`,
    );
  }

  private wantsModel(): boolean {
    return !!this.opts.model && this.opts.model !== INHERIT_MODEL;
  }

  private effortFor(
    modelId: string,
    models: AvailableModel[],
  ): { reasoningEffort?: SdkReasoningEffort } {
    const effort = this.opts.reasoningEffort;
    const model = models.find((m) => m.id === modelId);
    const supported = model
      ? (model.supportedReasoningEfforts?.includes(effort) ?? false)
      : effort !== 'off';
    return supported ? { reasoningEffort: EFFORTS[effort] } : {};
  }

  private async updateSettings(
    params: Parameters<DaemonSessionsFacade['updateSettings']>[1],
  ): Promise<void> {
    if (!this.handle) return;
    await this.opts.sessions.updateSettings(this.handle.id, params);
    this.settings = { ...this.settings, ...(this.handle.settings as SessionSettings), ...params };
  }

  private canSubstituteModel(error: unknown): boolean {
    if (this.modelRefused || !this.wantsModel() || !this.alive) return false;
    return /invalid model id/i.test(errorText(error));
  }

  private async dropModelOverride(reason: string): Promise<string> {
    this.modelRefused = true;
    await this.updateSettings({
      autonomyLevel: DAEMON_AUTONOMY,
      ...(this.droidDefaultModel ? { modelId: this.droidDefaultModel } : {}),
    });
    const fallback = this.droidDefaultModel ?? 'droid default';
    return `${this.opts.model} was refused (${reason}); this session runs on ${fallback}`;
  }

  private async applyToolPolicy(): Promise<void> {
    const handle = this.handle;
    if (!handle) return;
    const allow = this.opts.restrictTools;
    const explicit = this.opts.disabledTools ?? [];
    if (!allow?.length && !explicit.length) return;

    const allowed = new Set([...(allow ?? []), ...FOUNDRY_TOOL_IDS]);
    const listed = this.opts.sessions.listTools
      ? await this.opts.sessions.listTools(handle.id)
      : [];
    // Without a tool list the complement cannot be computed; only apply
    // explicit disables rather than accidentally disabling nothing under a
    // restricted roster.
    const complement =
      allow?.length && listed.length > 0
        ? listed.map((t) => t.id).filter((id) => !allowed.has(id))
        : [];
    const disabled = [...new Set([...complement, ...explicit])].sort();

    if (this.appliedDisabledTools?.join('\u0000') === disabled.join('\u0000')) return;
    this.appliedDisabledTools = disabled;
    if (disabled.length === 0) return;
    await this.updateSettings({ disabledToolIds: disabled });
  }

  private scheduleToolPolicy(): void {
    if (!this.opts.restrictTools?.length || this.toolRefresh) return;
    const timer = setTimeout(() => {
      this.toolRefresh = null;
      // Background reconciliation: same justification as SdkSession — swallow to
      // avoid unhandled rejection; correctness checked via listTools re-read.
      void this.applyToolPolicy().catch(() => undefined);
    }, this.toolRefreshDelay);
    timer.unref?.();
    this.toolRefresh = timer;
  }

  private async onPermission(
    params: RequestPermissionRequestParams,
  ): Promise<RequestPermissionHandlerResult> {
    const decision = await this.opts.onPermission(toPermissionAsk(params));
    return toPermissionHandlerResult(decision, params);
  }

  private async onAskUser(params: AskUserRequestParams): Promise<AskUserResult> {
    const decision = await this.opts.onPermission(toAskUserAsk(params));
    return toAskUserResult(decision);
  }

  private deliver(notification: DroidNotification): void {
    this.noteUserMessage(notification);
    this.collector?.absorb(notification);
    if (notification.type === 'settings_updated' || notification.type === 'mcp_status_changed') {
      this.scheduleToolPolicy();
    }
    this.opts.onNotification?.(notification);
  }

  private noteUserMessage(notification: DroidNotification): void {
    if (notification.type !== 'create_message') return;
    const message = (notification as { message?: { id?: string; role?: string } }).message;
    if (message?.role !== 'user' || typeof message.id !== 'string' || !message.id) return;
    this.userMessageId = message.id;
  }
}

function isResultMessage(message: DaemonStreamMessage): message is DroidResultMessage {
  return message.type === 'result';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asProtocolError(error: unknown): Error {
  if (error instanceof DroidProtocolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DroidProtocolError(message);
}

function pathsMatch(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/$/, '');
  return norm(a) === norm(b) || norm(a).endsWith(norm(b)) || norm(b).endsWith(norm(a));
}

function mapUserMcpToDaemon(s: UserMcpServer): DaemonMcpServerConfig {
  if (s.type === 'stdio') {
    return { type: 'stdio', name: s.name, command: s.command, args: s.args, env: s.env };
  }
  if (s.type === 'sse') {
    return { type: 'sse', name: s.name, url: s.url, oauth: false };
  }
  return { type: 'http', name: s.name, url: s.url, oauth: false };
}

// Keep the protocol constant and the enum aligned so a drift fails to compile.
void (AUTONOMY_LEVEL satisfies `${typeof DAEMON_AUTONOMY}`);
