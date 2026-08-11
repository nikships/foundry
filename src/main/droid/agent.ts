/**
 * Adapter boundary: `send(turn) -> events + final text`, identical for JSON-RPC
 * or one-shot. The executor cannot tell which mode is active.
 *
 * A session belongs to one agent for the whole run and starts lazily on that
 * agent's first phase.
 */

import type { AgentDef, CliVendor, ContextBreakdown, UsageBreakdown } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import type { Envelope } from '../engine/envelopes.js';
import type { Snapshot } from '../engine/boundary.js';
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
import { DaemonSession, getDaemonManager, type DaemonEnsureResult } from './sdk/daemon.js';
import type { TransportSession, TransportSessionOptions } from './sdk/transport.js';
import { isTransportFailure } from './sdk/errors.js';
import type { ContextStatsResult } from './protocol.js';

export type Mode = 'daemon' | 'rpc' | 'oneshot';

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

/** Outcome of opening a daemon-backed TransportSession (production or test). */
export type OpenDaemonResult =
  { ok: true; session: TransportSession } | { ok: false; reason: string };

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
  /**
   * Validated envelopes for this run (same Map the engine mutates). The foundry
   * MCP `read_phase_context` tool reads it; absent means an empty chain.
   */
  envelopes?: ReadonlyMap<string, Envelope>;
  /**
   * Settings preference. Default `daemon`. `subprocess` forces SdkSession and
   * never touches DaemonManager.
   */
  transport?: 'daemon' | 'subprocess';
  /** Preferred daemon port (37600–37699). Used only when transport is daemon. */
  daemonPort?: number;
  /**
   * Test seam: open a daemon TransportSession without a real DaemonManager.
   * Production leaves this unset.
   */
  openDaemonSession?: () => Promise<OpenDaemonResult>;
  /**
   * Test seam: open a subprocess SdkSession stand-in. Production leaves this
   * unset and constructs SdkSession directly.
   */
  openRpcSession?: () => Promise<TransportSession>;
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

/**
 * Snapshot paths are worktree-relative; the CLI may report the same file as a
 * cwd-relative or absolute path. Compare after stripping a worktree prefix.
 */
function sameWorktreePath(snapshotPath: string, rewindPath: string, worktree: string): boolean {
  const left = stripWorktreePrefix(snapshotPath, worktree);
  const right = stripWorktreePrefix(rewindPath, worktree);
  return left === right;
}

function stripWorktreePrefix(path: string, worktree: string): string {
  const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const root = worktree.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalised === root) return '';
  if (normalised.startsWith(`${root}/`)) return normalised.slice(root.length + 1);
  return normalised;
}

export class AgentSession {
  private rpc: TransportSession | null = null;
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
  /** Daemon child is recorded once for the whole app process, not per agent. */
  private daemonProcessRecorded = false;

  constructor(
    private readonly agent: AgentDef,
    private readonly deps: AgentSessionDeps,
  ) {
    // Only droid has a JSON-RPC / daemon client. Every other vendor starts in
    // one-shot rather than discovering it by failing a handshake twice.
    if (!adapterFor(this.vendor).supportsRpc) {
      this.mode = 'oneshot';
    } else if ((this.deps.transport ?? 'daemon') === 'subprocess') {
      this.mode = 'rpc';
    } else {
      this.mode = 'daemon';
    }
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

  /** Daemon and subprocess SdkSession both expose a live conversation. */
  private get isSdkMode(): boolean {
    return this.mode === 'daemon' || this.mode === 'rpc';
  }

  /**
   * Last user-message id on the live SDK session. One-shot has no message id
   * stream, so this is always null outside daemon/rpc.
   */
  get lastUserMessageId(): string | null {
    if (!this.isSdkMode || !this.rpc) return null;
    return this.rpc.lastUserMessageId;
  }

  /** Rewind needs a live SDK session; one-shot never qualifies. */
  get canRewind(): boolean {
    return this.isSdkMode && !!this.rpc?.alive;
  }

  /** Started lazily: an agent that never runs a phase never spawns a child. */
  private async ensureStarted(): Promise<void> {
    if (this.killed) throw new RunKilledError();
    if (this.mode === 'oneshot') {
      this.oneshot ??= this.buildOneShot();
      return;
    }
    if (this.rpc?.alive) return;

    if (this.mode === 'daemon') {
      const opened = await this.openDaemon();
      if (opened) return;
      // openDaemon already fell back to rpc with a traced reason.
    }

    await this.startRpcSession();
  }

  /**
   * Try the daemon path. Returns true when a live DaemonSession is installed.
   * Any failure falls back to subprocess with a traced warning and leaves
   * mode='rpc' so the caller can open SdkSession — a run never dies because
   * the daemon did not come up.
   */
  private async openDaemon(): Promise<boolean> {
    try {
      const opened = this.deps.openDaemonSession
        ? await this.deps.openDaemonSession()
        : await this.openDaemonProduction();
      if (!opened.ok) {
        this.fallbackToSubprocess(opened.reason);
        return false;
      }
      const client = opened.session;
      try {
        await client.start(this.droidSessionId);
      } catch (e) {
        await client.close().catch(() => undefined);
        if (this.killed) throw new RunKilledError();
        this.fallbackToSubprocess(`daemon session start failed: ${errorMessage(e)}`);
        return false;
      }
      this.rpc = client;
      this.droidSessionId = client.id;
      // No per-session child pid: DaemonManager records the daemon once.
      this.setMode('daemon');
      this.persistSession();
      await this.publishDiscovery(client);
      if (this.killed) {
        await this.close();
        throw new RunKilledError();
      }
      return true;
    } catch (e) {
      if (e instanceof RunKilledError) throw e;
      this.fallbackToSubprocess(`daemon unavailable: ${errorMessage(e)}`);
      return false;
    }
  }

  private async openDaemonProduction(): Promise<OpenDaemonResult> {
    // Restrictive allowlists need listTools to compute the disabled complement.
    // The daemon high-level API has no builtin listTools (only MCP listTools),
    // so a roster with restrictTools must fail closed to subprocess rather than
    // silently run unenforced.
    if (this.agent.tools?.length) {
      return {
        ok: false,
        reason: 'daemon cannot enforce restrictTools (no listTools)',
      };
    }

    const manager = getDaemonManager({
      droidPath: this.deps.cliPath,
      port: this.deps.daemonPort ?? 37_643,
      onProcess: (info) => {
        if (this.daemonProcessRecorded) return;
        this.daemonProcessRecorded = true;
        this.deps.tracer.recordProcess({
          runId: this.deps.runId,
          kind: 'droid',
          name: 'daemon',
          pid: info.pid,
          command: info.command,
        });
      },
    });

    const ensured: DaemonEnsureResult = await manager.ensure();
    if (!ensured.ok) {
      return { ok: false, reason: `daemon ${ensured.reason}: ${ensured.detail}` };
    }
    const sessions = ensured.droid.sessions;
    if (!sessions) {
      return { ok: false, reason: 'daemon connection has no sessions facade' };
    }
    // Double-check: a future facade that gains listTools can serve restricted
    // rosters; until then the early return above already caught them. If a
    // restricted roster somehow reached here without listTools, still fail closed.
    if (this.agent.tools?.length && !sessions.listTools) {
      return {
        ok: false,
        reason: 'daemon cannot enforce restrictTools (no listTools)',
      };
    }

    return {
      ok: true,
      session: new DaemonSession({
        sessions,
        ...this.transportOpts(),
        foundryMcp: this.foundryMcpOpts(),
      }),
    };
  }

  private async startRpcSession(): Promise<void> {
    const client = this.deps.openRpcSession
      ? await this.deps.openRpcSession()
      : new SdkSession({
          droidPath: this.deps.cliPath,
          ...this.transportOpts(),
          onExit: () => this.onRpcExit(),
          foundryMcp: this.foundryMcpOpts(),
        });

    try {
      await client.start(this.droidSessionId);
    } catch (e) {
      // A session that never started leaves a child behind when the failure
      // was the handshake rather than the spawn.
      await client.close().catch(() => undefined);
      if (this.killed) throw new RunKilledError();
      this.countFailure(e);
      this.noteOneShotFallback(`session start failed: ${errorMessage(e)}`);
      this.switchToOneShot();
      return;
    }

    this.rpc = client;
    this.droidSessionId = client.id;
    this.setMode('rpc');
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

  private transportOpts(): TransportSessionOptions {
    return {
      runId: this.deps.runId,
      ...this.turnOpts(),
      onPermission: (ask) => this.decide(ask),
      onNotification: (n) => this.currentFolder?.absorb(n),
      onModelWarning: (message) => this.agentLog('log', 'model', { message }),
    };
  }

  private foundryMcpOpts() {
    return {
      runId: this.deps.runId,
      agentName: this.agent.name,
      phaseId: () => this.currentPhaseId,
      envelopes: () => this.deps.envelopes ?? new Map(),
      tracer: this.deps.tracer,
    };
  }

  /**
   * A live session is the only thing that can enumerate droid's tools and the
   * only model list that reflects what the org enables today, so the catalog
   * the roster picker reads is refreshed from it. Discovery is a view: a
   * session that will not answer costs the run nothing.
   */
  private async publishDiscovery(client: TransportSession): Promise<void> {
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
      runId: this.deps.runId,
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
    this.rpc?.kill();
    this.rpc = null;
    this.oneshot = this.buildOneShot();
    this.setMode('oneshot');
    this.persistSession();
  }

  /**
   * Daemon path is unavailable (start/auth/allowlist). Mode becomes rpc so the
   * next ensureStarted opens SdkSession; the run continues.
   */
  private fallbackToSubprocess(reason: string): void {
    if (this.mode === 'rpc' || this.mode === 'oneshot') return;
    this.rpc = null;
    this.agentLog('log', `fallback to subprocess: ${reason}`, {
      reason,
      failures: this.protocolFailures,
    });
    this.setMode('rpc');
    this.persistSession();
  }

  /**
   * A daemon-mode protocol strike: drop the daemon session and open a
   * subprocess SdkSession for the retry. Counts as one strike already via
   * countFailure; does not itself increment.
   */
  private async fallDaemonToRpc(reason: string): Promise<void> {
    const dead = this.rpc;
    this.rpc = null;
    await dead?.close().catch(() => undefined);
    this.agentLog('log', `fallback to subprocess: ${reason}`, {
      reason,
      failures: this.protocolFailures,
    });
    this.setMode('rpc');
    this.persistSession();
    await this.ensureStarted();
  }

  /** Notify only when the mode actually changes — avoids duplicate rpc events. */
  private setMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.deps.onModeChange?.(mode);
  }

  private noteOneShotFallback(reason: string): void {
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
   * Protocol-failure ladder across daemon + rpc:
   *   daemon strike → rpc (same turn retries on subprocess)
   *   two total strikes → oneshot for the rest of the run
   * A flapping transport must not be retried forever.
   */
  private async transportSend(
    prompt: string,
    folder: EventFolder,
    ctx: AgentTurnContext,
  ): Promise<TurnResult> {
    while (this.isSdkMode && this.rpc) {
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
          this.noteOneShotFallback(message);
          this.switchToOneShot();
          break;
        }
        if (this.mode === 'daemon') {
          // One daemon strike drops to subprocess; the counter carries over.
          await this.fallDaemonToRpc(message);
          continue;
        }
        this.noteOneShotFallback(`retrying after ${message}`);
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
    if (!this.isSdkMode || !this.rpc) return null;
    return this.rpc.contextStats();
  }

  /**
   * What is occupying this agent's context, for the Inspector's disclosure.
   * `null` for a one-shot session (no conversation to account for) and for a
   * transport that did not answer — a breakdown is a view, never a run input.
   */
  async contextBreakdown(): Promise<ContextBreakdown | null> {
    if (!this.isSdkMode || !this.rpc) return null;
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
    if (!this.isSdkMode || !this.rpc) return null;
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

  /**
   * Rewind the live SDK session to `messageId`, restoring the phase-start files
   * the snapshot still knows about, and continue on the successor. Same
   * swap-and-persist mechanics as compaction.
   *
   * Returns null when rewind is impossible (one-shot / no session / no
   * messageId) or when the CLI refuses — the caller then falls back to an
   * append-style correction. A failure here must never fail the phase.
   */
  async rewind(input: { messageId: string; snapshot: Snapshot }): Promise<{
    restoredCount: number;
    deletedCount: number;
    failedRestoreCount: number;
    failedDeleteCount: number;
  } | null> {
    if (!this.canRewind || !this.rpc) return null;
    const messageId = input.messageId.trim();
    if (!messageId) return null;
    try {
      const info = await this.rpc.getRewindInfo(messageId);
      if (!info) return null;
      // Match on path only: the CLI's contentHash/size are what rewind accepts.
      const filesToRestore = info.availableFiles.filter((file) =>
        input.snapshot.files.some((snap) =>
          sameWorktreePath(snap.path, file.filePath, this.deps.worktree),
        ),
      );
      const filesToDelete = info.createdFiles.map((file) => ({
        filePath: file.filePath,
      }));
      const outcome = await this.rpc.rewind({
        messageId,
        filesToRestore,
        filesToDelete,
        forkTitle: `foundry:${this.agent.name}:correction`,
      });
      if (!outcome) return null;
      this.droidSessionId = this.rpc.id;
      this.persistSession();
      return outcome;
    } catch (e) {
      this.agentLog('log', 'rewind failed', { message: errorMessage(e) });
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
