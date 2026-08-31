/**
 * The vendor-neutral agent transport seam.
 *
 * `AgentSession` (src/main/pi/session.ts) owns lifecycle policy — when a
 * session opens, what a turn is traced as, when it compacts, when it rewinds —
 * and talks only to this contract. `PiTransport` implements it over an
 * in-process Pi `AgentSession`; a test implements it directly.
 *
 * Nothing in this file may name a vendor type. That is the whole point: the
 * engine, the executor's fixtures, and the trace all sit above it, so a second
 * implementation costs one file rather than a pass over every layer.
 */

import type { ContextBreakdown, ReasoningEffort, ToolProfile } from '@shared/types.js';
import type { Envelope } from '../engine/envelopes.js';
import type { Tracer } from '../trace/tracer.js';

/**
 * What Foundry's own tools close over. Neutral by construction — a Tracer and
 * the live run's phase context — so a transport that can register tools takes
 * it without either side naming a vendor.
 */
export interface FoundryToolContext {
  runId: string;
  agentName: string;
  /** Current phase id for the trace row; null before the first turn. */
  phaseId: () => string | null;
  /** Validated envelopes for this run, keyed by phase name, insertion order. */
  envelopes: () => ReadonlyMap<string, Envelope>;
  tracer: Pick<Tracer, 'event'>;
  /**
   * The run's worktree and the commit it branched from — the scope `git_diff`
   * answers within. The engine resolves both; the model never names a ref, so
   * it cannot point the diff at history outside its own run. Read per call,
   * not captured, because a session outlives any one phase.
   */
  diff: () => { cwd: string; branchPointSha: string };
}

/** A model this transport could run a turn on. */
export interface TransportModel {
  id: string;
  displayName: string;
  provider: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  contextWindow?: number;
}

/** How full a session's context is. Occupancy is the transport's own estimate. */
export interface ContextStats {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * A JSON Schema for the structured result one turn should submit. Only the
 * shape travels here; where the schema comes from is the caller's business.
 */
export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

export interface TurnOptions {
  /** Adds a schema-bound answer channel; other mid-turn tool use is unaffected. */
  outputFormat?: OutputFormat;
  /**
   * Standing role for this turn, installed as the system prompt. The user
   * message must not repeat it — that is how a persona is replayed into
   * history and how prefix cache is busted.
   */
  systemPrompt?: string;
}

/** What one turn produced. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  thinkingTokens: number;
}

export interface TurnResult {
  /** Final assistant text — what the envelope is parsed from. */
  text: string;
  usage: TurnUsage | null;
  reason: string;
  interrupted: boolean;
  /**
   * What the transport shaped for us, `null` when it could not or was never
   * asked. It is a candidate, never a verdict: the caller still parses it.
   */
  structuredOutput: Record<string, unknown> | null;
}

/**
 * A capability the agent asked to use, in transport-neutral terms, so
 * `permissions.ts` can rule on it without knowing whose tool it was.
 */
export interface PermissionAsk {
  /** The tool's own name, as the transport calls it. */
  tool: string;
  /** Arguments the tool was called with, verbatim. */
  input: Record<string, unknown>;
  /** The shell command, when this is a command-running tool. */
  command?: string;
  /** The file this call would write, when it writes one. */
  path?: string;
}

export type PermissionDecision = { outcome: 'allow' } | { outcome: 'deny'; reason: string };

/** One structural event a transport emits while a turn runs. */
export type TransportEvent =
  | { type: 'text_delta'; messageId: string; blockIndex: number; delta: string }
  | { type: 'text_end'; messageId: string; blockIndex: number; content?: string }
  | { type: 'thinking_delta'; messageId: string; delta: string }
  | { type: 'thinking_end'; messageId: string }
  | { type: 'tool_call'; callId: string; tool: string; input: Record<string, unknown> }
  | { type: 'tool_output'; callId: string; content: string }
  | { type: 'tool_result'; callId: string; content: string; isError: boolean }
  | { type: 'retry'; attempt: number; maxAttempts: number; message: string }
  | { type: 'usage'; usage: TurnUsage };

/**
 * A transport was asked to open without a usable model choice.
 *
 * Lives on the neutral seam so a caller can recognise the refusal without
 * importing a vendor-bound transport module. Thrown by `start()`; a transport
 * that is free to substitute a model does not throw it at all.
 */
export class ModelNotChosen extends Error {
  constructor(
    /** `unset`: nothing picked yet. `unavailable`: the pick is not reachable. */
    readonly reason: 'unset' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ModelNotChosen';
  }
}

/**
 * The lifecycle `AgentSession` drives. Every method is allowed to answer `null`
 * for "this transport cannot tell you" — a diagnostic is never worth a failed
 * run, and the engine's guards are post-hoc and code-owned either way.
 */
export interface AgentTransport {
  /** Open (or resume) the session. Called once, lazily, before the first turn. */
  start(existingSessionId?: string | null): Promise<void>;
  send(text: string, opts?: TurnOptions): Promise<TurnResult>;
  /** Report the live model after startup substitution or runtime failover. */
  applySettings(): Promise<{ model: string; warning?: string }>;
  contextStats(): Promise<ContextStats | null>;
  contextBreakdown(): Promise<ContextBreakdown | null>;
  /** Compact in place, or `null` when there was nothing to compact. */
  compact(): Promise<{ removedCount: number } | null>;
  /**
   * What a rewind to `messageId` could put back. `null` when the transport
   * cannot answer, which the caller reads as "do not rewind".
   */
  getRewindInfo(messageId: string): Promise<RewindInfo | null>;
  rewind(params: RewindParams): Promise<RewindOutcome | null>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  kill(): void;
  readonly id: string | null;
  readonly alive: boolean;
  /** Child pid when this transport owns one; in-process transports have none. */
  readonly pid: number | undefined;
  /** Anchor for a rewind: the last user message the session recorded. */
  readonly lastUserMessageId: string | null;
  readonly availableModels: TransportModel[];
  readonly activeModel: string;
  /**
   * The reasoning effort this session opened with — what a caller displaying
   * "what is running" should read rather than what it asked for. A transport
   * that clamps the requested level to its resolved model reports the clamped
   * value; one that passes the caller's level through reports that. It is
   * fixed at open either way: pi states the thinking level at create.
   */
  readonly activeReasoningEffort: ReasoningEffort;
}

export interface RewindFile {
  filePath: string;
  contentHash: string;
  size: number;
}

export interface RewindInfo {
  availableFiles: RewindFile[];
  createdFiles: { filePath: string }[];
  evictedFiles: { filePath: string; reason: string }[];
}

export interface RewindParams {
  messageId: string;
  filesToRestore: RewindFile[];
  filesToDelete: { filePath: string }[];
  forkTitle: string;
}

export interface RewindOutcome {
  restoredCount: number;
  deletedCount: number;
  failedRestoreCount: number;
  failedDeleteCount: number;
}

/** What every transport accepts from `AgentSession`. */
export interface AgentTransportOptions {
  /** The run's worktree. Resolved by the caller; never `process.cwd()`. */
  cwd: string;
  /** The run this session belongs to, so a child can be registered for killRun(). */
  runId: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  /**
   * Which tools the session is opened with. Absent means the full set. A
   * transport honours this by omitting the tools, never by refusing them: a
   * tool the registry does not hold is one the agent cannot ask for.
   */
  toolProfile?: ToolProfile;
  /** Ruled on by `permissions.ts`; a started run never waits for a person. */
  onPermission: (ask: PermissionAsk) => PermissionDecision | Promise<PermissionDecision>;
  onEvent?: (event: TransportEvent) => void;
  onModelWarning?: (warning: string) => void;
}
