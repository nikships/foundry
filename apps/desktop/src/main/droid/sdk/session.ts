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
  AutonomyLevel,
  ProcessExitError,
  ProcessTransport,
  createSession,
  resumeSession,
  type DroidResultMessage,
  type DroidSession,
  type StringFramedDroidClientTransport,
} from '@factory/droid-sdk/node';
import type { ReasoningEffort } from '@shared/types.js';
import { DroidProtocolError, INHERIT_MODEL, type TurnResult } from '../client.js';
import {
  AUTONOMY_LEVEL,
  type AvailableModel,
  type ContextStatsResult,
  type DroidNotification,
  type TokenUsage,
} from '../protocol.js';
import { spawnEnv } from '../../system/env.js';
import { SniffingTransport } from './sniffing-transport.js';

export interface SdkSessionOptions {
  droidPath: string;
  cwd: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Test seam: an in-memory transport replaces the child process entirely. */
  transport?: StringFramedDroidClientTransport;
  onNotification?: (n: DroidNotification) => void;
  onExit?: (code: number | null) => void;
  onStderr?: (text: string) => void;
}

/**
 * The one level Foundry runs at, pinned to the protocol constant so the argv
 * flag and the session setting cannot drift apart.
 */
const AUTONOMY = AutonomyLevel.High satisfies typeof AUTONOMY_LEVEL;

/** What `droid.get_context_breakdown` answers; no SDK method exposes it. */
export interface ContextBreakdown {
  modelId: string;
  modelDisplayName: string;
  contextBudget: number;
  usedTokens: number;
  freeTokens: number;
  lastCallCompactionTokens?: number;
  categories: { name: string; tokens: number; colorKey: string }[];
  skills: { name: string; location: string; tokens: number }[];
  mcpServers: { name: string; toolCount: number; tokens: number }[];
  droids: { name: string; location: string; tokens: number }[];
}

export class SdkSession {
  private session: DroidSession | null = null;
  private sniffer: SniffingTransport | null = null;
  private owned: ProcessTransport | null = null;
  private child: ChildProcess | null = null;
  private collector: TurnCollector | null = null;
  private exited = false;
  private exitReported = false;

  constructor(private readonly opts: SdkSessionOptions) {}

  get id(): string | null {
    return this.session?.id ?? null;
  }

  get alive(): boolean {
    return !!this.session && !this.exited;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** droid's own model list for this session, sniffed off the init response. */
  get availableModels(): AvailableModel[] {
    return this.sniffer?.availableModels ?? [];
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

    const shared = { transport: sniffer, execArgs: ['--auto', AUTONOMY_LEVEL] };
    // `autonomyLevel` is stated on every create and re-stated after every
    // resume: omitting it happens to default to high, and load_session carries
    // no settings at all, so neither path may be left to chance.
    this.session = existingSessionId
      ? await resumeSession(existingSessionId, shared)
      : await createSession({
          ...shared,
          cwd: this.opts.cwd,
          machineId: 'foundry',
          autonomyLevel: AUTONOMY,
          ...(this.wantsModel() ? { modelId: this.opts.model } : {}),
        });

    this.session.onNotification((envelope) => this.onEnvelope(envelope));
    sniffer.markSubscribed();

    if (existingSessionId) {
      await this.adoptResumedSession(existingSessionId);
    }
  }

  /**
   * Send the prompt and resolve when droid reports the turn complete.
   * The SDK's stream ends on a terminal `result` message; a turn that failed
   * arrives as one of those too, with `success: false`, so the result is
   * inspected rather than trusted.
   */
  async send(text: string, timeoutMs: number): Promise<TurnResult> {
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
      for await (const message of session.stream(text, { abortSignal: controller.signal })) {
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
    if (!result.success && !result.interrupted) {
      // An unknown or forbidden model does not fail at init or at settings
      // time — it fails here, as a non-throwing result with an empty text.
      throw new DroidProtocolError(result.error?.message ?? `turn failed: ${result.subtype}`);
    }

    return {
      text: (result.text || collector.text).trim(),
      usage: (result.tokenUsage as TokenUsage | null) ?? collector.usage,
      reason: collector.reason ?? (result.interrupted ? 'cancelled' : 'completed'),
      interrupted: result.interrupted,
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

  /** Diagnostic only: a `null` here must never block a run. */
  async contextBreakdown(): Promise<ContextBreakdown | null> {
    if (!this.session || !this.sniffer) return null;
    return this.sniffer.request<ContextBreakdown>('droid.get_context_breakdown');
  }

  async close(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) {
      try {
        await session.close();
      } catch {
        // A session whose child already died is closed enough.
      }
    } else if (this.owned) {
      await this.owned.close().catch(() => undefined);
    }
    this.exited = true;
  }

  kill(): void {
    this.child?.kill('SIGKILL');
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
  private async adoptResumedSession(sessionId: string): Promise<void> {
    const sessionCwd = this.session?.cwd;
    if (sessionCwd && resolvePath(sessionCwd) !== resolvePath(this.opts.cwd)) {
      await this.close();
      throw new DroidProtocolError(
        `session ${sessionId} runs in ${sessionCwd}, not this run's worktree ${this.opts.cwd}`,
      );
    }

    // load_session carries no settings, so everything the roster demands has
    // to be re-stated here — autonomy included.
    await this.session?.updateSettings({
      autonomyLevel: AUTONOMY,
      ...(this.wantsModel() ? { modelId: this.opts.model } : {}),
    });
  }

  /** A roster entry may decline to pick a model and take droid's own default. */
  private wantsModel(): boolean {
    return !!this.opts.model && this.opts.model !== INHERIT_MODEL;
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
    this.collector?.absorb(notification);
    this.opts.onNotification?.(notification);
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

/**
 * Per-turn facts the SDK's own result does not carry: the committed assistant
 * text (which survives an error turn where `result.text` empties) and droid's
 * raw completion reason, which the trace records rather than the SDK subtype.
 */
class TurnCollector {
  private committed = '';
  private lastUsage: TokenUsage | null = null;
  private lastReason: string | null = null;

  get text(): string {
    return this.committed;
  }

  get usage(): TokenUsage | null {
    return this.lastUsage;
  }

  get reason(): string | null {
    return this.lastReason;
  }

  absorb(n: DroidNotification): void {
    switch (n.type) {
      case 'create_message': {
        const message = (
          n as { message?: { role?: string; content?: { type: string; text?: string }[] } }
        ).message;
        if (message?.role !== 'assistant') return;
        const joined = (message.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('\n');
        if (joined.trim()) this.committed = joined;
        return;
      }
      case 'session_token_usage_changed':
        this.lastUsage = (n as { tokenUsage?: TokenUsage }).tokenUsage ?? this.lastUsage;
        return;
      case 'agent_turn_completed': {
        const done = n as {
          reason?: string;
          tokenUsage?: TokenUsage;
          cumulativeTokenUsage?: TokenUsage;
        };
        this.lastUsage = done.cumulativeTokenUsage ?? done.tokenUsage ?? this.lastUsage;
        this.lastReason = done.reason ?? 'completed';
        return;
      }
      default:
        return;
    }
  }
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

/** ProcessTransport wants a defined-valued env; `process.env` does not have one. */
function stringEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(spawnEnv())) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
