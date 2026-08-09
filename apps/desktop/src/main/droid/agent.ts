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
import {
  DroidClient,
  type PermissionAsk,
  type PermissionDecision,
  type TurnResult,
} from './client.js';
import { OneShotClient } from './oneshot.js';
import { EventFolder, toUsageBreakdown } from './events.js';
import { evaluate, type PolicyContext } from './permissions.js';

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
  private rpc: DroidClient | null = null;
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

    const client = new DroidClient({
      droidPath: this.deps.cliPath,
      ...this.turnOpts(),
      onPermission: async (ask) => this.decide(ask),
      onNotification: (n) => this.currentFolder?.absorb(n),
      onExit: (code) => this.onRpcExit(code),
    });
    client.on('model-warning', (message: string) => {
      this.agentLog('log', 'model', { message });
    });
    client.on('protocol-error', (message: string) => {
      this.protocolFailures++;
      this.agentLog('error', 'protocol', { message, failures: this.protocolFailures });
    });

    try {
      await client.start(this.droidSessionId);
    } catch (e) {
      this.protocolFailures++;
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

  private onRpcExit(code: number | null): void {
    if (this.processRowId !== null) {
      this.deps.tracer.endProcess(this.processRowId);
      this.processRowId = null;
    }
    if (code !== 0 && code !== null) this.protocolFailures++;
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
   */
  private decide(ask: PermissionAsk): PermissionDecision {
    const outcome = evaluate(ask, {
      worktree: this.deps.worktree,
      writes: this.agent.writes,
      protectedPaths: this.deps.policy.protectedPaths,
    });
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
        ...(outcome.answers ? { answers: outcome.answers } : {}),
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
    if (this.mode === 'rpc' && this.rpc) {
      try {
        return await this.rpc.send(prompt, this.deps.turnTimeoutMs);
      } catch (e) {
        const message = errorMessage(e);
        this.protocolFailures++;
        folder.closeDangling(`transport failed: ${message}`);
        if (this.protocolFailures < PROTOCOL_FAILURE_LIMIT) {
          this.noteFallback(`retrying after ${message}`);
          const retried = await this.restartAndSend(prompt);
          if (retried) return retried;
        } else {
          this.noteFallback(message);
          this.switchToOneShot();
        }
      }
    }

    return this.sendOneShot(prompt, ctx.phaseId, folder);
  }

  /** Drop the dead RPC child, restart, and attempt the turn once more. */
  private async restartAndSend(prompt: string): Promise<TurnResult | null> {
    this.rpc = null;
    await this.ensureStarted();
    // ensureStarted repopulates this.rpc; control-flow analysis cannot see that.
    const rpc = this.rpc as DroidClient | null;
    if (this.mode !== 'rpc' || !rpc) return null;
    return rpc.send(prompt, this.deps.turnTimeoutMs);
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
