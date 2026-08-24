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
 * (pinned under `<supportDir>/pi/`, never `~/.pi`); this file keeps the small
 * pointer needed to resume plus a renderer-ready transcript cache, so both the
 * model context and the visible chat survive an app relaunch.
 *
 * A mid-conversation model or reasoning-effort switch opens a **successor
 * session**: both are stated once at create and never drift (see
 * `references/sdk.md`), so the current transport is closed and the next turn
 * reopens the persisted session file under the new choice, carrying the
 * transcript context forward.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isReasoningEffort } from '@shared/reasoning-effort.js';
import { SMITH_ARTIFACT_VERSION } from '@shared/types.js';
import { isHiddenVendorText, stripVendorToolEcho } from '@shared/vendor-text.js';
import type { ReasoningEffort, SmithArtifact } from '@shared/types.js';
import type {
  SmithChatEntry,
  SmithChatState,
  SmithScreenContext,
  SmithTranscriptEntry,
} from '@shared/ipc-contract.js';
import { evaluate } from '../pi/policy.js';
import type { ToolDefinition } from '../pi/tool-definition.js';
import { foldTranscript } from '../pi/transcript.js';
import { ModelNotChosen } from '../pi/transport.js';
import type {
  AgentTransport,
  PermissionAsk,
  PermissionDecision,
  TransportEvent,
  TurnUsage,
} from '../pi/transport.js';
import { shortId } from '../session/panel-session.js';
import type { ReadinessProgressEvent } from './readiness-tools.js';
import { SMITH_CHAT_HARNESS, scopeContextBlock, screenContextBlock } from './system-prompt.js';

export type SmithScope =
  | { kind: 'project'; projectId: string; projectPath: string }
  | { kind: 'global'; workspace: string };

/** What a tool factory gets to close over: the session's scope, nothing more. */
export interface SmithToolFactoryContext {
  projectId?: string;
  /** Project checkout or the global Smith workspace. */
  cwd: string;
  scope: SmithScope;
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
  projectId?: string;
  /** Project checkout in project scope; private support workspace globally. */
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
  scope: SmithScope;
  /**
   * Where this session's pointer and renderer transcript cache live.
   * Pinned under `<supportDir>/pi/` by the caller, per the never-touch-`~/.pi`
   * invariant; the transcript itself is the transport's session file.
   */
  stateDir: string;
  /**
   * The global `smithModel` setting, read at every open so a settings change
   * applies to the next session rather than requiring a restart.
   */
  smithModel: () => string;
  /**
   * The global `smithReasoningEffort` setting, read at every open for the same
   * reason as the model. The header's per-conversation choice overrides it.
   */
  smithReasoningEffort?: () => ReasoningEffort;
  /** Entity / readiness tool modules, registered at construction. */
  toolFactories?: SmithToolFactory[];
  /** Builds the transport this session drives. Injected, never constructed here. */
  transport: (req: SmithTransportRequest) => AgentTransport;
  /** Live transcript stream for the chat surface. */
  onEvent?: (event: TransportEvent) => void;
  onModelWarning?: (warning: string) => void;
  /** Receives a cloned state whenever the renderer-facing snapshot changes. */
  onChange?: (state: SmithChatState) => void;
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
  /** A header effort switch, persisted for the same reason as the model. */
  reasoningEffortOverride: ReasoningEffort | null;
  /** Renderer-ready cache; pi's session file remains the model's history. */
  transcript: SmithTranscriptEntry[];
}

const STATE_FILE = 'chat-state.json';
const MAX_TRANSCRIPT_ENTRIES = 500;
const MAX_TRANSCRIPT_TEXT = 20_000;
const MAX_WARNING_TEXT = 500;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function visibleTranscript(entries: SmithTranscriptEntry[]): SmithTranscriptEntry[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== 'text') return [{ ...entry }];
    const text = stripVendorToolEcho(entry.text);
    if (isHiddenVendorText(text) || isHiddenVendorText(entry.text)) return [];
    return [{ ...entry, text }];
  });
}

function isHiddenRestoredText(entry: SmithTranscriptEntry): boolean {
  return entry.kind === 'text' && isHiddenVendorText(entry.text);
}

/**
 * One persisted row, restored fail-soft. An artifact from a newer build (or a
 * corrupt one) becomes a readable note rather than a render error or a lost
 * chat: the surrounding conversation always survives.
 *
 * Every artifact kind restores the same way, receipts included: an artifact is
 * a data snapshot with no executor behind it, so a restored one can be read
 * but never re-run.
 */
function restoreEntry(entry: SmithTranscriptEntry): SmithTranscriptEntry {
  if (entry.kind !== 'artifact') return { ...entry };
  const artifact = entry.artifact as SmithArtifact | undefined;
  if (
    artifact &&
    typeof artifact === 'object' &&
    typeof artifact.kind === 'string' &&
    artifact.version === SMITH_ARTIFACT_VERSION
  ) {
    return { ...entry, artifact: { ...artifact } };
  }
  return {
    id: entry.id,
    kind: 'note',
    text: 'An earlier card could not be restored by this version of Foundry.',
    source: 'smith',
    at: entry.at,
  };
}

/** The project this scope belongs to, or undefined in the global conversation. */
function scopeProjectId(scope: SmithScope): string | undefined {
  return scope.kind === 'project' ? scope.projectId : undefined;
}

/** Where this scope's session runs: the project checkout, or Smith's workspace. */
function scopeCwd(scope: SmithScope): string {
  return scope.kind === 'project' ? scope.projectPath : scope.workspace;
}

export class SmithChatSession {
  private transport: AgentTransport | null = null;
  private sessionId: string | null = null;
  private modelOverride: string | null = null;
  private reasoningEffortOverride: ReasoningEffort | null = null;
  private turnActive = false;
  private cancelRequested = false;
  private lastError: string | null = null;
  private transcript: SmithTranscriptEntry[] = [];
  private readonly customTools: ToolDefinition[];
  private readonly customToolNames: string[];
  private readonly absorbTranscript: (event: TransportEvent) => void;

  constructor(private readonly deps: SmithChatSessionDeps) {
    const projectId = scopeProjectId(deps.scope);
    const ctx: SmithToolFactoryContext = {
      ...(projectId ? { projectId } : {}),
      cwd: scopeCwd(deps.scope),
      scope: deps.scope,
    };
    this.customTools = (deps.toolFactories ?? []).flatMap((factory) => factory(ctx));
    this.customToolNames = this.customTools.map((tool) => tool.name);
    this.restoreState();
    this.absorbTranscript = foldTranscript<SmithChatEntry>({
      push: (row) => this.push({ ...row, source: 'smith' }),
      flush: () => this.emit(),
      // An operator row separates turns, and an artifact card separates text.
      // Only grow the literal last row when it is Smith's own chat row, or a
      // new answer would append to the prior turn (or to a card).
      last: () => {
        const last = this.transcript[this.transcript.length - 1];
        return last?.source === 'smith' && last.kind !== 'artifact' ? last : null;
      },
      textCap: MAX_TRANSCRIPT_TEXT,
    });
  }

  /** The model the next open would ask for: the header switch, or the setting. */
  get model(): string {
    return this.modelOverride ?? this.deps.smithModel();
  }

  /** What is actually running once a session is open. */
  get activeModel(): string {
    return this.transport?.activeModel ?? this.model;
  }

  /** The effort the next open would ask for: the header switch, or the setting. */
  get reasoningEffort(): ReasoningEffort {
    return this.reasoningEffortOverride ?? this.deps.smithReasoningEffort?.() ?? 'medium';
  }

  /**
   * What is actually running: the live session's clamped effort, so a level
   * the resolved model does not offer reads as the level it fell back to.
   */
  get activeReasoningEffort(): ReasoningEffort {
    return this.transport?.activeReasoningEffort ?? this.reasoningEffort;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get isTurnActive(): boolean {
    return this.turnActive;
  }

  /** A clone for IPC reads and pushes; callers never receive the live array. */
  snapshot(): SmithChatState {
    const projectId = scopeProjectId(this.deps.scope);
    return {
      ...(projectId ? { projectId } : {}),
      model: this.model,
      activeModel: this.activeModel,
      reasoningEffort: this.reasoningEffort,
      activeReasoningEffort: this.activeReasoningEffort,
      running: this.turnActive,
      error: this.lastError,
      transcript: visibleTranscript(this.transcript),
    };
  }

  /** One user message: opens the session lazily, answers when the turn settles. */
  async send(text: string, ctx: SmithTurnContext = {}): Promise<SmithTurnOutcome> {
    if (this.turnActive) throw new Error('a Smith turn is already running');
    this.turnActive = true;
    this.cancelRequested = false;
    this.lastError = null;
    this.push({ kind: 'text', text, source: 'operator' });
    let started: AgentTransport | null = null;
    try {
      await this.ensureStarted();
      started = this.transport;
      if (!started) throw new Error('smith chat session is not open');
      // Cancel can arrive while the lazy session is still opening, before
      // there is a transport to interrupt. Do not start a paid turn after it.
      if (this.cancelRequested) {
        return { text: '', usage: null, reason: 'cancelled', interrupted: true };
      }
      const result = await started.send(text, {
        ...(ctx.screen ? { systemPrompt: screenContextBlock(ctx.screen) } : {}),
      });
      return {
        text: result.text,
        usage: result.usage,
        reason: result.reason,
        interrupted: result.interrupted,
      };
    } catch (e) {
      this.lastError = errorMessage(e);
      this.push({ kind: 'error', text: this.lastError, source: 'smith' });
      throw e;
    } finally {
      this.turnActive = false;
      // A model or effort switch made during this turn dropped the session
      // without closing it, so the answer could finish. Dispose it here, or
      // the successor opens alongside a live one that nothing holds.
      const orphaned = this.transport !== started ? started : null;
      this.persistState();
      this.emit();
      if (orphaned) await orphaned.close().catch(() => undefined);
    }
  }

  /** Ends the turn in flight, if any. The session stays open for the next one. */
  async cancel(): Promise<void> {
    if (!this.turnActive) return;
    this.cancelRequested = true;
    await this.transport?.interrupt();
  }

  /**
   * Wipe the conversation and start fresh: the live session is disposed and
   * the pointer cleared, so the next message opens a brand-new session file.
   *
   * The effort override goes with it. It belongs to the conversation being
   * wiped, so a new chat opens at the install default — which is what
   * Settings → Smith calls itself.
   */
  async newChat(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.sessionId = null;
    this.transcript = [];
    this.lastError = null;
    this.reasoningEffortOverride = null;
    this.persistState();
    this.emit();
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
    await this.reopenOnNextTurn();
  }

  /**
   * Switch reasoning effort mid-conversation. Same shape as a model switch,
   * and for the same reason: the thinking level is stated at create, so it
   * takes effect on a successor session over the same history rather than
   * part-way through the turn in flight.
   *
   * The choice is this conversation's, not the install's — it is persisted
   * beside the model override and never written back to Settings → Smith,
   * which stays the default a *new* chat opens at.
   */
  async setReasoningEffort(effort: ReasoningEffort): Promise<void> {
    if (effort === this.reasoningEffort) return;
    this.reasoningEffortOverride = effort;
    await this.reopenOnNextTurn();
  }

  /** Closes the live session. The pointer survives, so a relaunch resumes. */
  async dispose(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    this.persistState();
    if (transport) await transport.close();
  }

  /**
   * Adds an artifact card to the transcript: a `smith_present` design mid-turn,
   * or an action receipt main minted when an approved action settled.
   * Persisted immediately: the card must survive a relaunch even when the
   * turn that produced it never settles (a cancel, a crash).
   */
  absorbArtifact(artifact: SmithArtifact): void {
    this.append({
      id: artifact.id,
      kind: 'artifact',
      source: 'smith',
      artifact,
      at: artifact.createdAt,
    });
    this.persistState();
  }

  /** Adds readiness remediator progress as a visually distinct transcript seam. */
  absorbReadinessProgress(event: ReadinessProgressEvent): void {
    if (event.type === 'entry_update') {
      const index = this.transcript.findIndex((entry) => entry.id === event.entry.id);
      if (index >= 0) {
        this.transcript[index] = { ...event.entry, source: 'readiness' };
        this.emit();
      }
      return;
    }
    if (event.type === 'entry') {
      this.push({ ...event.entry, source: 'readiness' });
      return;
    }
    this.push({ kind: 'note', text: event.detail, source: 'readiness' });
  }

  /**
   * Drop the live transport but keep the session id, so the next message
   * reopens a successor session over the same persisted history under the new
   * model or thinking level.
   *
   * A turn in flight is left running: closing the transport under it would
   * abort the answer the operator is waiting for, and `ensureStarted` reopens
   * on the next message anyway because the dropped transport is no longer
   * `alive` to it. Only an idle session is torn down eagerly.
   */
  private async reopenOnNextTurn(): Promise<void> {
    this.lastError = null;
    this.persistState();
    const transport = this.transport;
    this.transport = null;
    this.emit();
    if (transport && !this.turnActive) await transport.close();
  }

  /** Started lazily: a project whose Smith is never opened costs nothing. */
  private async ensureStarted(): Promise<void> {
    if (this.transport?.alive) return;
    const projectId = scopeProjectId(this.deps.scope);
    const transport = this.deps.transport({
      ...(projectId ? { projectId } : {}),
      cwd: scopeCwd(this.deps.scope),
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      harness: `${SMITH_CHAT_HARNESS}\n\n${scopeContextBlock(this.deps.scope)}`,
      customTools: this.customTools,
      onPermission: (ask) => this.decide(ask),
      onEvent: (event) => {
        this.absorbTranscript(event);
        this.deps.onEvent?.(event);
      },
      onModelWarning: (warning) => {
        this.push({ kind: 'note', text: warning.slice(0, MAX_WARNING_TEXT), source: 'smith' });
        this.deps.onModelWarning?.(warning);
      },
    });
    try {
      await transport.start(this.sessionId);
    } catch (e) {
      await transport.close().catch(() => undefined);
      // The "pick a model" gate is an instruction to the operator, not a
      // failure to report. Wrapping it in session-start noise would bury the
      // one sentence that says what to do about it.
      if (e instanceof ModelNotChosen) throw e;
      throw new Error(`smith chat session start failed: ${errorMessage(e)}`);
    }
    this.transport = transport;
    this.sessionId = transport.id;
    this.persistState();
    this.emit();
  }

  /**
   * Smith departs from the zero-interrupt run policy on purpose: the operator
   * is present and git is the undo, so writes inside the checkout are allowed
   * without a boundary. What stands is the fail-closed floor — an unknown
   * tool is denied, and a write outside the checkout is denied, because
   * nothing would revert it.
   */
  private decide(ask: PermissionAsk): PermissionDecision {
    const worktree = scopeCwd(this.deps.scope);
    return evaluate(ask, { worktree, writes: null, protectedPaths: [] }, this.customToolNames)
      .decision;
  }

  private get stateFile(): string {
    return join(this.deps.stateDir, STATE_FILE);
  }

  private restoreState(): void {
    try {
      const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PersistedChatState>;
      this.sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : null;
      this.modelOverride = typeof raw.modelOverride === 'string' ? raw.modelOverride : null;
      this.reasoningEffortOverride = isReasoningEffort(raw.reasoningEffortOverride)
        ? raw.reasoningEffortOverride
        : null;
      if (Array.isArray(raw.transcript)) {
        this.transcript = raw.transcript
          .slice(-MAX_TRANSCRIPT_ENTRIES)
          .map((entry) => restoreEntry(entry))
          .filter((entry) => !isHiddenRestoredText(entry));
      }
    } catch {
      // A missing or unreadable pointer is a fresh chat, not a failure.
    }
  }

  private push(
    entry: Omit<SmithChatEntry, 'id' | 'at'> & Partial<Pick<SmithChatEntry, 'id' | 'at'>>,
  ): SmithChatEntry {
    const full: SmithChatEntry = {
      ...entry,
      id: entry.id ?? shortId(),
      at: entry.at ?? Date.now(),
    };
    this.append(full);
    return full;
  }

  private append(entry: SmithTranscriptEntry): void {
    this.transcript.push(entry);
    if (this.transcript.length > MAX_TRANSCRIPT_ENTRIES) this.transcript.shift();
    this.emit();
  }

  private emit(): void {
    this.deps.onChange?.(this.snapshot());
  }

  private persistState(): void {
    const state: PersistedChatState = {
      sessionId: this.sessionId,
      modelOverride: this.modelOverride,
      reasoningEffortOverride: this.reasoningEffortOverride,
      transcript: this.transcript.map((entry) => ({ ...entry })),
    };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      // Losing the pointer costs a resumed transcript, never the session.
    }
  }
}
