/**
 * One long-lived `droid exec` child per agent per run, kept alive across that
 * agent's phases. Correction loops and multi-phase agents reuse the live
 * window: a correction costs one message, a restart costs everything.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { AutonomyLevel, ReasoningEffort } from '@shared/types.js';
import {
  type AvailableModel,
  type ContextStatsResult,
  type DroidNotification,
  type InitializeSessionResult,
  type ListToolsResult,
  type RpcMessage,
  type SessionSettings,
  type TokenUsage,
  request,
  response,
} from './protocol.js';

export interface PermissionAsk {
  method: 'droid.request_permission' | 'droid.ask_user';
  params: Record<string, unknown>;
}

export type PermissionDecision =
  | { outcome: 'allow'; remember?: boolean }
  | { outcome: 'deny'; reason?: string };

export interface DroidClientOptions {
  droidPath: string;
  cwd: string;
  autonomy: AutonomyLevel;
  model: string;
  reasoningEffort: ReasoningEffort;
  restrictTools?: string[];
  disabledTools?: string[];
  /** In-boundary asks auto-approve; the rest surface to the human. */
  onPermission: (ask: PermissionAsk) => Promise<PermissionDecision>;
  onNotification?: (n: DroidNotification) => void;
  onExit?: (code: number | null) => void;
  onStderr?: (text: string) => void;
}

export interface TurnResult {
  /** Final assistant text — what the envelope is parsed from. */
  text: string;
  usage: TokenUsage | null;
  reason: string;
  interrupted: boolean;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class DroidProtocolError extends Error {}

/** A roster entry may decline to pick a model and take droid's own default. */
export const INHERIT_MODEL = 'inherit';

export class DroidClient extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();
  private sessionId: string | null = null;
  private settings: SessionSettings = {};
  private models: AvailableModel[] = [];
  private exited = false;
  private turnCollector: TurnCollector | null = null;

  constructor(private readonly opts: DroidClientOptions) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get id(): string | null {
    return this.sessionId;
  }

  get availableModels(): AvailableModel[] {
    return this.models;
  }

  get activeSettings(): SessionSettings {
    return this.settings;
  }

  get alive(): boolean {
    return !!this.child && !this.exited;
  }

  /**
   * CLI flags do not configure a JSON-RPC session, but --auto is still
   * validated and bounds what the session may ask for.
   */
  spawnArgs(): string[] {
    return [
      'exec',
      '--input-format',
      'stream-jsonrpc',
      '--output-format',
      'stream-jsonrpc',
      '--cwd',
      this.opts.cwd,
      '--auto',
      this.opts.autonomy,
    ];
  }

  async start(existingSessionId?: string | null): Promise<void> {
    const child = spawn(this.opts.droidPath, this.spawnArgs(), {
      cwd: this.opts.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.opts.onStderr?.(chunk.toString()));
    child.on('exit', (code) => {
      this.exited = true;
      for (const [id, p] of this.pending) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new DroidProtocolError(`droid exited (code ${code}) with request ${id} in flight`));
      }
      this.pending.clear();
      // Turn completion is a notification, so a mid-turn exit must fail here.
      this.turnCollector?.abort(new DroidProtocolError(`droid exited (code ${code}) mid-turn`));
      this.opts.onExit?.(code);
    });
    child.on('error', (e) => {
      this.exited = true;
      this.opts.onStderr?.(`spawn error: ${e.message}`);
    });

    const result = (await this.call(
      existingSessionId ? 'droid.load_session' : 'droid.initialize_session',
      existingSessionId
        ? { sessionId: existingSessionId }
        : { cwd: this.opts.cwd, machineId: 'foundry' },
      120_000,
    )) as InitializeSessionResult;

    this.sessionId = result.sessionId;
    this.settings = result.settings ?? {};
    this.models = result.availableModels ?? [];
    const applied = await this.applySettings();
    if (applied.warning) this.emit('model-warning', applied.warning);
  }

  /**
   * Model substitution for RPC mode. A policy-forbidden model is retried
   * without the override so the session survives; the caller learns which model
   * actually took effect.
   */
  async applySettings(): Promise<{ model: string; warning?: string }> {
    if (!this.sessionId) return { model: this.settings.modelId ?? this.opts.model };

    const base: Record<string, unknown> = {
      sessionId: this.sessionId,
      autonomyLevel: this.opts.autonomy,
    };
    if (this.opts.restrictTools?.length) base.restrictToolIds = this.opts.restrictTools;
    if (this.opts.disabledTools?.length) base.disabledToolIds = this.opts.disabledTools;

    const wantsModel = this.opts.model && this.opts.model !== INHERIT_MODEL;
    const withModel = { ...base };
    if (wantsModel) {
      withModel.modelId = this.opts.model;
      if (this.supportsEffort(this.opts.model, this.opts.reasoningEffort)) {
        withModel.reasoningEffort = this.opts.reasoningEffort;
      }
    }

    try {
      await this.call('droid.update_session_settings', withModel, 60_000);
      return { model: this.settings.modelId ?? this.opts.model };
    } catch (e) {
      if (!wantsModel) throw e;
      const message = e instanceof Error ? e.message : String(e);
      await this.call('droid.update_session_settings', base, 60_000);
      const fallback = this.settings.modelId ?? 'droid default';
      return {
        model: fallback,
        warning: `${this.opts.model} was refused (${message}); this session runs on ${fallback}`,
      };
    }
  }

  /**
   * Unknown efforts are dropped rather than sent: a rejected setting would
   * fail the whole session for a preference. Catalog is advisory; droid wins.
   */
  private supportsEffort(modelId: string, effort: ReasoningEffort): boolean {
    const model = this.models.find((m) => m.id === modelId);
    if (!model) return effort !== 'off';
    return model.supportedReasoningEfforts?.includes(effort) ?? false;
  }

  async listTools(): Promise<ListToolsResult['tools']> {
    const result = (await this.call('droid.list_tools', {
      sessionId: this.sessionId ?? undefined,
    })) as ListToolsResult;
    return result.tools ?? [];
  }

  async contextStats(): Promise<ContextStatsResult | null> {
    if (!this.sessionId) return null;
    try {
      return (await this.call('droid.get_context_stats', {
        sessionId: this.sessionId,
      })) as ContextStatsResult;
    } catch {
      return null;
    }
  }

  /**
   * Send the prompt and resolve when droid reports the turn complete.
   * `add_user_message` returns immediately; completion is a notification.
   */
  async send(text: string, timeoutMs: number): Promise<TurnResult> {
    if (!this.sessionId) throw new DroidProtocolError('session not initialised');
    if (!this.alive) throw new DroidProtocolError('droid child is not running');

    const collector = new TurnCollector();
    this.turnCollector = collector;
    const done = collector.promise(timeoutMs);
    await this.call('droid.add_user_message', { sessionId: this.sessionId, text }, 60_000);
    try {
      return await done;
    } finally {
      this.turnCollector = null;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId || !this.alive) return;
    try {
      await this.call('droid.interrupt_session', { sessionId: this.sessionId }, 15_000);
    } catch {
      // Best-effort; kill is the guarantee.
    }
    this.turnCollector?.interrupt();
  }

  async close(): Promise<void> {
    if (this.sessionId && this.alive) {
      try {
        await this.call('droid.close_session', { sessionId: this.sessionId }, 10_000);
      } catch {
        // Session already gone is fine.
      }
    }
    this.child?.stdin?.end();
    this.child?.kill('SIGTERM');
  }

  kill(): void {
    this.child?.kill('SIGKILL');
  }

  private call(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<unknown> {
    const id = `f${this.nextId++}`;
    const frame = request(id, method, params);
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new DroidProtocolError(`${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

      this.pending.set(id, { resolve, reject, timer });

      if (!this.child?.stdin?.writable) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new DroidProtocolError('droid stdin is not writable'));
        return;
      }
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        this.dispatch(JSON.parse(line) as RpcMessage);
      } catch {
        // Skip non-JSON lines.
      }
    }
  }

  private dispatch(msg: RpcMessage): void {
    if (msg.type === 'response') {
      if (msg.id === null) {
        // Null id: droid rejected a frame it could not attribute.
        this.emit('protocol-error', msg.error?.message ?? 'unattributable error');
        return;
      }
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new DroidProtocolError(`${msg.error.message} (${msg.error.code})`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.type === 'request') {
      void this.answerServerRequest(msg.id, msg.method, msg.params ?? {});
      return;
    }

    if (msg.type === 'notification') {
      const n = msg.params?.notification;
      if (!n) return;
      if (n.type === 'settings_updated' && 'settings' in n) {
        this.settings = (n as { settings: SessionSettings }).settings;
      }
      this.turnCollector?.absorb(n);
      this.opts.onNotification?.(n);
    }
  }

  private async answerServerRequest(
    id: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method !== 'droid.request_permission' && method !== 'droid.ask_user') {
      this.write(response(id, {}));
      return;
    }

    const decision = await this.opts.onPermission({
      method,
      params,
    });

    if (method === 'droid.request_permission') {
      this.write(
        response(id, {
          outcome: {
            outcome: decision.outcome,
            ...(decision.outcome === 'deny'
              ? { reason: decision.reason ?? 'denied by policy' }
              : {}),
          },
        }),
      );
      return;
    }

    this.write(response(id, { answer: decision.outcome === 'allow' ? 'yes' : 'no' }));
  }

  private write(frame: Record<string, unknown>): void {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    }
  }
}

/**
 * Folds one turn's notification stream into a result. Only `create_message`
 * carries committed assistant text; deltas feed the live tail.
 */
class TurnCollector {
  private text = '';
  private committed = '';
  private usage: TokenUsage | null = null;
  private settle: ((r: TurnResult) => void) | null = null;
  private fail: ((e: Error) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private interrupted = false;

  promise(timeoutMs: number): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve, reject) => {
      this.settle = resolve;
      this.fail = reject;
      this.timer = setTimeout(() => {
        this.fail?.(new DroidProtocolError(`turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  interrupt(): void {
    this.interrupted = true;
  }

  abort(error: Error): void {
    if (this.timer) clearTimeout(this.timer);
    this.fail?.(error);
    this.settle = null;
    this.fail = null;
  }

  absorb(n: DroidNotification): void {
    switch (n.type) {
      case 'assistant_text_delta':
        this.text += String((n as { textDelta?: string }).textDelta ?? '');
        break;
      case 'create_message': {
        const message = (n as { message?: { role?: string; content?: { type: string; text?: string }[] } })
          .message;
        if (message?.role !== 'assistant') break;
        const joined = (message.content ?? [])
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text as string)
          .join('\n');
        if (joined.trim()) this.committed = joined;
        break;
      }
      case 'session_token_usage_changed':
        this.usage = (n as { tokenUsage?: TokenUsage }).tokenUsage ?? this.usage;
        break;
      case 'agent_turn_completed': {
        const done = n as {
          reason?: string;
          cumulativeTokenUsage?: TokenUsage;
          tokenUsage?: TokenUsage;
        };
        this.usage = done.cumulativeTokenUsage ?? done.tokenUsage ?? this.usage;
        this.finish(done.reason ?? 'completed');
        break;
      }
      default:
        break;
    }
  }

  private finish(reason: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.settle?.({
      text: (this.committed || this.text).trim(),
      usage: this.usage,
      reason,
      interrupted: this.interrupted,
    });
    this.settle = null;
  }
}
