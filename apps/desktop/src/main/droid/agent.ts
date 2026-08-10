/**
 * Adapter boundary: `send(turn) -> events + final text`, identical for JSON-RPC
 * or one-shot. The executor cannot tell which mode is active.
 *
 * A session belongs to one agent for the whole run and starts lazily on that
 * agent's first phase.
 */

import type { AgentDef, CliVendor, ContextBreakdown, UsageBreakdown } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import { adapterFor } from '../cli/index.js';
import {
  type PermissionAsk,
  type PermissionDecision,
  type TurnOptions,
  type TurnResult,
} from './turn.js';
import { OneShotClient } from './oneshot.js';
import { noteSessionModels, noteSessionTools } from './catalog.js';
import { EventFolder, toUsageBreakdown } from './events.js';
import { evaluate, type PolicyContext } from './permissions.js';
import { SdkSession } from './sdk/session.js';
import { isTransportFailure } from './sdk/errors.js';
import type { ContextStatsResult } from './protocol.js';

export type Mode = 'rpc' | 'oneshot';

export interface AgentTurnContext extends TurnOptions {
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
 * settles with. A kill is a verdict, not a transport flap: the dead child must
 * never be restarted or answered one-shot, or the kill settles as an accepted
 * run.
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
  /** What the transport claims conforms to the requested schema, if anything. */
  structuredOutput: Record<string, unknown> | null;
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
  /** One row per one-shot turn: each turn is its own child process. */
  private readonly oneshotRows = new Map<number, number>();
  private currentFolder: EventFolder | null = null;
  private currentPhaseId: string | null = null;
  private killed = false;

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
    if (this.killed) throw new RunKilledError();
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
      if (this.killed) throw new RunKilledError();
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
    await this.publishDiscovery(client);
    // A kill that landed while this child was still handshaking never saw it:
    // `kill()` only reaches the sessions that existed when it ran.
    if (this.killed) {
      await this.close();
      throw new RunKilledError();
    }
  }

  /**
   * A live session is the only thing that can enumerate droid's tools and the
   * only model list that reflects what the org enables today, so the catalog
   * the roster picker reads is refreshed from it. Discovery is a view: a
   * session that will not answer costs the run nothing.
   */
  private async publishDiscovery(client: SdkSession): Promise<void> {
    noteSessionModels(client.availableModels);
    try {
      const tools = await client.listTools();
      noteSessionTools(
        tools.map(({ id, displayName, description, category, defaultAllowed }) => ({
          id,
          // The SDK reports one id, the llmId, which is the name a roster's
          // allowlist uses; the CLI's internal id is not exposed and not needed.
          llmId: id,
          displayName,
          description,
          category,
          defaultAllowed,
        })),
      );
    } catch {
      // The last known list stays; a refreshed catalog is not worth a failed run.
    }
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
      onSpawn: (pid, command) => this.recordOneShot(pid, command),
      onChildExit: (pid) => this.endOneShot(pid),
    });
    client.adopt(this.droidSessionId);
    return client;
  }

  /** A one-shot child is as killable as an RPC one, so it gets a row too. */
  private recordOneShot(pid: number, command: string): void {
    this.oneshotRows.set(
      pid,
      this.deps.tracer.recordProcess({
        runId: this.deps.runId,
        kind: 'droid',
        name: this.agent.name,
        pid,
        command,
      }),
    );
  }

  private endOneShot(pid: number): void {
    const rowId = this.oneshotRows.get(pid);
    if (rowId === undefined) return;
    this.oneshotRows.delete(pid);
    this.deps.tracer.endProcess(rowId);
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
        structuredOutput: result.structuredOutput,
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
        return await this.rpc.send(prompt, this.deps.turnTimeoutMs, {
          outputFormat: ctx.outputFormat,
        });
      } catch (e) {
        const message = errorMessage(e);
        // A killed child rejects its turn like any dead one. Recovering here
        // would hand the operator's kill to the one-shot fallback, which can
        // finish the phase and settle the run accepted.
        if (this.killed) {
          folder.closeDangling(KILLED_DETAIL);
          throw new RunKilledError();
        }
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
    if (this.killed) throw new RunKilledError();
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
    // A kill that landed mid-turn leaves whatever the child printed first; it
    // is not an answer the phase may be settled on.
    if (this.killed) throw new RunKilledError();
    this.droidSessionId = oneshot.id ?? this.droidSessionId;
    this.persistSession();
    if (spanId) this.deps.tracer.endEvent(spanId, { reason: result.reason });
    return result;
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
   * How full this agent's context is, or `null` when there is nothing to
   * measure. A one-shot session has no context to report: every turn is its
   * own child, so occupancy is not a property it has.
   */
  async contextStats(): Promise<ContextStatsResult | null> {
    if (this.mode !== 'rpc' || !this.rpc) return null;
    return this.rpc.contextStats();
  }

  /**
   * What is occupying this agent's context, for the Inspector's disclosure.
   * `null` for a one-shot session (no conversation to account for) and for a
   * transport that did not answer — a breakdown is a view, never a run input.
   */
  async contextBreakdown(): Promise<ContextBreakdown | null> {
    if (this.mode !== 'rpc' || !this.rpc) return null;
    return this.rpc.contextBreakdown();
  }

  /**
   * Compacts this agent's conversation and continues on the successor session,
   * which is persisted so a resumed run picks up the one with room in it.
   *
   * Only ever called between phases: the SDK refuses a replacement with a
   * stream open, and the successor has to be in place before the next turn is
   * composed. Failure is survivable by design — the next turn then hits the
   * context wall as it would have anyway, so the reason is traced and the run
   * carries on.
   */
  async compact(before: ContextStatsResult): Promise<{ removedCount: number } | null> {
    if (this.mode !== 'rpc' || !this.rpc) return null;
    try {
      const outcome = await this.rpc.compact();
      if (!outcome) return null;
      this.droidSessionId = this.rpc.id;
      this.persistSession();
      const after = await this.rpc.contextStats();
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

  async interrupt(): Promise<void> {
    await this.rpc?.interrupt();
  }

  async close(): Promise<void> {
    if (this.processRowId !== null) {
      this.deps.tracer.endProcess(this.processRowId);
      this.processRowId = null;
    }
    for (const rowId of this.oneshotRows.values()) this.deps.tracer.endProcess(rowId);
    this.oneshotRows.clear();
    await this.rpc?.close();
    await this.oneshot?.close();
  }

  kill(): void {
    this.killed = true;
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
