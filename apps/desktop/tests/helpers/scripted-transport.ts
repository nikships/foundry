/**
 * A scripted agent behind the neutral transport seam.
 *
 * A unit test cannot run a real agent (it needs credentials, a network, and a
 * model), so this implements `AgentTransport` directly: the engine drives the
 * production `AgentSession`, the production policy, and the production event
 * folding, and only what would have talked to a provider is scripted.
 *
 * Deliberately imports nothing from `src/main/pi/pi-transport.ts` and no vendor
 * package. That is the seam's whole value: if the engine can be tested without
 * naming an agent runtime, then swapping the runtime cannot break the engine.
 *
 * The behaviour is a list of scripted turns, so a pipeline's control flow can
 * be tested without a model in the loop. Side effects are written straight to
 * the worktree, which is what makes boundary enforcement (a post-call `git
 * diff`) a real assertion rather than a simulated one.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { normalizeReasoningEffort } from '@shared/reasoning-effort.js';
import type { ContextBreakdown, ReasoningEffort } from '@shared/types.js';
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
} from '../../src/main/pi/transport.js';
import type { TransportRequest } from '../../src/main/pi/session.js';

/**
 * One permission ask the scripted agent raises mid-turn, and what it does with
 * the answer. `writeIfAllowed` models an agent that respects a denial: the file
 * appears only when the policy allowed the write, so a leaked deny is visible
 * on disk rather than only in the trace.
 */
export interface ScriptedAsk {
  tool: string;
  input: Record<string, unknown>;
  writeIfAllowed?: string;
}

export interface AskReply {
  tool: string;
  decision: PermissionDecision;
}

export interface ScriptedAgentOptions {
  /** Turn indexes (0-based) on which the session dies mid-turn, answering nothing. */
  dieOnTurns?: number[];
  /** Context occupancy the session reports, against a 100k window. */
  contextUsed?: number;
  /** What it reports once compaction has run; defaults to a tenth of the used. */
  contextUsedAfterCompaction?: number;
  /** Compaction the transport refuses, the way a session too short to compact would. */
  compactFails?: boolean;
  /** Turn indexes that are acknowledged but never completed until interrupted. */
  stallOnTurns?: number[];
  /** Held-back session start, so a test can act while the session is still opening. */
  handshakeDelayMs?: number;
  /** Structured output the transport reports per turn index; `null` reports none. */
  structuredOutputs?: (unknown | null)[];
  /** Completion reason per turn index. */
  turnReasons?: (string | null)[];
  /** Files getRewindInfo advertises and rewind can restore (path → bytes). */
  rewindFiles?: Record<string, string>;
  /** Paths getRewindInfo lists as created after the rewind anchor. */
  rewindCreatedFiles?: string[];
  /** Rewind the transport refuses, so the engine must fall back to append-style. */
  rewindFails?: boolean;
  /** Paths to delete at the start of each turn, parallel to sideEffects. */
  deleteEffects?: (string | null)[];
  /** Reason the session cannot be opened at all, so the run must fail to start one. */
  unavailable?: string;
}

const CONTEXT_LIMIT = 100_000;

const USAGE = {
  inputTokens: 100,
  outputTokens: 20,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  thinkingTokens: 0,
};

/**
 * The scripted agent for one run. It hands out a transport per agent session,
 * and every observation a test makes (`wire`, `turnRequests`, …) is kept here
 * so a run with two agents reads as one story.
 */
export class ScriptedAgent {
  /** Every decision the scripted agent got back, in the order it raised the asks. */
  readonly askReplies: AskReply[] = [];
  /** Every prompt the engine sent, in order — the wire, not the trace. */
  readonly turnRequests: {
    text: string;
    outputFormat?: unknown;
    systemPrompt?: string;
    sessionId: string;
  }[] = [];
  /**
   * Request names plus turn boundaries, in order. Whether compaction happened
   * mid-turn is only knowable from this ordering.
   */
  readonly wire: string[] = [];
  /** Per-turn snapshots of watched files, so a test can see pre-retry restores. */
  readonly contentAtTurns: { turn: number; files: Record<string, string | null> }[] = [];
  /** `"turn <index>"` per turn the scripted agent has begun. */
  readonly turnMarkers: string[] = [];
  /** How many sessions have been opened, resumes included. */
  sessionOpens = 0;

  private turn = 0;
  private compactions = 0;
  private seq = 0;
  private stalled: { transport: ScriptedTransport; turn: number } | null = null;

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

  /** The transport factory the executor's seam takes. */
  transport(req: TransportRequest): AgentTransport {
    return new ScriptedTransport(this, req);
  }

  /**
   * Let a parked turn answer the way a slow-but-successful turn does, rather
   * than the way an interrupt does. `interrupt()` and `close()` already end a
   * stall as `cancelled`, so without this a test cannot tell "the turn
   * finished" from "something tore the session down under it".
   */
  finishStall(): void {
    const parked = this.stalled;
    if (!parked) throw new Error('no scripted turn is parked');
    this.stalled = null;
    parked.transport.completeStall(this.finish(parked.transport, parked.turn));
  }

  nextSessionId(): string {
    return `s${++this.seq}`;
  }

  noteOpen(): void {
    this.sessionOpens += 1;
    this.wire.push('start');
  }

  get unavailable(): string | undefined {
    return this.options.unavailable;
  }

  get handshakeDelayMs(): number | undefined {
    return this.options.handshakeDelayMs;
  }

  contextStats(): ContextStats {
    const used = this.contextUsed();
    return { used, limit: CONTEXT_LIMIT, remaining: CONTEXT_LIMIT - used };
  }

  breakdown(): ContextBreakdown {
    const used = this.contextUsed();
    return {
      modelId: 'scripted',
      modelDisplayName: 'Scripted',
      contextBudget: CONTEXT_LIMIT,
      usedTokens: used,
      freeTokens: CONTEXT_LIMIT - used,
    };
  }

  private contextUsed(): number {
    const used = this.options.contextUsed ?? 1234;
    if (!this.compactions) return used;
    return this.options.contextUsedAfterCompaction ?? Math.round(used / 10);
  }

  compact(): { removedCount: number } {
    this.wire.push('compact');
    if (this.options.compactFails) throw new Error('nothing to compact');
    this.compactions += 1;
    return { removedCount: 7 };
  }

  rewindInfo(): RewindInfo {
    this.wire.push('get_rewind_info');
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

  rewind(cwd: string, params: RewindParams): RewindOutcome {
    this.wire.push('rewind');
    if (this.options.rewindFails) throw new Error('rewind refused');

    let restoredCount = 0;
    for (const file of params.filesToRestore) {
      const content = this.options.rewindFiles?.[file.filePath];
      if (content === undefined) continue;
      writeInto(cwd, file.filePath, content);
      restoredCount += 1;
    }
    let deletedCount = 0;
    for (const file of params.filesToDelete) {
      try {
        rmSync(resolveIn(cwd, file.filePath), { force: true });
        deletedCount += 1;
      } catch {
        // Best-effort, exactly as a real transport reports it.
      }
    }
    return { restoredCount, deletedCount, failedRestoreCount: 0, failedDeleteCount: 0 };
  }

  /** Runs one scripted turn, raising its asks through the session's policy. */
  async runTurn(
    transport: ScriptedTransport,
    prompt: string,
    opts: TurnOptions,
  ): Promise<TurnResult> {
    const n = this.turn++;
    this.turnMarkers.push(`turn ${n}`);
    this.recordWatchedContent(transport.cwd, n);
    this.turnRequests.push({
      text: prompt,
      sessionId: transport.id ?? '',
      outputFormat: opts.outputFormat,
      systemPrompt: opts.systemPrompt,
    });
    this.wire.push(`turn_started u${n} session=${transport.id}`);
    transport.noteUserMessage(`u${n}`);

    if (this.options.dieOnTurns?.includes(n)) {
      // A session that died is not reusable, so the next turn has to open one
      // rather than prompt a corpse.
      transport.kill();
      throw new Error('agent session died mid-turn');
    }
    // A stalled turn hangs until the operator interrupts or kills the session,
    // or a test lets it answer normally via `finishStall()`.
    if (this.options.stallOnTurns?.includes(n)) {
      this.stalled = { transport, turn: n };
      return transport.stall();
    }

    const doomed = this.options.deleteEffects?.[n];
    if (doomed) deleteFrom(transport.cwd, doomed);
    const effect = this.sideEffects[n];
    if (effect) writeInto(transport.cwd, effect);

    for (const ask of this.asks[n] ?? []) await this.raise(transport, ask);

    return this.finish(transport, n);
  }

  private async raise(transport: ScriptedTransport, ask: ScriptedAsk): Promise<void> {
    const decision = await transport.ask({
      tool: ask.tool,
      input: ask.input,
      ...(typeof ask.input.command === 'string' ? { command: ask.input.command } : {}),
      ...(typeof ask.input.path === 'string' ? { path: ask.input.path } : {}),
    });
    this.askReplies.push({ tool: ask.tool, decision });

    const callId = `call-${this.askReplies.length}`;
    transport.emit({ type: 'tool_call', callId, tool: ask.tool, input: ask.input });
    const allowed = decision.outcome === 'allow';
    if (ask.writeIfAllowed && allowed) writeInto(transport.cwd, ask.writeIfAllowed);
    transport.emit({
      type: 'tool_result',
      callId,
      content: allowed ? 'done' : `blocked: ${decision.outcome === 'deny' ? decision.reason : ''}`,
      isError: !allowed,
    });
  }

  private finish(transport: ScriptedTransport, n: number): TurnResult {
    const text = this.turns[Math.min(n, this.turns.length - 1)] ?? '';
    transport.emit({ type: 'text_delta', messageId: `m${n}`, blockIndex: 0, delta: text });
    transport.emit({ type: 'text_end', messageId: `m${n}`, blockIndex: 0 });
    transport.emit({ type: 'usage', usage: USAGE });
    this.wire.push(`turn_completed ${n}`);

    const structured = this.options.structuredOutputs?.[n];
    return {
      text,
      usage: USAGE,
      reason: this.options.turnReasons?.[n] || 'completed',
      interrupted: false,
      structuredOutput:
        structured !== undefined && structured !== null
          ? (structured as Record<string, unknown>)
          : null,
    };
  }

  private recordWatchedContent(cwd: string, n: number): void {
    const paths = Object.keys(this.options.rewindFiles ?? {});
    if (!paths.length) return;
    const files: Record<string, string | null> = {};
    for (const rel of paths) {
      try {
        files[rel] = readFileSync(resolveIn(cwd, rel), 'utf8');
      } catch {
        files[rel] = null;
      }
    }
    this.contentAtTurns.push({ turn: n, files });
  }
}

class ScriptedTransport implements AgentTransport {
  private sessionId: string | null = null;
  private closed = false;
  private userMessageId: string | null = null;
  /** Ends the parked turn, if one is parked, the way a real interrupt does. */
  private endStall: ((result: TurnResult) => void) | null = null;

  constructor(
    private readonly agent: ScriptedAgent,
    private readonly req: TransportRequest,
  ) {}

  get cwd(): string {
    return this.req.cwd;
  }

  get id(): string | null {
    return this.sessionId;
  }

  get alive(): boolean {
    return !!this.sessionId && !this.closed;
  }

  get pid(): number | undefined {
    return undefined;
  }

  get lastUserMessageId(): string | null {
    return this.userMessageId;
  }

  get availableModels(): TransportModel[] {
    return [
      {
        id: 'scripted',
        displayName: 'Scripted',
        provider: 'scripted',
        supportedReasoningEfforts: ['off', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
        contextWindow: CONTEXT_LIMIT,
      },
    ];
  }

  get activeModel(): string {
    return 'scripted';
  }

  /**
   * Clamped the way a real transport clamps: the scripted model offers only
   * `off`–`high`, so a caller asking for `xhigh` or `max` gets the model's
   * default back rather than a level no provider would accept.
   */
  get activeReasoningEffort(): ReasoningEffort {
    return normalizeReasoningEffort(this.req.agent.reasoningEffort, this.availableModels[0]);
  }

  ask(ask: PermissionAsk): PermissionDecision | Promise<PermissionDecision> {
    return this.req.onPermission(ask);
  }

  emit(event: TransportEvent): void {
    this.req.onEvent(event);
  }

  noteUserMessage(id: string): void {
    this.userMessageId = id;
  }

  async start(existingSessionId?: string | null): Promise<void> {
    if (this.agent.handshakeDelayMs) await sleep(this.agent.handshakeDelayMs);
    if (this.agent.unavailable) throw new Error(this.agent.unavailable);
    this.agent.noteOpen();
    this.closed = false;
    this.sessionId = existingSessionId ?? this.agent.nextSessionId();
  }

  send(text: string, opts: TurnOptions = {}): Promise<TurnResult> {
    return this.agent.runTurn(this, text, opts);
  }

  applySettings(): Promise<{ model: string; warning?: string }> {
    return Promise.resolve({ model: 'scripted' });
  }

  contextStats(): Promise<ContextStats | null> {
    return Promise.resolve(this.agent.contextStats());
  }

  contextBreakdown(): Promise<ContextBreakdown | null> {
    return Promise.resolve(this.agent.breakdown());
  }

  compact(): Promise<{ removedCount: number } | null> {
    return Promise.resolve(this.agent.compact());
  }

  getRewindInfo(messageId: string): Promise<RewindInfo | null> {
    void messageId;
    return Promise.resolve(this.agent.rewindInfo());
  }

  rewind(params: RewindParams): Promise<RewindOutcome | null> {
    const outcome = this.agent.rewind(this.cwd, params);
    this.userMessageId = params.messageId;
    return Promise.resolve(outcome);
  }

  interrupt(): Promise<void> {
    this.agent.wire.push('interrupt');
    this.releaseStall();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.releaseStall();
    return Promise.resolve();
  }

  kill(): void {
    this.closed = true;
    this.releaseStall();
  }

  /** Park the turn until the session is interrupted, closed, or killed. */
  stall(): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      this.endStall = resolve;
    });
  }

  /** Answer a parked turn normally, as `ScriptedAgent.finishStall()` does. */
  completeStall(result: TurnResult): void {
    const end = this.endStall;
    this.endStall = null;
    end?.(result);
  }

  private releaseStall(): void {
    const end = this.endStall;
    if (!end) return;
    this.endStall = null;
    end({ text: '', usage: null, reason: 'cancelled', interrupted: true, structuredOutput: null });
  }
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
