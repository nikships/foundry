/**
 * Adapter boundary: `send(turn) -> events + final text`, identical for JSON-RPC
 * or one-shot. The executor cannot tell which mode is active.
 *
 * A session belongs to one agent for the whole run and starts lazily on that
 * agent's first phase.
 */

import type { AgentDef, CliVendor, UsageBreakdown } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import { adapterFor } from '../cli/index.js';
import { type PermissionAsk, type PermissionDecision, type TurnResult } from './turn.js';
import { OneShotClient } from './oneshot.js';
import { EventFolder, toUsageBreakdown } from './events.js';
import { evaluate, type PolicyContext } from './permissions.js';
import { SdkSession } from './sdk/session.js';
import { isTransportFailure } from './sdk/errors.js';

export type Mode = 'rpc' | 'oneshot';

export interface AgentTurnContext {
  phaseId: string;
  /** Live text tail for the phase panel; a ring buffer, never stored. */
  onText?: (text: string) => void;
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
  /** Path to the binary this agent's CLI lives at. */
  cliPath: string;
  /** Flags the operator added for this CLI, appended to every turn. */
  cliExtraArgs?: string[];
  runId: string;
  worktree: string;
  turnTimeoutMs: number;
  tracer: Tracer;
  policy: Omit<PolicyContext, 'worktree' | 'writes'>;
  onModeChange?: (mode: Mode) => void;
}

const PROTOCOL_FAILURE_LIMIT = 2;

export interface TurnOutcome {
  text: string;
  usage: UsageBreakdown;
  reason: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class AgentSession {
  private rpc: SdkSession | null = null;
  private oneshot: OneShotClient | null = null;
  private mode: Mode = 'rpc';
  private protocolFailures = 0;
  private droidSessionId: string | null = null;
  private processRowId: number | null = null;
  private currentFolder: EventFolder | null = null;
  private currentPhaseId: string | null = null;

  constructor(
    private readonly agent: AgentDef,
    private readonly deps: AgentSessionDeps,
  ) {
    // Only droid has a JSON-RPC client. Every other vendor starts in one-shot
    // rather than discovering it by failing a handshake twice, which would cost
    // two turns and file two protocol errors against a CLI doing nothing wrong.
    if (!adapterFor(this.vendor).supportsRpc) this.mode = 'oneshot';
  }

  /** A roster written before agents could pick a CLI means droid. */
  private get vendor(): CliVendor {
    return this.agent.cli ?? 'droid';
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get sessionId(): string | null {
    return this.droidSessionId;
  }

  /** Started lazily: an agent that never runs a phase never spawns a child. */
  private async ensureStarted(): Promise<void> {
    if (this.mode === 'oneshot') {
      this.oneshot ??= this.buildOneShot();
      return;
    }
    if (this.rpc?.alive) return;

    const client = new SdkSession({
      droidPath: this.deps.cliPath,
      ...this.turnOpts(),
      onPermission: (ask) => this.decide(ask),
      onNotification: (n) => this.currentFolder?.absorb(n),
      onExit: () => this.onRpcExit(),
      onModelWarning: (message) => this.agentLog('log', 'model', { message }),
    });

    try {
      await client.start(this.droidSessionId);
    } catch (e) {
      // A session that never started leaves a child behind when the failure
      // was the handshake rather than the spawn.
      await client.close().catch(() => undefined);
      this.countFailure(e);
      this.noteFallback(`session start failed: ${errorMessage(e)}`);
      this.switchToOneShot();
      return;
    }

    this.rpc = client;
    this.droidSessionId = client.id;
    if (client.pid) {
      this.processRowId = this.deps.tracer.recordProcess({
        runId: this.deps.runId,
        kind: 'droid',
        name: this.agent.name,
        pid: client.pid,
        command: `${this.deps.cliPath} ${client.spawnArgs().join(' ')}`,
      });
    }
    this.persistSession();
  }

  /** What both transports need to describe one turn's settings. */
  private turnOpts() {
    return {
      cwd: this.deps.worktree,
      model: this.agent.model,
      reasoningEffort: this.agent.reasoningEffort,
      restrictTools: this.agent.tools?.length ? this.agent.tools : undefined,
      disabledTools: this.agent.disabledTools?.length ? this.agent.disabledTools : undefined,
      onStderr: (text: string) => this.logStderr(text),
    };
  }

  private buildOneShot(): OneShotClient {
    const client = new OneShotClient({
      vendor: this.vendor,
      cliPath: this.deps.cliPath,
      extraArgs: this.deps.cliExtraArgs,
      ...this.turnOpts(),
    });
    client.adopt(this.droidSessionId);
    return client;
  }

  private switchToOneShot(): void {
    if (this.mode === 'oneshot') return;
    this.mode = 'oneshot';
    this.rpc?.kill();
    this.rpc = null;
    this.oneshot = this.buildOneShot();
    this.deps.onModeChange?.('oneshot');
    this.persistSession();
  }

  private noteFallback(reason: string): void {
    this.agentLog('log', 'fallback to one-shot', {
      reason,
      failures: this.protocolFailures,
    });
  }

  /**
   * One strike against the RPC transport. Strikes are only ever counted here,
   * on the turn that failed: a dying child both rejects the in-flight turn and
   * fires its exit callback, and counting in both places would spend the whole
   * budget on a single death. A child that dies between turns is not a strike —
   * the next turn silently restarts it and nothing was lost.
   *
   * The SDK reports a broken transport as four unrelated classes rather than
   * one wrapper, so they are recognised explicitly; anything else still costs a
   * strike, but is filed as unclassified so a new SDK error class shows up in
   * the trace instead of blending in.
   */
  private countFailure(error: unknown): void {
    this.protocolFailures++;
    if (isTransportFailure(error)) return;
    this.agentLog('log', 'protocol', {
      message: errorMessage(error),
      unclassified: true,
      failures: this.protocolFailures,
    });
  }

  private onRpcExit(): void {
    if (this.processRowId === null) return;
    this.deps.tracer.endProcess(this.processRowId);
    this.processRowId = null;
  }

  private logStderr(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.agentLog('log', 'stderr', { text: trimmed.slice(-2000) });
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
      cli: this.vendor,
      droidSessionId: this.droidSessionId,
      mode: this.mode,
      color: this.agent.color,
    });
  }

  /**
   * Every ask is settled here and traced. Nothing waits for a person: the
   * write boundary is re-checked against git after the phase, which is what
   * makes an in-turn allow safe to give.
   *
   * The returned `PermissionDecision` is all a transport ever sees, which is
   * why ask_user answers ride on the decision rather than beside it — one that
   * reaches the wire without them is replied to as a cancellation and the
   * agent asks again.
   */
  private decide(ask: PermissionAsk): PermissionDecision {
    const outcome = evaluate(ask, {
      worktree: this.deps.worktree,
      writes: this.agent.writes,
      protectedPaths: this.deps.policy.protectedPaths,
    });
    const answers = outcome.decision.outcome === 'allow' ? outcome.decision.answers : undefined;
    this.deps.tracer.event({
      runId: this.deps.runId,
      phaseId: this.currentPhaseId,
      type: 'interrupt',
      name: `${outcome.decision.outcome} (policy)`,
      payload: {
        reason: outcome.reason,
        auto: true,
        method: ask.method,
        ...(outcome.command ? { command: outcome.command } : {}),
        ...(answers ? { answers } : {}),
      },
    });
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
      const result = await this.transportSend(prompt, folder, ctx);
      folder.closeDangling('turn ended before this call reported a result');
      await this.refreshContext();
      return {
        text: result.text,
        usage: toUsageBreakdown(result.usage ?? folder.usage),
        reason: result.reason,
      };
    } finally {
      this.currentFolder = null;
    }
  }

  /**
   * Two protocol failures in a run and the agent drops to one-shot for the
   * rest of it: a flapping transport must not be retried forever.
   */
  private async transportSend(
    prompt: string,
    folder: EventFolder,
    ctx: AgentTurnContext,
  ): Promise<TurnResult> {
    while (this.mode === 'rpc' && this.rpc) {
      try {
        return await this.rpc.send(prompt, this.deps.turnTimeoutMs);
      } catch (e) {
        const message = errorMessage(e);
        this.countFailure(e);
        folder.closeDangling(`transport failed: ${message}`);
        if (this.protocolFailures >= PROTOCOL_FAILURE_LIMIT) {
          this.noteFallback(message);
          this.switchToOneShot();
          break;
        }
        this.noteFallback(`retrying after ${message}`);
        // A restart that cannot come back up has already switched the mode, so
        // the loop condition ends the RPC attempts rather than spinning.
        await this.restart();
      }
    }

    return this.sendOneShot(prompt, ctx.phaseId, folder);
  }

  /** Drop the dead RPC child and start a fresh one for the next attempt. */
  private async restart(): Promise<void> {
    const dead = this.rpc;
    this.rpc = null;
    // The dead session's own child may still be running (a protocol failure is
    // not always process death), and nothing else will reap it once the field
    // is reassigned.
    await dead?.close().catch(() => undefined);
    await this.ensureStarted();
  }

  private async sendOneShot(
    prompt: string,
    phaseId: string,
    folder: EventFolder,
  ): Promise<TurnResult> {
    const oneshot = (this.oneshot ??= this.buildOneShot());
    // A vendor with a stream normaliser gets its mid-turn events folded into
    // real trace rows; one without keeps the single honest span that says
    // there is nothing to show until the turn ends. The normaliser is built
    // per turn: folding can carry state, and sessions share the adapter.
    const streamFactory = adapterFor(this.vendor).stream;
    const spanId = streamFactory
      ? null
      : this.deps.tracer.event({
          runId: this.deps.runId,
          phaseId,
          type: 'tool_call',
          name: `${this.agent.name}: one-shot turn`,
          payload: {
            mode: 'oneshot',
            note: 'mid-turn tool visibility is unavailable for this CLI',
          },
        });
    const normalise = streamFactory?.();
    const result = await oneshot.send(
      prompt,
      this.deps.turnTimeoutMs,
      normalise ? (line) => folder.absorbAll(normalise(line)) : undefined,
    );
    this.droidSessionId = oneshot.id ?? this.droidSessionId;
    this.persistSession();
    if (spanId) this.deps.tracer.endEvent(spanId, { reason: result.reason });
    return result;
  }

  private async refreshContext(): Promise<void> {
    if (this.mode !== 'rpc' || !this.rpc) return;
    const stats = await this.rpc.contextStats();
    if (!stats) return;
    this.deps.tracer.setAgentContext(
      this.deps.runId,
      this.agent.name,
      stats.used ?? 0,
      stats.limit ?? 0,
    );
  }

  async interrupt(): Promise<void> {
    await this.rpc?.interrupt();
  }

  async close(): Promise<void> {
    if (this.processRowId !== null) {
      this.deps.tracer.endProcess(this.processRowId);
      this.processRowId = null;
    }
    await this.rpc?.close();
    await this.oneshot?.close();
  }

  kill(): void {
    this.rpc?.kill();
    this.oneshot?.kill();
  }

  usageIsUnreported(usage: UsageBreakdown): boolean {
    return !usage.reported;
  }

  static emptyUsage(): UsageBreakdown {
    return toUsageBreakdown(null);
  }
}
