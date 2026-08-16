/**
 * In-memory stand-in for the daemon's session facade.
 *
 * Agent runs are daemon-only, so this is how every engine test gets a
 * transport: a real `droid daemon` needs a port, an API key, and the network,
 * none of which belong in a unit test. The seam is `DaemonSessionsFacade`,
 * the same interface `DaemonSession` talks to in production, so a test exercises
 * the production transport rather than a mock of it.
 */

import {
  ToolConfirmationOutcome,
  type AskUserRequestParams,
  type AskUserResult,
  type DroidResultMessage,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import type { DroidNotification, TokenUsage } from '../src/main/droid/protocol.js';
import type {
  DaemonHandle,
  DaemonSessionsFacade,
  DaemonStreamMessage,
} from '../src/main/droid/sdk/daemon-session.js';

/** SDK result tokenUsage is stricter than protocol TokenUsage (required ints). */
export function usage(overrides: Partial<TokenUsage> = {}): {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
} {
  return {
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 50,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 900,
    thinkingTokens: overrides.thinkingTokens ?? 10,
  };
}

export function resultSuccess(
  sessionId: string,
  text: string,
  tokenUsage = usage(),
): DroidResultMessage {
  return {
    type: 'result',
    subtype: 'success',
    success: true,
    interrupted: false,
    sessionId,
    durationMs: 12,
    tokenUsage,
    messages: [],
    text,
    turnCount: 1,
    error: null,
  };
}

/** One attached daemon handle — mirrors ConnectedDroidSession replacement IDs. */
export class ScriptedHandle implements DaemonHandle {
  status: 'attached' | 'detached' = 'attached';
  settings: Record<string, unknown>;
  cwd: string | undefined;
  readonly streamedPrompts: string[] = [];
  readonly notificationHandlers = new Set<(n: DroidNotification) => void>();
  interruptCalls = 0;
  compactCalls = 0;
  rewindCalls = 0;
  closeCalls = 0;
  detachCalls = 0;

  /** Script that runs when stream() is consumed. */
  turnScript: (
    handle: ScriptedHandle,
    prompt: string,
  ) => Promise<DroidResultMessage> | DroidResultMessage = (h, prompt) => h.defaultTurn(prompt);

  constructor(
    readonly id: string,
    readonly facade: ScriptedSessions,
    init: { cwd?: string; settings?: Record<string, unknown> } = {},
  ) {
    this.cwd = init.cwd;
    this.settings = {
      autonomyLevel: 'high',
      modelId: 'gpt-fake-default',
      ...(init.settings ?? {}),
    };
  }

  get permissionHandler() {
    return this.facade.handlersFor(this.id)?.permissionHandler;
  }

  get askUserHandler() {
    return this.facade.handlersFor(this.id)?.askUserHandler;
  }

  async *stream(
    prompt: string,
    options?: { abortSignal?: AbortSignal },
  ): AsyncGenerator<DaemonStreamMessage, void, undefined> {
    this.ensureAttached();
    this.streamedPrompts.push(prompt);
    this.facade.streamLog.push({ sessionId: this.id, prompt });
    if (options?.abortSignal?.aborted) {
      yield this.interruptedResult();
      return;
    }
    try {
      const result = await new Promise<DroidResultMessage>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          reject(new Error('aborted'));
        };
        options?.abortSignal?.addEventListener('abort', onAbort, { once: true });
        void Promise.resolve(this.turnScript(this, prompt)).then(
          (value) => {
            if (settled) return;
            settled = true;
            options?.abortSignal?.removeEventListener('abort', onAbort);
            resolve(value);
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            options?.abortSignal?.removeEventListener('abort', onAbort);
            reject(error);
          },
        );
      });
      yield result;
    } catch (error) {
      if (
        options?.abortSignal?.aborted ||
        (error instanceof Error && error.message === 'aborted')
      ) {
        // Mirror the real stream: abort ends the generator; DaemonSession maps
        // the timed-out abort onto the legacy timeout string.
        throw error;
      }
      throw error;
    }
  }

  async interrupt(): Promise<void> {
    this.ensureAttached();
    this.interruptCalls += 1;
  }

  async compact(): Promise<{ newSessionId: string; removedCount: number }> {
    this.ensureAttached();
    this.compactCalls += 1;
    return this.facade.compactFrom(this.id);
  }

  async rewind(params: {
    messageId: string;
    filesToRestore: { filePath: string; contentHash: string; size: number }[];
    filesToDelete: { filePath: string }[];
    forkTitle: string;
  }): Promise<{
    newSessionId: string;
    restoredCount: number;
    deletedCount: number;
    failedRestoreCount: number;
    failedDeleteCount: number;
  }> {
    this.ensureAttached();
    this.rewindCalls += 1;
    void params;
    return this.facade.rewindFrom(this.id);
  }

  async detach(): Promise<void> {
    if (this.status === 'detached') return;
    this.status = 'detached';
    this.detachCalls += 1;
    this.facade.detach(this.id);
  }

  async close(): Promise<void> {
    this.ensureAttached();
    this.closeCalls += 1;
    await this.detach();
  }

  subscribeNotifications(handler: (n: DroidNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  notify(n: DroidNotification): void {
    for (const handler of this.notificationHandlers) handler(n);
  }

  /** Deliver a permission ask through this handle's per-session handler. */
  async askPermission(
    params: RequestPermissionRequestParams,
  ): Promise<RequestPermissionHandlerResult | undefined> {
    const handler = this.permissionHandler;
    if (!handler) return undefined;
    return handler(params);
  }

  async askUser(params: AskUserRequestParams): Promise<AskUserResult | undefined> {
    const handler = this.askUserHandler;
    if (!handler) return undefined;
    return handler(params);
  }

  defaultTurn(prompt: string): DroidResultMessage {
    const text = `echo:${prompt}`;
    this.notify({
      type: 'create_message',
      message: {
        id: `msg-${this.id}-${this.streamedPrompts.length}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    } as DroidNotification);
    this.notify({
      type: 'create_message',
      message: {
        id: `asst-${this.id}-${this.streamedPrompts.length}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    } as DroidNotification);
    this.notify({
      type: 'session_token_usage_changed',
      tokenUsage: usage(),
    } as DroidNotification);
    this.notify({
      type: 'agent_turn_completed',
      reason: 'completed',
      turnId: 'turn',
      tokenUsage: usage(),
    } as DroidNotification);
    return resultSuccess(this.id, text);
  }

  interruptedResult(): DroidResultMessage {
    this.notify({
      type: 'agent_turn_completed',
      reason: 'cancelled',
      turnId: 'turn',
      tokenUsage: usage(),
    } as DroidNotification);
    return {
      type: 'result',
      subtype: 'interrupted',
      success: false,
      interrupted: true,
      sessionId: this.id,
      durationMs: 5,
      tokenUsage: usage(),
      messages: [],
      text: '',
      turnCount: 1,
      error: null,
    };
  }

  private ensureAttached(): void {
    if (this.status !== 'attached') {
      throw new Error(`handle ${this.id} is detached`);
    }
  }
}

export class ScriptedSessions implements DaemonSessionsFacade {
  readonly creates: Array<Record<string, unknown>> = [];
  readonly resumes: Array<{ sessionId: string; options: Record<string, unknown> }> = [];
  readonly updateCalls: Array<{ sessionId: string; params: Record<string, unknown> }> = [];
  readonly streamLog: Array<{ sessionId: string; prompt: string }> = [];
  /** Connection-level safety-net invocations. */
  connectionPermissionCalls = 0;
  connectionAskUserCalls = 0;
  connectionPermissionResults: RequestPermissionHandlerResult[] = [];

  private readonly handles = new Map<string, ScriptedHandle>();
  private readonly handlers = new Map<
    string,
    {
      permissionHandler?: (
        p: RequestPermissionRequestParams,
      ) => Promise<RequestPermissionHandlerResult> | RequestPermissionHandlerResult;
      askUserHandler?: (p: AskUserRequestParams) => Promise<AskUserResult> | AskUserResult;
    }
  >();
  private seq = 0;
  /** Settings applied after a "daemon restart" wipe of live handles. */
  private persisted = new Map<
    string,
    { cwd?: string; settings: Record<string, unknown>; messages: string[] }
  >();

  nextId = (): string => {
    this.seq += 1;
    return `daemon-session-${this.seq}`;
  };

  compactSuccessorId = 'daemon-session-compacted';
  rewindSuccessorId = 'daemon-session-rewound';
  removedOnCompact = 7;
  restoredOnRewind = 2;
  deletedOnRewind = 1;

  breakdown: {
    modelId: string;
    modelDisplayName: string;
    contextBudget: number;
    usedTokens: number;
    freeTokens: number;
    categories: { name: string; tokens: number; colorKey: string }[];
    skills: { name: string; location: string; tokens: number }[];
    mcpServers: { name: string; toolCount: number; tokens: number }[];
    droids: { name: string; location: string; tokens: number }[];
  } = {
    modelId: 'gpt-fake-default',
    modelDisplayName: 'Fake',
    contextBudget: 200_000,
    usedTokens: 40_000,
    freeTokens: 160_000,
    categories: [{ name: 'System prompt', tokens: 1200, colorKey: 'system' }],
    skills: [],
    mcpServers: [],
    droids: [],
  };

  tools: Array<{
    id: string;
    displayName: string;
    description: string;
    category: string;
    defaultAllowed: boolean;
    allowed: boolean;
  }> = [
    {
      id: 'Read',
      displayName: 'Read',
      description: 'read',
      category: 'read',
      defaultAllowed: true,
      allowed: true,
    },
    {
      id: 'Execute',
      displayName: 'Execute',
      description: 'exec',
      category: 'execute',
      defaultAllowed: true,
      allowed: true,
    },
  ];

  /** Connection-level fail-closed handlers (as DaemonManager installs). */
  connectionPermissionHandler = (
    params: RequestPermissionRequestParams,
  ): RequestPermissionHandlerResult => {
    this.connectionPermissionCalls += 1;
    const result: RequestPermissionHandlerResult = {
      selectedOption: ToolConfirmationOutcome.Cancel,
      comment: 'connection safety-net: no session handler',
    };
    this.connectionPermissionResults.push(result);
    void params;
    return result;
  };

  connectionAskUserHandler = (params: AskUserRequestParams): AskUserResult => {
    this.connectionAskUserCalls += 1;
    void params;
    return { cancelled: true, answers: [] };
  };

  handlersFor(sessionId: string) {
    return this.handlers.get(sessionId);
  }

  handle(sessionId: string): ScriptedHandle | undefined {
    return this.handles.get(sessionId);
  }

  async create(options: {
    cwd: string;
    autonomyLevel?: unknown;
    machineId?: string;
    permissionHandler?: (
      p: RequestPermissionRequestParams,
    ) => Promise<RequestPermissionHandlerResult> | RequestPermissionHandlerResult;
    askUserHandler?: (p: AskUserRequestParams) => Promise<AskUserResult> | AskUserResult;
    mcpServers?: unknown[];
  }): Promise<DaemonHandle> {
    this.creates.push({ ...options });
    const id = this.nextId();
    const handle = new ScriptedHandle(id, this, { cwd: options.cwd });
    this.handles.set(id, handle);
    this.handlers.set(id, {
      permissionHandler: options.permissionHandler,
      askUserHandler: options.askUserHandler,
    });
    this.persisted.set(id, { cwd: options.cwd, settings: { ...handle.settings }, messages: [] });
    // Surface settings.autonomyLevel as the create path left it (caller must set high).
    if (options.autonomyLevel !== undefined) {
      handle.settings.autonomyLevel = options.autonomyLevel;
    }
    return handle;
  }

  async resume(
    sessionId: string,
    options: {
      permissionHandler?: (
        p: RequestPermissionRequestParams,
      ) => Promise<RequestPermissionHandlerResult> | RequestPermissionHandlerResult;
      askUserHandler?: (p: AskUserRequestParams) => Promise<AskUserResult> | AskUserResult;
    } = {},
  ): Promise<DaemonHandle> {
    this.resumes.push({ sessionId, options: { ...options } });
    const prior = this.persisted.get(sessionId);
    if (!prior) throw new Error(`SessionNotFoundError: ${sessionId}`);
    // One attached handle per id — drop a stale live handle if present.
    const existing = this.handles.get(sessionId);
    if (existing && existing.status === 'attached') {
      await existing.detach();
    }
    const handle = new ScriptedHandle(sessionId, this, {
      cwd: prior.cwd,
      settings: { ...prior.settings },
    });
    this.handles.set(sessionId, handle);
    this.handlers.set(sessionId, {
      permissionHandler: options.permissionHandler,
      askUserHandler: options.askUserHandler,
    });
    return handle;
  }

  async updateSettings(sessionId: string, params: Record<string, unknown>): Promise<void> {
    this.updateCalls.push({ sessionId, params: { ...params } });
    const handle = this.handles.get(sessionId);
    if (handle) {
      handle.settings = { ...handle.settings, ...params };
    }
    const prior = this.persisted.get(sessionId);
    if (prior) {
      prior.settings = { ...prior.settings, ...params };
    }
  }

  async getContextBreakdown(sessionId: string) {
    void sessionId;
    return { ...this.breakdown, categories: [...this.breakdown.categories] };
  }

  async getRewindInfo(sessionId: string, messageId: string) {
    void sessionId;
    void messageId;
    return {
      availableFiles: [{ filePath: 'watched.txt', contentHash: 'abc', size: 12 }],
      createdFiles: [{ filePath: 'scratch.txt' }],
      evictedFiles: [] as { filePath: string; reason: string }[],
    };
  }

  async listTools(sessionId: string) {
    void sessionId;
    return this.tools.map((t) => ({ ...t }));
  }

  async getMessages(sessionId: string) {
    return this.persisted.get(sessionId)?.messages ?? [];
  }

  compactFrom(sourceId: string): { newSessionId: string; removedCount: number } {
    const source = this.handles.get(sourceId);
    const newSessionId = this.compactSuccessorId;
    this.persisted.set(newSessionId, {
      cwd: source?.cwd,
      settings: { ...(source?.settings ?? {}) },
      messages: [...(this.persisted.get(sourceId)?.messages ?? []), 'compacted'],
    });
    // Source handle stays usable (daemon semantics) — do NOT detach here.
    return { newSessionId, removedCount: this.removedOnCompact };
  }

  rewindFrom(sourceId: string): {
    newSessionId: string;
    restoredCount: number;
    deletedCount: number;
    failedRestoreCount: number;
    failedDeleteCount: number;
  } {
    const source = this.handles.get(sourceId);
    const newSessionId = this.rewindSuccessorId;
    this.persisted.set(newSessionId, {
      cwd: source?.cwd,
      settings: { ...(source?.settings ?? {}) },
      messages: [...(this.persisted.get(sourceId)?.messages ?? []), 'rewound'],
    });
    return {
      newSessionId,
      restoredCount: this.restoredOnRewind,
      deletedCount: this.deletedOnRewind,
      failedRestoreCount: 0,
      failedDeleteCount: 0,
    };
  }

  detach(sessionId: string): void {
    const handle = this.handles.get(sessionId);
    if (handle) handle.status = 'detached';
    this.handles.delete(sessionId);
    this.handlers.delete(sessionId);
  }

  /** Simulate daemon restart: live handles die; disk sessions remain. */
  restartDaemon(): void {
    for (const handle of this.handles.values()) {
      handle.status = 'detached';
    }
    this.handles.clear();
    this.handlers.clear();
  }

  /** Deliver a connection-level ask (no matching session handler). */
  safetyNetPermission(params: RequestPermissionRequestParams): RequestPermissionHandlerResult {
    return this.connectionPermissionHandler(params);
  }

  noteMessage(sessionId: string, text: string): void {
    const prior = this.persisted.get(sessionId);
    if (prior) prior.messages.push(text);
  }
}
