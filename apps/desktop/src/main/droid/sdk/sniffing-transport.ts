/**
 * A transport decorator that watches the JSON-RPC frames going past, because
 * three things Foundry needs are invisible from the SDK's high-level session:
 *
 *  1. `availableModels` exists only on the `initialize_session` response
 *     envelope, which `createSession()` discards — it is the only way to know
 *     an unknown model id before spending a turn on it.
 *  2. The CLI emits ~5 notifications before `createSession()` resolves, which
 *     is the earliest a caller can subscribe; without a tap here they never
 *     reach the trace and stream.jsonl starts mid-conversation.
 *  3. `get_context_breakdown` is a real protocol method with no method on
 *     `DroidSession`. Injecting the request here (and swallowing its answer,
 *     so the SDK's client never sees a response id it did not issue) reaches
 *     it without touching the session's private client.
 */

import { randomUUID } from 'node:crypto';
import type { StringFramedDroidClientTransport } from '@factory/droid-sdk/node';
import {
  FACTORY_API_VERSION,
  FACTORY_PROTOCOL_VERSION,
  type AvailableModel,
  type DroidNotification,
  type SessionSettings,
} from '../protocol.js';

/** The part of an init/load response the high-level API throws away. */
export interface SniffedSessionInit {
  sessionId?: string;
  settings?: SessionSettings;
  availableModels?: AvailableModel[];
}

export interface SniffingTransportHooks {
  /** Notifications seen before the session had anywhere to deliver them. */
  onEarlyNotification?: (notification: DroidNotification) => void;
  onTransportError?: (error: Error) => void;
}

/** An unanswered injected request is a diagnostic dead end, never a run blocker. */
const INJECTED_REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class SniffingTransport implements StringFramedDroidClientTransport {
  private readonly pending = new Map<string, (result: unknown) => void>();
  private readonly messageHandlers: ((message: string) => void)[] = [];
  private readonly errorHandlers: ((error: Error) => void)[] = [];
  private sessionInit: SniffedSessionInit | null = null;
  private subscribed = false;

  constructor(
    private readonly inner: StringFramedDroidClientTransport,
    private readonly hooks: SniffingTransportHooks = {},
  ) {
    // Registered now, not on the SDK's first `onMessage`, so the frames that
    // fly during session creation are seen too.
    this.inner.onMessage((message) => this.receive(message));
    this.inner.onError((error) => {
      this.hooks.onTransportError?.(error);
      for (const handler of [...this.errorHandlers]) handler(error);
    });
  }

  get isConnected(): boolean {
    return this.inner.isConnected;
  }

  /** droid's own model list for this session, not Foundry's catalog. */
  get availableModels(): AvailableModel[] {
    return this.sessionInit?.availableModels ?? [];
  }

  get initResult(): SniffedSessionInit | null {
    return this.sessionInit;
  }

  send(message: string): Promise<void> {
    return this.inner.send(message);
  }

  onMessage(handler: (message: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  close(): Promise<void> {
    for (const settle of this.pending.values()) settle(null);
    this.pending.clear();
    return this.inner.close();
  }

  /** Stops the early-notification tap once a real consumer is attached. */
  markSubscribed(): void {
    this.subscribed = true;
  }

  /**
   * Sends a request the SDK has no method for and resolves its result.
   * Resolves `null` on a JSON-RPC error, a dead transport, or a timeout.
   */
  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = INJECTED_REQUEST_TIMEOUT_MS,
  ): Promise<T | null> {
    const id = `foundry-${randomUUID()}`;
    const frame = {
      jsonrpc: '2.0',
      factoryApiVersion: FACTORY_API_VERSION,
      factoryProtocolVersion: FACTORY_PROTOCOL_VERSION,
      type: 'request',
      id,
      method,
      params,
    };
    return new Promise<T | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, (result) => {
        clearTimeout(timer);
        resolve((result ?? null) as T | null);
      });
      this.inner.send(JSON.stringify(frame)).catch(() => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
      });
    });
  }

  private receive(message: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      // The child also prints non-JSON lines; they are not ours to interpret.
    }

    if (isRecord(parsed)) {
      const id = typeof parsed.id === 'string' ? parsed.id : null;
      const settle = id ? this.pending.get(id) : undefined;
      if (id && settle) {
        this.pending.delete(id);
        settle(parsed.error ? null : parsed.result);
        return;
      }
      this.captureSessionInit(parsed);
      if (!this.subscribed) this.emitEarlyNotification(parsed);
    }

    for (const handler of [...this.messageHandlers]) handler(message);
  }

  private captureSessionInit(frame: Record<string, unknown>): void {
    if (this.sessionInit || frame.type !== 'response') return;
    const result = frame.result;
    if (!isRecord(result) || !isRecord(result.settings)) return;
    this.sessionInit = {
      sessionId: typeof result.sessionId === 'string' ? result.sessionId : undefined,
      settings: result.settings as SessionSettings,
      availableModels: Array.isArray(result.availableModels)
        ? (result.availableModels as AvailableModel[])
        : undefined,
    };
  }

  private emitEarlyNotification(frame: Record<string, unknown>): void {
    if (frame.type !== 'notification' || frame.method !== 'droid.session_notification') return;
    const params = frame.params;
    if (!isRecord(params) || !isRecord(params.notification)) return;
    this.hooks.onEarlyNotification?.(params.notification as DroidNotification);
  }
}
