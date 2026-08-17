/**
 * A scripted agent behind the daemon's session facade.
 *
 * Agent runs are daemon-only, and a unit test cannot have a real `droid daemon`
 * (it needs a port, an API key, and the network). This implements the same
 * `DaemonSessionsFacade` the production `DaemonManager` hands to `DaemonSession`,
 * so the engine drives the real transport, the real permission wiring, and the
 * real turn collector — only the daemon behind them is scripted.
 *
 * The whole behaviour is a list of scripted turns, so a pipeline's control flow
 * can be tested without a model in the loop. Side effects are written straight
 * to the worktree, which is what makes boundary enforcement (a post-call `git
 * diff`) a real assertion rather than a simulated one.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import {
  ToolConfirmationOutcome,
  type AskUserRequestParams,
  type AskUserResult,
  type DroidResultMessage,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import type { ContextBreakdown } from '@shared/types.js';
import type { DroidNotification } from '../src/main/droid/protocol.js';
import type {
  DaemonHandle,
  DaemonSessionsFacade,
  DaemonStreamMessage,
} from '../src/main/droid/sdk/daemon-session.js';
import type { SessionTool } from '../src/main/droid/sdk/transport.js';

/**
 * One permission ask the scripted agent raises mid-turn, and what it does with
 * the answer. `writeIfAllowed` models an agent that respects a denial: the file
 * appears only when the policy allowed the write, so a leaked deny is visible
 * on disk rather than only in the trace.
 */
export interface ScriptedAsk {
  method: 'droid.request_permission' | 'droid.ask_user';
  params: Record<string, unknown>;
  writeIfAllowed?: string;
}

export interface AskReply {
  method: string;
  result: Record<string, unknown> | null;
}

export interface ScriptedAgentOptions {
  /** Turn indexes (0-based) on which the session dies mid-turn, answering nothing. */
  dieOnTurns?: number[];
  /** Context occupancy the session reports, against a 100k window. */
  contextUsed?: number;
  /** What it reports once compaction has run; defaults to a tenth of the used. */
  contextUsedAfterCompaction?: number;
  /** Compaction the daemon refuses, the way a session too short to compact would. */
  compactFails?: boolean;
  /** Turn indexes that are acknowledged but never completed, so the turn times out. */
  stallOnTurns?: number[];
  /** Held-back session start, so a test can act while the session is still opening. */
  handshakeDelayMs?: number;
  /** Structured output the daemon reports per turn index; `null` reports none. */
  structuredOutputs?: (unknown | null)[];
  /**
   * Completion reason per turn index. A `structured_output_*` reason is how the
   * CLI says it could not shape the reply.
   */
  turnReasons?: (string | null)[];
  /** Files getRewindInfo advertises and rewind can restore (path → bytes). */
  rewindFiles?: Record<string, string>;
  /** Paths getRewindInfo lists as created after the rewind anchor. */
  rewindCreatedFiles?: string[];
  /** Rewind the daemon refuses, so the engine must fall back to append-style. */
  rewindFails?: boolean;
  /** Paths to delete at the start of each turn, parallel to sideEffects. */
  deleteEffects?: (string | null)[];
}

const CONTEXT_LIMIT = 100_000;

const USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  thinkingTokens: 0,
};

type PermissionHandler = (
  p: RequestPermissionRequestParams,
) => Promise<RequestPermissionHandlerResult> | RequestPermissionHandlerResult;
type AskUserHandler = (p: AskUserRequestParams) => Promise<AskUserResult> | AskUserResult;

interface Handlers {
  permissionHandler?: PermissionHandler;
  askUserHandler?: AskUserHandler;
}

export class ScriptedAgent implements DaemonSessionsFacade {
  /** Every reply the scripted agent got back, in the order it raised the asks. */
  readonly askReplies: AskReply[] = [];
  /** Every prompt the engine sent, in order — the wire, not the trace. */
  readonly turnRequests: { text: string; outputFormat?: unknown; sessionId: string }[] = [];
  /**
   * Request names plus turn boundaries, in order. Whether compaction happened
   * mid-turn is only knowable from this ordering.
   */
  readonly wire: string[] = [];
  /** Per-turn snapshots of watched files, so a test can see pre-retry restores. */
  readonly contentAtTurns: { turn: number; files: Record<string, string | null> }[] = [];
  /** `"daemon <turn index>"` per turn the scripted agent has begun. */
  readonly turnMarkers: string[] = [];
  /** How many sessions have been opened, resumes included. */
  sessionOpens = 0;

  private turn = 0;
  private compactions = 0;
  private rewinds = 0;
  private seq = 0;
  private readonly handles = new Map<string, ScriptedAgentHandle>();
  private readonly handlers = new Map<string, Handlers>();
  /**
   * Working directory per session id, kept for the whole agent rather than on
   * the handle: compaction and rewind answer with a *successor* id, and the
   * engine resumes that id. A successor that forgot the cwd would write outside
   * the worktree, which silently defeats every boundary assertion.
   */
  private readonly persisted = new Map<string, string | undefined>();

  constructor(
    private readonly turns: string[],
    private readonly sideEffects: (string | null)[] = [],
    private readonly asks: ScriptedAsk[][] = [],
    private readonly options: ScriptedAgentOptions = {},
  ) {}

  /** Whether the scripted agent has begun a turn, i.e. a turn is in flight. */
  get turnStarted(): boolean {
    return this.turnMarkers.length > 0;
  }

  handlersFor(sessionId: string): Handlers | undefined {
    return this.handlers.get(sessionId);
  }

  async create(options: {
    cwd: string;
    permissionHandler?: PermissionHandler;
    askUserHandler?: AskUserHandler;
  }): Promise<DaemonHandle> {
    if (this.options.handshakeDelayMs) await sleep(this.options.handshakeDelayMs);
    this.sessionOpens += 1;
    this.wire.push('droid.initialize_session');
    const id = `s${++this.seq}`;
    return this.install(id, options.cwd, options);
  }

  async resume(
    sessionId: string,
    options: { permissionHandler?: PermissionHandler; askUserHandler?: AskUserHandler } = {},
  ): Promise<DaemonHandle> {
    if (!this.persisted.has(sessionId)) throw new Error(`SessionNotFoundError: ${sessionId}`);
    this.sessionOpens += 1;
    this.wire.push('droid.load_session');
    return this.install(sessionId, this.persisted.get(sessionId), options);
  }

  async updateSettings(sessionId: string, params: Record<string, unknown>): Promise<void> {
    void sessionId;
    void params;
    this.wire.push('droid.update_session_settings');
  }

  async getContextBreakdown(sessionId: string): Promise<ContextBreakdown> {
    void sessionId;
    this.wire.push('droid.get_context_breakdown');
    const used = this.contextUsed();
    return {
      modelId: 'scripted',
      modelDisplayName: 'Scripted',
      contextBudget: CONTEXT_LIMIT,
      usedTokens: used,
      freeTokens: CONTEXT_LIMIT - used,
      categories: [{ name: 'System prompt', tokens: 900, colorKey: 'systemPrompt' }],
      skills: [],
      mcpServers: [],
      droids: [],
    };
  }

  async getRewindInfo(
    sessionId: string,
    messageId: string,
  ): Promise<{
    availableFiles: { filePath: string; contentHash: string; size: number }[];
    createdFiles: { filePath: string }[];
    evictedFiles: { filePath: string; reason: string }[];
  }> {
    void sessionId;
    void messageId;
    this.wire.push('droid.get_rewind_info');
    if (this.options.rewindFails) throw new Error('rewind info unavailable');
    return {
      availableFiles: Object.entries(this.options.rewindFiles ?? {}).map(([filePath, content]) => {
        const buf = Buffer.from(content, 'utf8');
        return {
          filePath,
          contentHash: createHash('sha256').update(buf).digest('hex'),
          size: buf.byteLength,
        };
      }),
      createdFiles: (this.options.rewindCreatedFiles ?? []).map((filePath) => ({ filePath })),
      evictedFiles: [],
    };
  }

  async listTools(sessionId: string): Promise<SessionTool[]> {
    void sessionId;
    this.wire.push('droid.list_tools');
    return [
      {
        id: 'Execute',
        displayName: 'Execute',
        description: 'run a command',
        category: 'execute',
        defaultAllowed: true,
        allowed: true,
      },
    ];
  }

  private install(id: string, cwd: string | undefined, handlers: Handlers): ScriptedAgentHandle {
    this.handlers.set(id, {
      permissionHandler: handlers.permissionHandler,
      askUserHandler: handlers.askUserHandler,
    });
    const existing = this.handles.get(id);
    // One attached handle per id, as the daemon enforces.
    if (existing) existing.status = 'detached';
    const handle = new ScriptedAgentHandle(id, this, cwd);
    this.handles.set(id, handle);
    this.persisted.set(id, cwd);
    return handle;
  }

  private contextUsed(): number {
    const used = this.options.contextUsed ?? 1234;
    if (!this.compactions) return used;
    return this.options.contextUsedAfterCompaction ?? Math.round(used / 10);
  }

  /** Runs one scripted turn, raising its asks through the session's handlers. */
  async runTurn(
    handle: ScriptedAgentHandle,
    prompt: string,
    outputFormat?: unknown,
  ): Promise<DroidResultMessage> {
    const n = this.turn++;
    this.turnMarkers.push(`daemon ${n}`);
    this.recordWatchedContent(handle, n);
    this.turnRequests.push({ text: prompt, sessionId: handle.id, outputFormat });
    this.wire.push(`turn_started u${n} session=${handle.id}`);

    // The user message is how the transport learns the rewind anchor id.
    handle.notify({
      type: 'create_message',
      message: {
        id: `u${n}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        createdAt: 1,
        updatedAt: 1,
      },
    } as DroidNotification);

    if (this.options.dieOnTurns?.includes(n)) {
      handle.status = 'detached';
      throw new Error('daemon session died mid-turn');
    }
    // A stalled turn hangs until something ends it: a timeout aborts the
    // stream, and a kill interrupts the session. Both are real paths a test
    // needs to land on, so the turn parks rather than resolving.
    if (this.options.stallOnTurns?.includes(n)) return handle.stall();

    const doomed = this.options.deleteEffects?.[n];
    if (doomed) deleteFrom(handle.cwd, doomed);
    const effect = this.sideEffects[n];
    if (effect) writeInto(handle.cwd, effect);

    for (const ask of this.asks[n] ?? []) await this.raise(handle, ask);

    return this.finish(handle, n);
  }

  private async raise(handle: ScriptedAgentHandle, ask: ScriptedAsk): Promise<void> {
    const handlers = this.handlers.get(handle.id);
    let allowed = false;
    let recorded: Record<string, unknown> | null = null;

    if (ask.method === 'droid.request_permission') {
      const result = await handlers?.permissionHandler?.(
        ask.params as unknown as RequestPermissionRequestParams,
      );
      recorded = (result as unknown as Record<string, unknown>) ?? null;
      allowed = result !== undefined && selectionOf(result) !== ToolConfirmationOutcome.Cancel;
    } else {
      const result = await handlers?.askUserHandler?.(
        ask.params as unknown as AskUserRequestParams,
      );
      recorded = (result as unknown as Record<string, unknown>) ?? null;
      allowed = !!result && !result.cancelled;
    }

    this.askReplies.push({ method: ask.method, result: recorded });
    if (ask.writeIfAllowed && allowed) writeInto(handle.cwd, ask.writeIfAllowed);
  }

  private finish(handle: ScriptedAgentHandle, n: number): DroidResultMessage {
    const text = this.turns[Math.min(n, this.turns.length - 1)] ?? '';
    const messageId = `m${n}`;
    handle.notify({
      type: 'create_message',
      message: {
        id: messageId,
        role: 'assistant',
        content: [{ type: 'text', text }],
        createdAt: 1,
        updatedAt: 1,
      },
    } as DroidNotification);

    const structured = this.options.structuredOutputs?.[n];
    if (structured !== undefined && structured !== null) {
      handle.notify({
        type: 'structured_output',
        messageId,
        structuredOutput: structured,
      } as DroidNotification);
    }
    handle.notify({ type: 'session_token_usage_changed', tokenUsage: USAGE } as DroidNotification);
    this.wire.push(`turn_completed ${n}`);
    handle.notify({
      type: 'agent_turn_completed',
      reason: this.options.turnReasons?.[n] || 'completed',
      turnId: `t${n}`,
      tokenUsage: USAGE,
    } as DroidNotification);

    return {
      type: 'result',
      subtype: 'success',
      success: true,
      interrupted: false,
      sessionId: handle.id,
      durationMs: 5,
      tokenUsage: USAGE,
      messages: [],
      text,
      turnCount: 1,
      error: null,
      ...(structured !== undefined && structured !== null
        ? { structuredOutput: structured as Record<string, unknown> }
        : {}),
    } as DroidResultMessage;
  }

  private recordWatchedContent(handle: ScriptedAgentHandle, n: number): void {
    const paths = Object.keys(this.options.rewindFiles ?? {});
    if (!paths.length) return;
    const files: Record<string, string | null> = {};
    for (const rel of paths) {
      try {
        files[rel] = readFileSync(resolveIn(handle.cwd, rel), 'utf8');
      } catch {
        files[rel] = null;
      }
    }
    this.contentAtTurns.push({ turn: n, files });
  }

  compactFrom(sourceId: string): { newSessionId: string; removedCount: number } {
    this.wire.push('droid.compact_session');
    if (this.options.compactFails) throw new Error('nothing to compact');
    this.compactions += 1;
    // Successor ids continue the `s<n>` series the create path mints, so a test
    // can name the session a compaction handed the run onto.
    const newSessionId = `s${++this.seq}`;
    this.persisted.set(newSessionId, this.persisted.get(sourceId));
    return { newSessionId, removedCount: 7 };
  }

  rewindFrom(
    handle: ScriptedAgentHandle,
    params: {
      filesToRestore: { filePath: string }[];
      filesToDelete: { filePath: string }[];
    },
  ): {
    newSessionId: string;
    restoredCount: number;
    deletedCount: number;
    failedRestoreCount: number;
    failedDeleteCount: number;
  } {
    this.wire.push('droid.execute_rewind');
    if (this.options.rewindFails) throw new Error('rewind refused');
    this.rewinds += 1;

    let restoredCount = 0;
    for (const file of params.filesToRestore) {
      const content = this.options.rewindFiles?.[file.filePath];
      if (content === undefined) continue;
      writeInto(handle.cwd, file.filePath, content);
      restoredCount += 1;
    }
    let deletedCount = 0;
    for (const file of params.filesToDelete) {
      try {
        rmSync(resolveIn(handle.cwd, file.filePath), { force: true });
        deletedCount += 1;
      } catch {
        // Best-effort, exactly as the daemon reports it.
      }
    }

    const newSessionId = `rw${this.rewinds}`;
    this.persisted.set(newSessionId, handle.cwd);
    return {
      newSessionId,
      restoredCount,
      deletedCount,
      failedRestoreCount: 0,
      failedDeleteCount: 0,
    };
  }
}

class ScriptedAgentHandle implements DaemonHandle {
  status: 'attached' | 'detached' = 'attached';
  readonly settings: Record<string, unknown> = {
    autonomyLevel: 'high',
    modelId: 'scripted',
    reasoningEffort: 'medium',
  };
  private readonly subscribers = new Set<(n: DroidNotification) => void>();
  /** Ends the parked turn, if one is parked, the way the daemon's interrupt does. */
  private endStall: ((result: DroidResultMessage) => void) | null = null;

  constructor(
    readonly id: string,
    private readonly agent: ScriptedAgent,
    readonly cwd: string | undefined,
  ) {}

  async *stream(
    prompt: string,
    options?: { abortSignal?: AbortSignal; outputFormat?: unknown },
  ): AsyncGenerator<DaemonStreamMessage, void, undefined> {
    if (this.status !== 'attached') throw new Error(`handle ${this.id} is detached`);
    const turn = this.agent.runTurn(this, prompt, options?.outputFormat);
    const signal = options?.abortSignal;
    if (!signal) {
      yield await turn;
      return;
    }
    if (signal.aborted) throw new Error('aborted');
    const aborted = new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    yield await Promise.race([turn, aborted]);
  }

  async interrupt(): Promise<void> {
    this.agent.wire.push('droid.interrupt_session');
    this.releaseStall();
  }

  async compact(): Promise<{ newSessionId: string; removedCount: number }> {
    return this.agent.compactFrom(this.id);
  }

  async rewind(params: {
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
  }> {
    return this.agent.rewindFrom(this, params);
  }

  async detach(): Promise<void> {
    this.status = 'detached';
    this.releaseStall();
  }

  async close(): Promise<void> {
    this.status = 'detached';
    this.releaseStall();
  }

  /** Park the turn until the session is interrupted, closed, or aborted. */
  stall(): Promise<DroidResultMessage> {
    return new Promise<DroidResultMessage>((resolve) => {
      this.endStall = resolve;
    });
  }

  private releaseStall(): void {
    const end = this.endStall;
    if (!end) return;
    this.endStall = null;
    end({
      type: 'result',
      subtype: 'interrupted',
      success: false,
      interrupted: true,
      sessionId: this.id,
      durationMs: 1,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
      },
      messages: [],
      text: '',
      turnCount: 1,
      error: null,
    } as DroidResultMessage);
  }

  subscribeNotifications(handler: (n: DroidNotification) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  notify(n: DroidNotification): void {
    for (const handler of this.subscribers) handler(n);
  }
}

/** The handler may answer with a bare outcome or an object carrying one. */
function selectionOf(result: RequestPermissionHandlerResult): string {
  return typeof result === 'string' ? result : result.selectedOption;
}

function resolveIn(cwd: string | undefined, path: string): string {
  if (isAbsolute(path)) return path;
  // Falling back to `process.cwd()` here would resolve a scripted write into
  // the Foundry checkout itself, and every boundary assertion in the executor
  // suite ("the file is not in the worktree") would pass for the wrong reason.
  if (!cwd) throw new Error(`scripted agent has no cwd to resolve ${path} against`);
  return join(cwd, path);
}

function writeInto(cwd: string | undefined, path: string, contents?: string): void {
  const target = resolveIn(cwd, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents ?? 'written by the scripted agent\n');
}

function deleteFrom(cwd: string | undefined, path: string): void {
  rmSync(resolveIn(cwd, path), { force: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
