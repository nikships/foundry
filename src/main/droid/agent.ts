/**
 * Adapter boundary: `send(turn) -> events + final text` over the droid daemon.
 *
 * A session belongs to one agent for the whole run and starts lazily on that
 * agent's first phase.
 */

import type {
  AgentDef,
  CliVendor,
  ContextBreakdown,
  UsageBreakdown,
  UserMcpServer,
} from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import type { Envelope } from '../engine/envelopes.js';
import type { Snapshot } from '../engine/boundary.js';
import {
  type PermissionAsk,
  type PermissionDecision,
  type TurnOptions,
  type TurnResult,
} from './turn.js';
import { noteSessionModels, noteSessionTools } from './catalog.js';
import { EventFolder, toUsageBreakdown } from './events.js';
import { evaluate, type PolicyContext } from './permissions.js';
import { getDaemonManager, type DaemonEnsureResult } from './sdk/daemon.js';
import { DaemonSession, type DaemonSessionsFacade } from './sdk/daemon-session.js';
import type { TransportSession, TransportSessionOptions } from './sdk/transport.js';
import type { ContextStatsResult } from './protocol.js';

/**
 * The only transport an agent run uses.
 *
 * This is deliberately a one-member union rather than a removed concept: the
 * trace, the run row, and the renderer all record which mode a run used, and
 * keeping the field makes the guarantee legible instead of implicit.
 *
 * Foundry used to degrade daemon → subprocess → one-shot whenever the daemon
 * could not enforce some policy. That was worse than it sounds: only the
 * daemon and subprocess transports consult `permissions.ts`, so a run that
 * reached one-shot silently swapped Foundry's write-boundary policy for the
 * CLI's coarser `--auto` gate. A quiet downgrade of the security model is not
 * a fallback, so there is no longer anything to fall back to.
 */
export type Mode = 'daemon';

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

/** Outcome of reaching the daemon and getting a facade to open sessions on. */
export type OpenDaemonResult =
  { ok: true; sessions: DaemonSessionsFacade } | { ok: false; reason: string };

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
  /** Preferred daemon port (37600–37699). */
  daemonPort?: number;
  userMcpServers?: UserMcpServer[];
  /**
   * Test seam: supply the daemon's session facade instead of connecting to a
   * real `droid daemon`. The session built on top of it is the production
   * `DaemonSession` with the production permission wiring, so a test exercises
   * the real transport rather than a stand-in for it. Production leaves this
   * unset.
   */
  openDaemonSessions?: () => Promise<OpenDaemonResult>;
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
  private readonly mode: Mode = 'daemon';
  private droidSessionId: string | null = null;
  private processRowId: number | null = null;
  private currentFolder: EventFolder | null = null;
  private currentPhaseId: string | null = null;
  private killed = false;
  /** Daemon child is recorded once for the whole app process, not per agent. */
  private daemonProcessRecorded = false;

  constructor(
    private readonly agent: AgentDef,
    private readonly deps: AgentSessionDeps,
  ) {}

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

  /** Last user-message id on the live daemon session, if one is open yet. */
  get lastUserMessageId(): string | null {
    return this.rpc?.lastUserMessageId ?? null;
  }

  /** Rewind needs a live session, which only exists once a turn has opened one. */
  get canRewind(): boolean {
    return !!this.rpc?.alive;
  }

  /**
   * The operator's own MCP servers.
   *
   * Attached in-process at session create, never by writing the host's
   * `~/.factory/mcp.json`. Servers the operator disabled in Settings are
   * dropped here rather than handed over and ignored.
   */
  private selectedUserMcpServers(): UserMcpServer[] | undefined {
    const kept = (this.deps.userMcpServers ?? []).filter((server) => !server.disabled);
    return kept.length ? kept : undefined;
  }

  /** Started lazily: an agent that never runs a phase never spawns a child. */
  private async ensureStarted(): Promise<void> {
    if (this.killed) throw new RunKilledError();
    if (this.rpc?.alive) return;
    await this.openDaemon();
  }

  /**
   * Open the daemon session, or fail the turn.
   *
   * There is deliberately no fallback. The alternatives were a subprocess or a
   * one-shot child, and one-shot does not consult `permissions.ts` at all — so
   * "keep the run alive" meant "finish the run under a weaker policy than the
   * operator configured, without telling them". A daemon that cannot come up is
   * an environment fault worth surfacing, not something to paper over.
   */
  private async openDaemon(): Promise<void> {
    let opened: OpenDaemonResult;
    try {
      opened = this.deps.openDaemonSessions
        ? await this.deps.openDaemonSessions()
        : await this.connectDaemon();
    } catch (e) {
      if (e instanceof RunKilledError) throw e;
      throw new Error(`daemon unavailable: ${errorMessage(e)}`);
    }
    if (!opened.ok) throw new Error(`daemon unavailable: ${opened.reason}`);

    const client: TransportSession = new DaemonSession({
      sessions: opened.sessions,
      ...this.transportOpts(),
      foundryMcp: this.foundryMcpOpts(),
    });
    try {
      await client.start(this.droidSessionId);
    } catch (e) {
      await client.close().catch(() => undefined);
      if (this.killed) throw new RunKilledError();
      throw new Error(`daemon session start failed: ${errorMessage(e)}`);
    }

    this.rpc = client;
    this.droidSessionId = client.id;
    // No per-session child pid: DaemonManager records the daemon once.
    this.persistSession();
    await this.publishDiscovery(client);
    if (this.killed) {
      await this.close();
      throw new RunKilledError();
    }
  }

  private async connectDaemon(): Promise<OpenDaemonResult> {
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
      return { ok: false, reason: `${ensured.reason}: ${ensured.detail}` };
    }
    const sessions = ensured.droid.sessions;
    if (!sessions) {
      return { ok: false, reason: 'daemon connection has no sessions facade' };
    }

    return { ok: true, sessions };
  }

  private transportOpts(): TransportSessionOptions {
    return {
      runId: this.deps.runId,
      ...this.turnOpts(),
      userMcpServers: this.selectedUserMcpServers(),
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
      onStderr: (text: string) => this.logStderr(text),
    };
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
      const result = await this.transportSend(prompt, folder, ctx.outputFormat);
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
   * Send one turn on the daemon session.
   *
   * A transport failure fails the turn. It used to demote the session and retry
   * on a weaker transport, which meant an operator could not tell a healthy run
   * from one that had quietly lost its permission policy; the engine's own
   * retry//gate machinery is the right place to decide what a failed turn means.
   */
  private async transportSend(
    prompt: string,
    folder: EventFolder,
    outputFormat: AgentTurnContext['outputFormat'],
  ): Promise<TurnResult> {
    const client = this.rpc;
    if (!client) throw new Error('daemon session is not open');
    try {
      return await client.send(prompt, this.deps.turnTimeoutMs, { outputFormat });
    } catch (e) {
      if (this.killed) {
        folder.closeDangling(KILLED_DETAIL);
        throw new RunKilledError();
      }
      const message = errorMessage(e);
      folder.closeDangling(`transport failed: ${message}`);
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
  async contextStats(): Promise<ContextStatsResult | null> {
    if (!this.rpc) return null;
    return this.rpc.contextStats();
  }

  /**
   * What is occupying this agent's context, for the Inspector's disclosure.
   * `null` before a session exists, and when the daemon does not answer — a
   * breakdown is a view, never a run input.
   */
  async contextBreakdown(): Promise<ContextBreakdown | null> {
    if (!this.rpc) return null;
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
    if (!this.rpc) return null;
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
   * Rewind the live session to `messageId`, restoring the phase-start files
   * the snapshot still knows about, and continue on the successor. Same
   * swap-and-persist mechanics as compaction.
   *
   * Returns null when rewind is impossible (no session yet, or no messageId)
   * or when the daemon refuses — the caller then falls back to an
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
    await this.rpc?.close();
  }

  kill(): void {
    this.killed = true;
    this.rpc?.kill();
  }

  usageIsUnreported(usage: UsageBreakdown): boolean {
    return !usage.reported;
  }

  static emptyUsage(): UsageBreakdown {
    return toUsageBreakdown(null);
  }
}
