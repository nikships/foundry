/**
 * One `droid exec` session per agent per run, driven through the Factory SDK
 * instead of a hand-rolled JSON-RPC client.
 *
 * The SDK's `createSession()` hides the child process and requires an API key
 * it would inject itself, so the transport is constructed here: Foundry needs
 * the pid for the trace, stderr for the doctor, and the exit code to fail a
 * turn instead of hanging on a notification that will never arrive.
 */

import { realpathSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import {
  ProcessExitError,
  ProcessTransport,
  ReasoningEffort as SdkReasoningEffort,
  createSession,
  resumeSession,
  type AskUserRequestParams,
  type AskUserResult,
  type CreateSessionOptions,
  type DroidResultMessage,
  type DroidSession,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
  type StringFramedDroidClientTransport,
} from '@factory/droid-sdk/node';
import type { ContextBreakdown, ReasoningEffort, UserMcpServer } from '@shared/types.js';
import type { McpServerConfig } from '@factory/droid-sdk/node';
import { INHERIT_MODEL, type TurnOptions, type TurnResult } from '../turn.js';
import { DroidProtocolError } from './errors.js';
import {
  AUTONOMY_LEVEL,
  type AvailableModel,
  type ContextStatsResult,
  type DroidNotification,
  type SessionSettings,
  type TokenUsage,
} from '../protocol.js';
import { spawnEnv } from '../../system/env.js';
import { register as registerProc } from '../../system/procs.js';
import { createFoundryMcpServer, FOUNDRY_TOOL_IDS, type FoundryMcpContext } from './mcp-tools.js';
import {
  toAskUserAsk,
  toAskUserResult,
  toPermissionAsk,
  toPermissionHandlerResult,
} from './policy-adapters.js';
import { SniffingTransport } from './sniffing-transport.js';
import type { SessionTool, TransportSession, TransportSessionOptions } from './transport.js';
import { TurnCollector } from './turn-collector.js';

export type { SessionTool } from './transport.js';

export interface SdkSessionOptions extends TransportSessionOptions {
  droidPath: string;
  /** Test seam: an in-memory transport replaces the child process entirely. */
  transport?: StringFramedDroidClientTransport;
  /** Test seam for the CLI's lag between announcing MCP tools and listing them. */
  toolRefreshDelayMs?: number;
  /**
   * When set, the in-process foundry MCP server is attached at session create
   * (and resume) via init-time `mcpServers` — never via `addMcpServer()`, which
   * permanently writes the user's global `~/.factory/mcp.json`.
   */
  foundryMcp?: FoundryMcpContext;
}

/** However the SDK spells autonomy; Foundry never names its levels. */
type WireAutonomy = NonNullable<CreateSessionOptions['autonomyLevel']>;

/**
 * The one level Foundry runs at, pinned to the protocol constant so the argv
 * flag and the session setting cannot drift apart. The SDK types the field as
 * a nominal string enum, so the value is checked against that enum's own
 * strings — a constant the SDK would not accept fails to compile — and only
 * then given the nominal type.
 */
const AUTONOMY = AUTONOMY_LEVEL satisfies `${WireAutonomy}` as WireAutonomy;

/** Foundry's reasoning efforts named the way the wire wants them. */
const EFFORTS: Record<ReasoningEffort, SdkReasoningEffort> = {
  off: SdkReasoningEffort.Off,
  low: SdkReasoningEffort.Low,
  medium: SdkReasoningEffort.Medium,
  high: SdkReasoningEffort.High,
  xhigh: SdkReasoningEffort.ExtraHigh,
  max: SdkReasoningEffort.Max,
};

/**
 * How long an MCP tool takes to reach `list_tools` after the CLI announces the
 * server. Recomputing the allowlist synchronously on `mcp_status_changed` reads
 * a list the new tool is not in yet, and the tool stays allowed.
 */
const MCP_TOOL_SETTLE_MS = 1_500;

export class SdkSession implements TransportSession {
  private session: DroidSession | null = null;
  private sniffer: SniffingTransport | null = null;
  private owned: ProcessTransport | null = null;
  private child: ChildProcess | null = null;
  private collector: TurnCollector | null = null;
  private exited = false;
  private exitReported = false;
  private settings: SessionSettings = {};
  /** The model droid picked for itself, before the roster overrode it. */
  private droidDefaultModel: string | null = null;
  /** Set once the roster's model has been refused and given up on. */
  private modelRefused = false;
  private appliedDisabledTools: string[] | null = null;
  private toolRefresh: NodeJS.Timeout | null = null;
  private toolRefreshDelay = 0;
  /** Kept so a kill that skips session.close still tears the HTTP listener down. */
  private foundryServer: ReturnType<typeof createFoundryMcpServer> | null = null;
  /**
   * The most recent user `create_message` id. Rewind needs the pre-attempt
   * message id, and the engine reads this between turns to capture it.
   */
  private userMessageId: string | null = null;

  constructor(private readonly opts: SdkSessionOptions) {}

  get id(): string | null {
    return this.session?.id ?? null;
  }

  get alive(): boolean {
    return !!this.session && !this.exited;
  }

  /** Last user-message id observed on this session, or null before any turn. */
  get lastUserMessageId(): string | null {
    return this.userMessageId;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** droid's own model list for this session, sniffed off the init response. */
  get availableModels(): AvailableModel[] {
    return this.sniffer?.availableModels ?? [];
  }

  /** The model this session actually runs on, after any substitution. */
  get activeModel(): string {
    return this.settings.modelId ?? (this.wantsModel() ? this.opts.model : 'droid default');
  }

  /**
   * The argv the SDK spawns, for the trace's process row. `--auto` is inert
   * for a stream-jsonrpc session (only session settings decide autonomy); it
   * is passed so `ps` describes the child the same way the session is
   * configured, and it is validated at spawn, so a bad value fails loudly.
   */
  spawnArgs(): string[] {
    return [
      'exec',
      '--input-format',
      'stream-jsonrpc',
      '--output-format',
      'stream-jsonrpc',
      '--auto',
      AUTONOMY_LEVEL,
    ];
  }

  async start(existingSessionId?: string | null): Promise<void> {
    const inner = this.opts.transport ?? (await this.spawnTransport());
    const sniffer = new SniffingTransport(inner, {
      onEarlyNotification: (n) => this.deliver(n),
      onTransportError: (error) => this.onTransportError(error),
    });
    this.sniffer = sniffer;

    this.toolRefreshDelay = this.opts.toolRefreshDelayMs ?? MCP_TOOL_SETTLE_MS;
    // Init-time mcpServers only: session-scoped, no config write, no late-tool
    // escape window. Never session.addMcpServer() (writes ~/.factory/mcp.json).
    const foundryServer = this.opts.foundryMcp
      ? createFoundryMcpServer(this.opts.foundryMcp)
      : null;
    this.foundryServer = foundryServer;
    const userServers = (this.opts.userMcpServers ?? [])
      .filter((s) => !s.disabled)
      .map(mapUserMcpToSdk);
    const mcpServers =
      foundryServer || userServers.length
        ? [...(foundryServer ? [foundryServer] : []), ...userServers]
        : undefined;
    const shared = {
      transport: sniffer,
      execArgs: ['--auto', AUTONOMY_LEVEL],
      permissionHandler: (params: RequestPermissionRequestParams) => this.onPermission(params),
      askUserHandler: (params: AskUserRequestParams) => this.onAskUser(params),
      ...(mcpServers ? { mcpServers } : {}),
    };
    // `autonomyLevel` is stated on every create and re-stated after every
    // resume: omitting it happens to default to high, and load_session carries
    // no settings at all, so neither path may be left to chance.
    //
    // The model and the reasoning effort deliberately do NOT travel here: the
    // effort can only be gated against droid's own model list, which arrives
    // with this very response, and leaving the model out keeps droid's default
    // visible in it — the only known-good model to fall back to later.
    this.session = existingSessionId
      ? await resumeSession(existingSessionId, shared)
      : await createSession({
          ...shared,
          cwd: this.opts.cwd,
          machineId: 'foundry',
          autonomyLevel: AUTONOMY,
        });

    this.session.onNotification((envelope) => this.onEnvelope(envelope));
    sniffer.markSubscribed();
    this.settings = { ...(sniffer.initResult?.settings ?? {}) };
    this.droidDefaultModel = this.settings.modelId ?? null;

    if (existingSessionId) await this.verifyResumedCwd(existingSessionId);

    const applied = await this.applySettings();
    if (applied.warning) this.opts.onModelWarning?.(applied.warning);
    await this.applyToolPolicy();
  }

  /**
   * Re-states everything the roster asked for on the live session and reports
   * which model actually took effect. droid accepts an unknown model id here
   * without complaint — only a turn finds out — so `availableModels` (droid's
   * own list, not Foundry's catalog) is checked before anything is spent.
   */
  async applySettings(): Promise<{ model: string; warning?: string }> {
    const session = this.session;
    if (!session) return { model: this.activeModel };

    const wantsModel = this.wantsModel() && !this.modelRefused;
    await this.updateSettings({
      autonomyLevel: AUTONOMY,
      ...(wantsModel ? { modelId: this.opts.model } : {}),
      ...(wantsModel ? this.effortFor(this.opts.model, this.availableModels) : {}),
    });

    const models = this.availableModels;
    if (wantsModel && models.length && !models.some((m) => m.id === this.opts.model)) {
      return {
        model: this.opts.model,
        warning: `${this.opts.model} is not in this session's available models; turns may come back empty`,
      };
    }
    return { model: this.activeModel };
  }

  /** The session's own tool list, whose `allowed` flag is what actually applied. */
  async listTools(): Promise<SessionTool[]> {
    if (!this.session) return [];
    const tools = await this.session.listTools();
    return tools.map((tool) => ({
      id: tool.id,
      displayName: tool.displayName,
      description: tool.description,
      category: tool.category,
      defaultAllowed: tool.defaultAllowed,
      allowed: tool.allowed,
    }));
  }

  /**
   * Send the prompt and resolve when droid reports the turn complete.
   * The SDK's stream ends on a terminal `result` message; a turn that failed
   * arrives as one of those too, with `success: false`, so the result is
   * inspected rather than trusted.
   */
  async send(text: string, timeoutMs: number, opts: TurnOptions = {}): Promise<TurnResult> {
    try {
      return await this.runTurn(text, timeoutMs, opts);
    } catch (error) {
      // The only thing that ever rejects the roster's model is a turn, so the
      // substitution the session was created for happens here, once.
      if (!this.canSubstituteModel(error)) throw error;
      // Reported before the retry: which model the run is on is worth knowing
      // even if the retry then fails for its own reasons.
      this.opts.onModelWarning?.(await this.dropModelOverride(errorText(error)));
      return this.runTurn(text, timeoutMs, opts);
    }
  }

  private async runTurn(text: string, timeoutMs: number, opts: TurnOptions): Promise<TurnResult> {
    const session = this.session;
    if (!session) throw new DroidProtocolError('session not initialised');
    if (!this.alive) throw new DroidProtocolError('droid child is not running');

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
      const stream = session.stream(text, {
        abortSignal: controller.signal,
        ...(opts.outputFormat ? { outputFormat: opts.outputFormat } : {}),
      });
      for await (const message of stream) {
        if (message.type === 'result') result = message;
      }
    } catch (error) {
      // The exact string the phase-fallback logic keys on; the SDK's own abort
      // error says nothing about a timeout.
      if (timedOut) throw new DroidProtocolError(`turn timed out after ${timeoutMs}ms`);
      throw asProtocolError(error);
    } finally {
      clearTimeout(timer);
      this.collector = null;
    }

    if (!result) throw new DroidProtocolError('droid ended the turn without a result');
    // A reply droid could not shape is a turn that ran, not a transport that
    // broke: the text is still the answer, and the caller decides whether it
    // parses. Only a genuinely failed turn ends the phase here.
    if (!result.success && !result.interrupted && result.subtype !== 'error_structured_output') {
      // An unknown or forbidden model does not fail at init or at settings
      // time — it fails here, as a non-throwing result with an empty text.
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

  /** Ends the turn; the session and its child survive for the next one. */
  async interrupt(): Promise<void> {
    if (!this.session || !this.alive) return;
    try {
      await this.session.interrupt();
    } catch {
      // Best-effort; kill is the guarantee.
    }
  }

  async contextStats(): Promise<ContextStatsResult | null> {
    if (!this.session) return null;
    try {
      const stats = await this.session.getContextStats();
      return {
        used: stats.used,
        remaining: stats.remaining,
        limit: stats.limit,
        accuracy: stats.accuracy,
      };
    } catch {
      return null;
    }
  }

  /**
   * Compacts the conversation and continues on the successor session droid
   * mints for it. The source handle is retired the moment the successor loads
   * (any later frame on it raises `SessionReplacedError`), so the swap has to
   * happen here and `id` has to follow it — the caller persists the new id.
   *
   * Never call this with a turn in flight: the SDK refuses a replacement while
   * a stream is open, and the engine only ever compacts between phases.
   */
  async compact(): Promise<{ removedCount: number } | null> {
    const session = this.session;
    if (!session) return null;
    const outcome = await session.compact();
    await this.adoptSuccessor(outcome.session);
    return { removedCount: outcome.removedCount };
  }

  /**
   * Files the CLI can restore (and the ones it would delete) if the session
   * were rewound to `messageId`. Diagnostic for the engine's intersection with
   * the phase-start snapshot; a transport that cannot answer returns null.
   */
  async getRewindInfo(messageId: string): Promise<{
    availableFiles: { filePath: string; contentHash: string; size: number }[];
    createdFiles: { filePath: string }[];
    evictedFiles: { filePath: string; reason: string }[];
  } | null> {
    const session = this.session;
    if (!session) return null;
    const info = await session.getRewindInfo({ messageId });
    return {
      availableFiles: info.availableFiles.map((file) => ({
        filePath: file.filePath,
        contentHash: file.contentHash,
        size: file.size,
      })),
      createdFiles: info.createdFiles.map((file) => ({ filePath: file.filePath })),
      evictedFiles: info.evictedFiles.map((file) => ({
        filePath: file.filePath,
        reason: file.reason,
      })),
    };
  }

  /**
   * Rewinds the conversation to `messageId`, restores/deletes the given files,
   * and continues on the successor session. Same replacement mechanics as
   * compact: source handle retired, id follows, settings re-stated.
   *
   * Never call this with a turn in flight.
   */
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
    const session = this.session;
    if (!session) return null;
    const outcome = await session.rewind(params);
    await this.adoptSuccessor(outcome.session);
    // The successor is a fork of the conversation at messageId; the last user
    // message on this handle is that anchor until a new turn lands.
    this.userMessageId = params.messageId;
    return {
      restoredCount: outcome.restoredCount,
      deletedCount: outcome.deletedCount,
      failedRestoreCount: outcome.failedRestoreCount,
      failedDeleteCount: outcome.failedDeleteCount,
    };
  }

  /**
   * A compact/rewind successor is loaded, not created: re-subscribe, follow
   * `id`, and re-state settings the load_session path does not carry.
   */
  private async adoptSuccessor(successor: DroidSession): Promise<void> {
    this.session = successor;
    // The retired handle's subscriptions are released by the SDK when the
    // successor loads, so without re-subscribing the trace goes quiet for the
    // rest of the run.
    successor.onNotification((envelope) => this.onEnvelope(envelope));
    this.settings = { ...this.settings, ...successor.settings };
    const applied = await this.applySettings();
    if (applied.warning) this.opts.onModelWarning?.(applied.warning);
  }

  /**
   * What is filling this session's context window. `droid.get_context_breakdown`
   * is a real protocol method with no `DroidSession` counterpart, so the request
   * is injected through the sniffing transport. Diagnostic only: a `null` here
   * must never block a run.
   */
  async contextBreakdown(): Promise<ContextBreakdown | null> {
    if (!this.session || !this.sniffer) return null;
    return this.sniffer.request<ContextBreakdown>('droid.get_context_breakdown');
  }

  async close(): Promise<void> {
    if (this.toolRefresh) clearTimeout(this.toolRefresh);
    this.toolRefresh = null;
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        await session.close();
      } catch {
        // A session whose child already died is closed enough.
      }
    } else if (this.owned) {
      // Transport never reached session creation; close the owned transport
      // directly. A dead child reports as failure; null pid is already gone.
      await this.owned.close().catch(() => undefined);
    }
    // session.close() runs the SDK cleanup that stops the loopback listener;
    // call it again here so a kill that skipped close still leaves no orphan.
    await this.closeFoundryServer();
    this.exited = true;
  }

  kill(): void {
    this.child?.kill('SIGKILL');
    // Best-effort: the HTTP listener must not outlive a killed child. close()
    // is the orderly path; this covers cancel/kill before closeSessions runs.
    void this.closeFoundryServer();
  }

  private async closeFoundryServer(): Promise<void> {
    const server = this.foundryServer;
    this.foundryServer = null;
    if (!server) return;
    try {
      await server.close();
    } catch {
      // Already closed by the SDK cleanup, or never started.
    }
  }

  private async spawnTransport(): Promise<StringFramedDroidClientTransport> {
    const transport = new ProcessTransport({
      droidExecPath: this.opts.droidPath,
      droidExecExtraArgs: ['--auto', AUTONOMY_LEVEL],
      cwd: this.opts.cwd,
      env: stringEnv(),
    });
    await transport.connect();
    this.owned = transport;
    const child = transport.getManagedProcess()?.childProcess ?? null;
    this.child = child;
    // Unify kill paths: RunRegistry.kill(runId) scans the procs registry;
    // executor.cancel() drives session.kill() directly. Register here so
    // either path suffices; the actual kill comes from session.kill() today.
    if (child?.pid && this.opts.runId) {
      registerProc(this.opts.runId, child, `${this.opts.droidPath} ${this.spawnArgs().join(' ')}`);
    }
    // The SDK forwards stderr to its logger, which strips the text out of any
    // customer-supplied sink, so the pipe is read directly instead.
    child?.stderr?.on('data', (chunk: Buffer) => this.opts.onStderr?.(chunk.toString()));
    child?.on('exit', (code) => this.reportExit(code));
    child?.on('error', (error: Error) => this.opts.onStderr?.(`spawn error: ${error.message}`));
    return transport;
  }

  /**
   * A resumed session runs in the directory it was created in — the CLI
   * reports that as a realpath, so `/tmp` and `/private/tmp` are the same
   * place and only a resolved comparison can tell a real mismatch.
   */
  private async verifyResumedCwd(sessionId: string): Promise<void> {
    const sessionCwd = this.session?.cwd;
    if (!sessionCwd || resolvePath(sessionCwd) === resolvePath(this.opts.cwd)) return;
    await this.close();
    throw new DroidProtocolError(
      `session ${sessionId} runs in ${sessionCwd}, not this run's worktree ${this.opts.cwd}`,
    );
  }

  /** A roster entry may decline to pick a model and take droid's own default. */
  private wantsModel(): boolean {
    return !!this.opts.model && this.opts.model !== INHERIT_MODEL;
  }

  /**
   * An effort droid does not list for this model is dropped rather than sent:
   * a rejected setting would fail the whole session for a preference. The
   * catalog is advisory; droid's own list wins.
   */
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

  /** Tracks what droid says the settings are now, since it is the authority. */
  private async updateSettings(params: Parameters<DroidSession['updateSettings']>[0]) {
    await this.session?.updateSettings(params);
    this.settings = { ...this.settings, ...(this.session?.settings ?? {}) };
  }

  /**
   * A model the org forbids or droid does not know is accepted at init and at
   * settings time and only rejected when a turn runs on it, as a 400 inside an
   * otherwise ordinary result.
   */
  private canSubstituteModel(error: unknown): boolean {
    if (this.modelRefused || !this.wantsModel() || !this.alive) return false;
    return /invalid model id/i.test(errorText(error));
  }

  /** Retries the session on droid's own default and says which model won. */
  private async dropModelOverride(reason: string): Promise<string> {
    this.modelRefused = true;
    // droid keeps the last modelId it was given, so the override is cleared by
    // re-stating the default this session started on rather than by omission.
    await this.updateSettings({
      autonomyLevel: AUTONOMY,
      ...(this.droidDefaultModel ? { modelId: this.droidDefaultModel } : {}),
    });
    const fallback = this.droidDefaultModel ?? 'droid default';
    return `${this.opts.model} was refused (${reason}); this session runs on ${fallback}`;
  }

  /**
   * The SDK is subtractive only (`restrictToolIds` is stripped by its public
   * schemas), so an allowlist becomes its complement. `updateSettings` accepts
   * ids that do not exist without complaining, which is why the caller-visible
   * proof of what applied is a `listTools()` re-read, never this request.
   */
  private async applyToolPolicy(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const allow = this.opts.restrictTools;
    const explicit = this.opts.disabledTools ?? [];
    if (!allow?.length && !explicit.length) return;

    // Foundry MCP tools stay available under a restricted roster: the allow
    // set is the roster list extended with the wire ids listTools reports.
    const allowed = new Set([...(allow ?? []), ...FOUNDRY_TOOL_IDS]);
    const complement = allow?.length
      ? (await session.listTools()).map((t) => t.id).filter((id) => !allowed.has(id))
      : [];
    const disabled = [...new Set([...complement, ...explicit])].sort();

    if (this.appliedDisabledTools?.join('\u0000') === disabled.join('\u0000')) return;
    this.appliedDisabledTools = disabled;
    await this.updateSettings({ disabledToolIds: disabled });
  }

  /**
   * A tool that attaches mid-session is allowed until the complement is
   * recomputed, and it reaches `list_tools` about a second after the CLI
   * announces its server — so the recompute is scheduled, not immediate.
   */
  private scheduleToolPolicy(): void {
    if (!this.opts.restrictTools?.length || this.toolRefresh) return;
    const timer = setTimeout(() => {
      this.toolRefresh = null;
      // Background reconciliation: failure is not surfaced to the turn — the
      // next settings_updated / a subsequent timer still retries. Swallowing
      // here avoids an unhandled rejection; the policy's correctness is still
      // asserted via listTools re-read in tests.
      void this.applyToolPolicy().catch(() => undefined);
    }, this.toolRefreshDelay);
    timer.unref?.();
    this.toolRefresh = timer;
  }

  /**
   * The zero-interrupt policy answers every ask. Shared adapters map
   * allow/deny onto SDK selections (including proceedOption so an unoffered
   * selection is never returned bare).
   */
  private async onPermission(
    params: RequestPermissionRequestParams,
  ): Promise<RequestPermissionHandlerResult> {
    const decision = await this.opts.onPermission(toPermissionAsk(params));
    return toPermissionHandlerResult(decision, params);
  }

  /**
   * `cancelled` is never used for an ordinary question: the CLI reads it as a
   * refusal and the agent asks again, which is exactly the stall the policy
   * exists to prevent.
   */
  private async onAskUser(params: AskUserRequestParams): Promise<AskUserResult> {
    const decision = await this.opts.onPermission(toAskUserAsk(params));
    return toAskUserResult(decision);
  }

  private onEnvelope(envelope: Record<string, unknown>): void {
    const params = envelope.params;
    if (typeof params !== 'object' || params === null) return;
    const notification = (params as { notification?: DroidNotification }).notification;
    // EventFolder and stream.jsonl speak droid's notification shape, not the
    // JSON-RPC envelope it travels in.
    if (notification) this.deliver(notification);
  }

  private deliver(notification: DroidNotification): void {
    this.noteUserMessage(notification);
    this.collector?.absorb(notification);
    if (notification.type === 'settings_updated' || notification.type === 'mcp_status_changed') {
      this.scheduleToolPolicy();
    }
    this.opts.onNotification?.(notification);
  }

  /** User create_message ids are the only rewind anchors the engine can name. */
  private noteUserMessage(notification: DroidNotification): void {
    if (notification.type !== 'create_message') return;
    const message = (notification as { message?: { id?: string; role?: string } }).message;
    if (message?.role !== 'user' || typeof message.id !== 'string' || !message.id) return;
    this.userMessageId = message.id;
  }

  private onTransportError(error: Error): void {
    if (error instanceof ProcessExitError) {
      this.reportExit(error.exitCode ?? null);
    }
  }

  private reportExit(code: number | null): void {
    this.exited = true;
    if (this.exitReported) return;
    this.exitReported = true;
    this.opts.onExit?.(code);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The SDK types its structured output as `unknown`; only an object is one. */
function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asProtocolError(error: unknown): Error {
  if (error instanceof DroidProtocolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new DroidProtocolError(message);
}

function resolvePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A path that no longer exists still has to compare as itself.
    return path;
  }
}

function mapUserMcpToSdk(s: UserMcpServer): McpServerConfig {
  if (s.type === 'stdio') {
    return { name: s.name, command: s.command, args: s.args, env: s.env } as never;
  }
  if (s.type === 'sse') {
    return { type: 'sse', name: s.name, url: s.url } as never;
  }
  return { type: 'http', name: s.name, url: s.url } as never;
}

/** ProcessTransport wants a defined-valued env; `process.env` does not have one. */
function stringEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(spawnEnv())) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
