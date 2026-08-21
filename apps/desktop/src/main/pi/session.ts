/**
 * One agent's session for the whole run: `send(turn) -> events + final text`.
 *
 * Lifecycle policy lives here — when a session opens, what a turn is traced
 * as, when it compacts, when it rewinds, what a permission ask is answered —
 * and the transport is injected. That split is deliberate: swapping the agent
 * runtime should cost one adapter, not a pass over the engine, and a test
 * should be able to drive the real lifecycle without a vendor in the room.
 *
 * A session belongs to one agent and starts lazily on that agent's first phase.
 */

import type { AgentDef, ContextBreakdown, ReasoningEffort, UsageBreakdown } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import { EventFolder, toUsageBreakdown } from './events.js';
import { evaluate } from './policy.js';
import { FOUNDRY_TOOL_NAMES } from './tools.js';
import type {
  AgentTransport,
  ContextStats,
  OutputFormat,
  PermissionAsk,
  PermissionDecision,
  RewindOutcome,
  TransportEvent,
  TurnResult,
} from './transport.js';

/** Which agent runtime answered for a run. */
export type Mode = 'pi';

export interface AgentTurnContext {
  phaseId: string;
  /** Constrains the phase's answer; also the schema `submit_envelope` carries. */
  outputFormat?: OutputFormat;
  /** Live text tail for the phase panel; a ring buffer, never stored. */
  onText?: (text: string) => void;
  /** Standing role for this turn; the transport installs it as the system prompt. */
  systemPrompt?: string;
}

/**
 * A deliberate human checkpoint an engineer phase raises. Permission asks are
 * never one of these: a started run settles without a person.
 */
export interface InterruptRequest {
  runId: string;
  phaseId: string | null;
  kind: 'engineer';
  title: string;
  body: string;
}

export interface AgentSessionDeps {
  runId: string;
  worktree: string;
  tracer: Tracer;
  protectedPaths: string[];
  /** Persisted runtime session to reopen when a terminal run is continued. */
  existingSessionId?: string | null;
  /** Builds the transport this session drives. Injected, never constructed here. */
  transport: (input: TransportRequest) => AgentTransport;
}

/** Everything a transport factory needs that only the session knows. */
export interface TransportRequest {
  agent: AgentDef;
  cwd: string;
  runId: string;
  onPermission: (ask: PermissionAsk) => PermissionDecision;
  onEvent: (event: TransportEvent) => void;
  onModelWarning: (warning: string) => void;
  phaseId: () => string | null;
}

/** Where an agent's last context breakdown is kept among the run's raw records. */
export function breakdownFile(agent: string): string {
  return `${agent}/context-breakdown.json`;
}

/** A breakdown as it was when the session could still be asked for one. */
export interface CapturedBreakdown {
  capturedAt: string;
  breakdown: ContextBreakdown;
}

/**
 * Why a turn stopped when the operator ended the run, and the detail the run
 * settles with. A kill is a verdict, not a transport flap: the killed turn must
 * never be retried, or the kill settles as an accepted run.
 */
export const KILLED_DETAIL = 'the run was killed';

/** Raised instead of a transport failure once a session has been killed. */
class RunKilledError extends Error {
  constructor() {
    super(KILLED_DETAIL);
    this.name = 'RunKilledError';
  }
}

export interface TurnOutcome {
  text: string;
  usage: UsageBreakdown;
  reason: string;
  /** True when the operator stopped the turn. */
  interrupted: boolean;
  /** What the transport claims conforms to the requested schema, if anything. */
  structuredOutput: Record<string, unknown> | null;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class AgentSession {
  private transport: AgentTransport | null = null;
  private readonly mode: Mode = 'pi';
  private agentSessionId: string | null = null;
  private currentFolder: EventFolder | null = null;
  private currentPhaseId: string | null = null;
  private killed = false;

  constructor(
    private readonly agent: AgentDef,
    private readonly deps: AgentSessionDeps,
  ) {
    this.agentSessionId = deps.existingSessionId ?? null;
  }

  get currentMode(): Mode {
    return this.mode;
  }

  /**
   * The model this session actually asks for — the executor resolves the
   * roster's `inherit` against the install default before constructing the
   * session, so the trace can record what ran rather than the roster token.
   */
  get model(): string {
    return this.agent.model;
  }

  /** Resolved alongside {@link model}; never the roster's unresolved value. */
  get reasoningEffort(): ReasoningEffort {
    return this.agent.reasoningEffort;
  }

  get sessionId(): string | null {
    return this.agentSessionId;
  }

  /** Last user-message id on the live session, if one is open yet. */
  get lastUserMessageId(): string | null {
    return this.transport?.lastUserMessageId ?? null;
  }

  /** Rewind needs a live session, which only exists once a turn has opened one. */
  get canRewind(): boolean {
    return !!this.transport?.alive;
  }

  /** Started lazily: an agent that never runs a phase never opens a session. */
  private async ensureStarted(): Promise<void> {
    if (this.killed) throw new RunKilledError();
    if (this.transport?.alive) return;
    await this.open();
  }

  private async open(): Promise<void> {
    const transport = this.deps.transport({
      agent: this.agent,
      cwd: this.deps.worktree,
      runId: this.deps.runId,
      onPermission: (ask) => this.decide(ask),
      onEvent: (event) => this.currentFolder?.absorb(event),
      onModelWarning: (message) => this.agentLog('log', 'model', { message }),
      phaseId: () => this.currentPhaseId,
    });

    try {
      await transport.start(this.agentSessionId);
    } catch (e) {
      await transport.close().catch(() => undefined);
      if (this.killed) throw new RunKilledError();
      throw new Error(`agent session start failed: ${errorMessage(e)}`);
    }

    this.transport = transport;
    this.agentSessionId = transport.id;
    this.persistSession();
    if (this.killed) {
      await this.close();
      throw new RunKilledError();
    }
  }

  private agentLog(type: 'log' | 'error', suffix: string, payload: Record<string, unknown>): void {
    this.deps.tracer.event({
      runId: this.deps.runId,
      phaseId: this.currentPhaseId,
      type,
      name: `${this.agent.name}: ${suffix}`,
      payload,
    });
  }

  private persistSession(): void {
    this.deps.tracer.upsertAgentSession({
      runId: this.deps.runId,
      agent: this.agent.name,
      model: this.agent.model,
      reasoningEffort: this.agent.reasoningEffort,
      agentSessionId: this.agentSessionId,
      mode: this.mode,
      color: this.agent.color,
    });
  }

  /**
   * Every ask is settled here. Nothing waits for a person: the write boundary
   * is re-checked against git after the phase, which is what makes an in-turn
   * allow safe to give. Denials are traced; allows are not — they pair 1:1
   * with the tool_call already in the transcript.
   */
  private decide(ask: PermissionAsk): PermissionDecision {
    const outcome = evaluate(
      ask,
      {
        worktree: this.deps.worktree,
        writes: this.agent.writes,
        protectedPaths: this.deps.protectedPaths,
      },
      FOUNDRY_TOOL_NAMES,
    );
    if (outcome.decision.outcome !== 'allow') {
      this.deps.tracer.event({
        runId: this.deps.runId,
        phaseId: this.currentPhaseId,
        type: 'interrupt',
        name: `${outcome.decision.outcome} (policy)`,
        payload: {
          reason: outcome.reason,
          auto: true,
          tool: ask.tool,
          ...(outcome.command ? { command: outcome.command } : {}),
        },
      });
    }
    return outcome.decision;
  }

  async send(prompt: string, ctx: AgentTurnContext): Promise<TurnOutcome> {
    this.currentPhaseId = ctx.phaseId;
    await this.ensureStarted();

    const folder = new EventFolder({
      tracer: this.deps.tracer,
      runId: this.deps.runId,
      phaseId: ctx.phaseId,
      agent: this.agent.name,
      onText: ctx.onText,
    });
    this.currentFolder = folder;

    try {
      const result = await this.turn(prompt, folder, ctx);
      if (this.killed) {
        folder.closeDangling(KILLED_DETAIL);
        throw new RunKilledError();
      }
      folder.closeDangling('turn ended before this call reported a result');
      await this.refreshContext();
      return {
        text: result.text,
        usage: toUsageBreakdown(result.usage ?? folder.usage),
        reason: result.reason,
        interrupted: result.interrupted,
        structuredOutput: result.structuredOutput,
      };
    } finally {
      this.currentFolder = null;
    }
  }

  /**
   * A transport failure fails the turn. There is nothing to fall back to, and
   * an operator who cannot tell a healthy run from a degraded one is worse off
   * than one whose turn failed loudly; the engine's retry and gate machinery
   * is the right place to decide what a failed turn means.
   */
  private async turn(
    prompt: string,
    folder: EventFolder,
    ctx: Pick<AgentTurnContext, 'outputFormat' | 'systemPrompt'>,
  ): Promise<TurnResult> {
    const transport = this.transport;
    if (!transport) throw new Error('agent session is not open');
    try {
      return await transport.send(prompt, {
        outputFormat: ctx.outputFormat,
        ...(ctx.systemPrompt ? { systemPrompt: ctx.systemPrompt } : {}),
      });
    } catch (e) {
      if (this.killed) {
        folder.closeDangling(KILLED_DETAIL);
        throw new RunKilledError();
      }
      folder.closeDangling(`transport failed: ${errorMessage(e)}`);
      throw e;
    }
  }

  private async refreshContext(): Promise<void> {
    const stats = await this.contextStats();
    if (!stats) return;
    this.deps.tracer.setAgentContext(
      this.deps.runId,
      this.agent.name,
      stats.used ?? 0,
      stats.limit ?? 0,
    );
    await this.captureBreakdown();
  }

  /**
   * The breakdown outlives the session it describes. It can only be read off a
   * live session, so a run that has finished would have nothing to show the
   * operator; the last one each turn produced is kept with the run's other raw
   * records instead. A read that fails leaves the previous snapshot in place.
   */
  private async captureBreakdown(): Promise<void> {
    const breakdown = await this.contextBreakdown();
    if (!breakdown) return;
    try {
      this.deps.tracer.writeRunFile(
        this.deps.runId,
        breakdownFile(this.agent.name),
        JSON.stringify({ capturedAt: new Date().toISOString(), breakdown }, null, 2),
      );
    } catch {
      // A record of a diagnostic is not worth failing a turn over.
    }
  }

  /**
   * How full this agent's context is, or `null` before the first turn has
   * opened a session to measure.
   */
  async contextStats(): Promise<ContextStats | null> {
    if (!this.transport) return null;
    return this.transport.contextStats();
  }

  /**
   * What is occupying this agent's context, for the Inspector's disclosure.
   * `null` before a session exists, and when the transport cannot account for
   * it by category — a breakdown is a view, never a run input.
   */
  async contextBreakdown(): Promise<ContextBreakdown | null> {
    if (!this.transport) return null;
    return this.transport.contextBreakdown();
  }

  /**
   * Compacts this agent's conversation between phases.
   *
   * Failure is survivable by design — the next turn then hits the context wall
   * as it would have anyway, so the reason is traced and the run carries on.
   */
  async compact(before: ContextStats): Promise<{ removedCount: number } | null> {
    if (!this.transport) return null;
    try {
      const outcome = await this.transport.compact();
      if (!outcome) return null;
      this.agentSessionId = this.transport.id;
      this.persistSession();
      const after = await this.transport.contextStats();
      if (after) {
        this.deps.tracer.setAgentContext(
          this.deps.runId,
          this.agent.name,
          after.used ?? 0,
          after.limit ?? 0,
        );
      }
      this.deps.tracer.event({
        runId: this.deps.runId,
        phaseId: this.currentPhaseId,
        type: 'compaction',
        name: this.agent.name,
        payload: {
          removedCount: outcome.removedCount,
          before: { used: before.used, limit: before.limit },
          ...(after ? { after: { used: after.used, limit: after.limit } } : {}),
        },
      });
      return outcome;
    } catch (e) {
      this.agentLog('log', 'compaction failed', { message: errorMessage(e) });
      return null;
    }
  }

  /**
   * Rewind the live session to `messageId` and restore the named paths.
   *
   * `paths` is a plain list the caller already decided belong at this rewind
   * (typically the phase-start dirty files). This layer does not import a
   * Snapshot; path policy lives with `PhaseRewinder`.
   *
   * Returns null when rewind is impossible (no session yet, or no messageId)
   * or when the transport refuses — the caller then falls back to an
   * append-style correction. A failure here must never fail the phase.
   *
   * The worktree half is the caller's: `boundary.restoreToPhaseStart` puts the
   * files back, because git knows what changed and a conversation does not.
   */
  async rewind(input: { messageId: string; paths: string[] }): Promise<RewindOutcome | null> {
    if (!this.canRewind || !this.transport) return null;
    const messageId = input.messageId.trim();
    if (!messageId) return null;
    try {
      const info = await this.transport.getRewindInfo(messageId);
      if (!info) return null;
      // Match on path only: a transport's own hash/size are what it accepts.
      const wanted = new Set(input.paths.map(normaliseRewindPath));
      const filesToRestore = info.availableFiles.filter((file) =>
        wanted.has(normaliseRewindPath(file.filePath)),
      );
      const outcome = await this.transport.rewind({
        messageId,
        filesToRestore,
        filesToDelete: info.createdFiles.map((file) => ({ filePath: file.filePath })),
        forkTitle: `foundry:${this.agent.name}:correction`,
      });
      if (!outcome) return null;
      this.agentSessionId = this.transport.id;
      this.persistSession();
      return outcome;
    } catch (e) {
      this.agentLog('log', 'rewind failed', { message: errorMessage(e) });
      return null;
    }
  }

  async interrupt(): Promise<void> {
    await this.transport?.interrupt();
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }

  kill(): void {
    this.killed = true;
    this.transport?.kill();
  }

  static emptyUsage(): UsageBreakdown {
    return toUsageBreakdown(null);
  }
}

function normaliseRewindPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}
