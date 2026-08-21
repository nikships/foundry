/**
 * Smith's chat session: one persistent, multi-turn agent conversation per
 * project, behind the vendor-neutral `AgentTransport` seam.
 *
 * Deliberately not a run. There are no tracer rows, no `foundry/<runId>`
 * branch, and no engine involvement: Smith is interactive, the operator is
 * present, and ordinary edits land directly in the project checkout where git
 * is the undo. Entity writes still gate on the approval card — but that gate
 * lives inside the entity tools, not in this file.
 *
 * Lifecycle mirrors `pi/session.ts`: the session opens lazily on the first
 * message and the transport is injected, so a test drives the exact same
 * object as production with `tests/helpers/scripted-transport.ts`.
 *
 * The conversation itself is persisted by the transport's file-backed session
 * (pinned under `<supportDir>/pi/`, never `~/.pi`); this file keeps only a
 * small pointer — which session id to resume, and a model override — so the
 * chat survives an app relaunch.
 *
 * A mid-conversation model switch opens a **successor session**: the model is
 * stated once at create and never drifts (see `references/sdk.md`), so the
 * current transport is closed and the next turn reopens the persisted session
 * file under the new model, carrying the transcript context forward.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReasoningEffort } from '@shared/types.js';
import { evaluate } from '../pi/policy.js';
import type { ToolDefinition } from '../pi/tool-definition.js';
import type {
  AgentTransport,
  PermissionAsk,
  PermissionDecision,
  TransportEvent,
  TurnUsage,
} from '../pi/transport.js';
import {
  SMITH_CHAT_HARNESS,
  screenContextBlock,
  type SmithScreenContext,
} from './system-prompt.js';

/** What a tool factory gets to close over: the session's scope, nothing more. */
export interface SmithToolFactoryContext {
  projectId: string;
  /** The project's checkout — the session's working directory. */
  projectPath: string;
}

/**
 * How entity and readiness tools register onto the session. Each factory is
 * called once per `SmithChatSession` and contributes tool definitions built
 * through the `pi/tool-definition.ts` seam; the transport registers them, and
 * the policy allows them by name. A tool module ships as a factory so it can
 * close over its own dependencies (stores, the proposal queue) without this
 * file importing them.
 */
export type SmithToolFactory = (ctx: SmithToolFactoryContext) => ToolDefinition[];

/** Everything the transport factory needs that only this session knows. */
export interface SmithTransportRequest {
  projectId: string;
  /** The project checkout; Smith's session runs in it, never a worktree. */
  cwd: string;
  /** The model this session asks for; `inherit` lets the install choose. */
  model: string;
  reasoningEffort: ReasoningEffort;
  /** Standing identity, installed as the system prompt at create. */
  harness: string;
  /** The tools contributed by the registered factories. */
  customTools: ToolDefinition[];
  onPermission: (ask: PermissionAsk) => PermissionDecision;
  onEvent: (event: TransportEvent) => void;
  onModelWarning: (warning: string) => void;
}

export interface SmithChatSessionDeps {
  projectId: string;
  /** The project's checkout. Resolved by the caller; never `process.cwd()`. */
  projectPath: string;
  /**
   * Where this session's pointer state lives (session id + model override).
   * Pinned under `<supportDir>/pi/` by the caller, per the never-touch-`~/.pi`
   * invariant; the transcript itself is the transport's session file.
   */
  stateDir: string;
  turnTimeoutMs: number;
  /**
   * The global `smithModel` setting, read at every open so a settings change
   * applies to the next session rather than requiring a restart.
   */
  smithModel: () => string;
  /** Defaults to `medium`; Smith has no per-turn effort knob. */
  reasoningEffort?: ReasoningEffort;
  /** Entity / readiness tool modules, registered at construction. */
  toolFactories?: SmithToolFactory[];
  /** Builds the transport this session drives. Injected, never constructed here. */
  transport: (req: SmithTransportRequest) => AgentTransport;
  /** Live transcript stream for the chat surface. */
  onEvent?: (event: TransportEvent) => void;
  onModelWarning?: (warning: string) => void;
}

export interface SmithTurnContext {
  /** What the operator is looking at, appended as standing context per turn. */
  screen?: SmithScreenContext;
}

export interface SmithTurnOutcome {
  text: string;
  usage: TurnUsage | null;
  reason: string;
  interrupted: boolean;
}

/** The pointer this session keeps on disk, so a relaunch resumes the chat. */
interface PersistedChatState {
  sessionId: string | null;
  /** A header model switch, which outlives the session it was made in. */
  modelOverride: string | null;
}

const STATE_FILE = 'chat-state.json';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SmithChatSession {
  private transport: AgentTransport | null = null;
  private sessionId: string | null = null;
  private modelOverride: string | null = null;
  private turnActive = false;
  private readonly customTools: ToolDefinition[];
  private readonly customToolNames: string[];

  constructor(private readonly deps: SmithChatSessionDeps) {
    const ctx: SmithToolFactoryContext = {
      projectId: deps.projectId,
      projectPath: deps.projectPath,
    };
    this.customTools = (deps.toolFactories ?? []).flatMap((factory) => factory(ctx));
    this.customToolNames = this.customTools.map((tool) => tool.name);
    this.restoreState();
  }

  /** The model the next open would ask for: the header switch, or the setting. */
  get model(): string {
    return this.modelOverride ?? this.deps.smithModel();
  }

  /** What is actually running once a session is open. */
  get activeModel(): string {
    return this.transport?.activeModel ?? this.model;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get isTurnActive(): boolean {
    return this.turnActive;
  }

  /** One user message: opens the session lazily, answers when the turn settles. */
  async send(text: string, ctx: SmithTurnContext = {}): Promise<SmithTurnOutcome> {
    if (this.turnActive) throw new Error('a Smith turn is already running');
    this.turnActive = true;
    try {
      await this.ensureStarted();
      const transport = this.transport;
      if (!transport) throw new Error('smith chat session is not open');
      const result = await transport.send(text, this.deps.turnTimeoutMs, {
        ...(ctx.screen ? { systemPrompt: screenContextBlock(ctx.screen) } : {}),
      });
      return {
        text: result.text,
        usage: result.usage,
        reason: result.reason,
        interrupted: result.interrupted,
      };
    } finally {
      this.turnActive = false;
    }
  }

  /** Ends the turn in flight, if any. The session stays open for the next one. */
  async cancel(): Promise<void> {
    await this.transport?.interrupt();
  }

  /**
   * Wipe the conversation and start fresh: the live session is disposed and
   * the pointer cleared, so the next message opens a brand-new session file.
   */
  async newChat(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.sessionId = null;
    this.persistState();
    if (transport) await transport.close();
  }

  /**
   * Switch models mid-conversation. The model is stated once at create, so a
   * switch closes the live transport and keeps the session id: the next
   * message opens a successor session over the same persisted history file,
   * carrying the transcript context forward under the new model.
   */
  async setModel(model: string): Promise<void> {
    if (model === this.model) return;
    this.modelOverride = model;
    this.persistState();
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.close();
  }

  /** Closes the live session. The pointer survives, so a relaunch resumes. */
  async dispose(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.close();
  }

  /** Started lazily: a project whose Smith is never opened costs nothing. */
  private async ensureStarted(): Promise<void> {
    if (this.transport?.alive) return;
    const transport = this.deps.transport({
      projectId: this.deps.projectId,
      cwd: this.deps.projectPath,
      model: this.model,
      reasoningEffort: this.deps.reasoningEffort ?? 'medium',
      harness: SMITH_CHAT_HARNESS,
      customTools: this.customTools,
      onPermission: (ask) => this.decide(ask),
      onEvent: (event) => this.deps.onEvent?.(event),
      onModelWarning: (warning) => this.deps.onModelWarning?.(warning),
    });
    try {
      await transport.start(this.sessionId);
    } catch (e) {
      await transport.close().catch(() => undefined);
      throw new Error(`smith chat session start failed: ${errorMessage(e)}`);
    }
    this.transport = transport;
    this.sessionId = transport.id;
    this.persistState();
  }

  /**
   * Smith departs from the zero-interrupt run policy on purpose: the operator
   * is present and git is the undo, so writes inside the checkout are allowed
   * without a boundary. What stands is the fail-closed floor — an unknown
   * tool is denied, and a write outside the checkout is denied, because
   * nothing would revert it.
   */
  private decide(ask: PermissionAsk): PermissionDecision {
    return evaluate(
      ask,
      { worktree: this.deps.projectPath, writes: null, protectedPaths: [] },
      this.customToolNames,
    ).decision;
  }

  private get stateFile(): string {
    return join(this.deps.stateDir, STATE_FILE);
  }

  private restoreState(): void {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PersistedChatState>;
      this.sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null;
      this.modelOverride = typeof raw.modelOverride === 'string' ? raw.modelOverride : null;
    } catch {
      // A missing or unreadable pointer is a fresh chat, not a failure.
    }
  }

  private persistState(): void {
    const state: PersistedChatState = {
      sessionId: this.sessionId,
      modelOverride: this.modelOverride,
    };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      // Losing the pointer costs a resumed transcript, never the session.
    }
  }
}
