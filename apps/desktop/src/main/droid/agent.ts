/**
 * Adapter boundary: `send(turn) -> events + final text`, identical for JSON-RPC
 * or one-shot. The executor cannot tell which mode is active.
 *
 * A session belongs to one agent for the whole run and starts lazily on that
 * agent's first phase.
 */

import type { AgentDef, AutonomyLevel, UsageBreakdown } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
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

export interface InterruptRequest {
  runId: string;
  phaseId: string | null;
  kind: 'engineer' | 'permission';
  title: string;
  body: string;
  command?: string;
}

export interface AgentSessionDeps {
  droidPath: string;
  runId: string;
  worktree: string;
  autonomy: AutonomyLevel;
  turnTimeoutMs: number;
  tracer: Tracer;
  policy: Omit<PolicyContext, 'autonomy' | 'worktree' | 'writes'>;
  /** Asks the human; resolves to the decision the sheet produced. */
  askHuman: (req: InterruptRequest) => Promise<{ approve: boolean; remember?: boolean }>;
  onModeChange?: (mode: Mode) => void;
  onCommandRemembered?: (command: string) => void;
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
  ) {}

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
      ...this.sharedClientOpts(),
      onPermission: (ask) => this.decide(ask),
      onNotification: (n) => this.currentFolder?.absorb(n),
      onExit: (code) => this.onRpcExit(code),
    });
    client.on('model-warning', (message: string) => {
      this.agentLog('log', 'model substitution', { message });
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
        command: `${this.deps.droidPath} ${client.spawnArgs().join(' ')}`,
      });
    }
    this.persistSession();
  }

  private sharedClientOpts() {
    return {
      droidPath: this.deps.droidPath,
      cwd: this.deps.worktree,
      autonomy: this.deps.autonomy,
      model: this.agent.model,
      reasoningEffort: this.agent.reasoningEffort,
      restrictTools: this.agent.tools?.length ? this.agent.tools : undefined,
      disabledTools: this.agent.disabledTools?.length ? this.agent.disabledTools : undefined,
      onStderr: (text: string) => this.logStderr(text),
    };
  }

  private buildOneShot(): OneShotClient {
    const client = new OneShotClient(this.sharedClientOpts());
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

  private agentLog(
    type: 'log' | 'error',
    suffix: string,
    payload: Record<string, unknown>,
  ): void {
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
      droidSessionId: this.droidSessionId,
      mode: this.mode,
      color: this.agent.color,
    });
  }

  private async decide(ask: PermissionAsk): Promise<PermissionDecision> {
    const outcome = evaluate(ask, {
      autonomy: this.deps.autonomy,
      worktree: this.deps.worktree,
      writes: this.agent.writes,
      protectedPaths: this.deps.policy.protectedPaths,
      allowedCommands: this.deps.policy.allowedCommands,
    });
    if (outcome.decision) {
      this.deps.tracer.event({
        runId: this.deps.runId,
        phaseId: this.currentPhaseId,
        type: 'interrupt',
        name: `${outcome.decision.outcome} (policy)`,
        payload: { reason: outcome.reason, auto: true, method: ask.method },
      });
      return outcome.decision;
    }
    const eventId = this.deps.tracer.event({
      runId: this.deps.runId,
      phaseId: this.currentPhaseId,
      type: 'interrupt',
      name: outcome.title || 'needs input',
      payload: { reason: outcome.reason, auto: false, body: outcome.body, method: ask.method },
    });
    const answer = await this.deps.askHuman({
      runId: this.deps.runId,
      phaseId: this.currentPhaseId,
      kind: 'permission',
      title: outcome.title || 'Approve action',
      body: outcome.body,
      command: outcome.command,
    });
    this.deps.tracer.endEvent(eventId, { answered: answer.approve ? 'approve' : 'reject' });
    if (answer.approve && answer.remember && outcome.command) {
      this.deps.onCommandRemembered?.(outcome.command);
    }
    return answer.approve
      ? { outcome: 'allow' }
      : { outcome: 'deny', reason: 'the engineer declined this action' };
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

    return this.sendOneShot(prompt, ctx.phaseId);
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

  private async sendOneShot(prompt: string, phaseId: string): Promise<TurnResult> {
    const oneshot = (this.oneshot ??= this.buildOneShot());
    const spanId = this.deps.tracer.event({
      runId: this.deps.runId,
      phaseId,
      type: 'tool_call',
      name: `${this.agent.name}: one-shot turn`,
      payload: { mode: 'oneshot', note: 'mid-turn tool visibility is unavailable in fallback mode' },
    });
    const result = await oneshot.send(prompt, this.deps.turnTimeoutMs);
    this.droidSessionId = oneshot.id ?? this.droidSessionId;
    this.persistSession();
    this.deps.tracer.endEvent(spanId, { reason: result.reason });
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
