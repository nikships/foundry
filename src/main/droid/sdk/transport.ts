/**
 * The agent-facing session surface shared by subprocess SdkSession and
 * daemon DaemonSession. AgentSession talks only to this contract so the
 * transport can swap without the engine noticing.
 */

import type {
  ContextBreakdown,
  ReasoningEffort,
  ToolPolicySpec,
  UserMcpServer,
} from '@shared/types.js';
import type { AvailableModel, ContextStatsResult, DroidNotification } from '../protocol.js';
import type { PermissionAsk, PermissionDecision, TurnOptions, TurnResult } from '../turn.js';

/** One tool as this session sees it; `id` is the llmId the allowlist names. */
export interface SessionTool {
  id: string;
  displayName: string;
  description: string;
  category: string;
  defaultAllowed: boolean;
  allowed: boolean;
}

export interface TransportSession {
  start(existingSessionId?: string | null): Promise<void>;
  send(text: string, timeoutMs: number, opts?: TurnOptions): Promise<TurnResult>;
  applySettings(): Promise<{ model: string; warning?: string }>;
  contextStats(): Promise<ContextStatsResult | null>;
  contextBreakdown(): Promise<ContextBreakdown | null>;
  compact(): Promise<{ removedCount: number } | null>;
  getRewindInfo(messageId: string): Promise<{
    availableFiles: { filePath: string; contentHash: string; size: number }[];
    createdFiles: { filePath: string }[];
    evictedFiles: { filePath: string; reason: string }[];
  } | null>;
  rewind(params: {
    messageId: string;
    filesToRestore: { filePath: string; contentHash: string; size: number }[];
    filesToDelete: { filePath: string }[];
    forkTitle: string;
  }): Promise<{
    restoredCount: number;
    deletedCount: number;
    failedRestoreCount: number;
    failedDeleteCount: number;
  } | null>;
  listTools(): Promise<SessionTool[]>;
  /**
   * Narrow this session's tool policy for the phase about to run, and apply it
   * now. Optional by design: a transport that cannot enforce a narrowing simply
   * does not implement it, and `AgentSession` fails closed rather than running
   * the phase with more tools than it asked for.
   */
  setPhaseToolPolicy?(policy: ToolPolicySpec | null): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  kill(): void;
  spawnArgs(): string[];
  readonly id: string | null;
  readonly alive: boolean;
  readonly pid: number | undefined;
  readonly lastUserMessageId: string | null;
  readonly availableModels: AvailableModel[];
  readonly activeModel: string;
}

/** Options both transports accept from AgentSession. */
export interface TransportSessionOptions {
  cwd: string;
  /** The run this session belongs to — used to register the child for killRun(). */
  runId?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  restrictTools?: string[];
  disabledTools?: string[];
  userMcpServers?: UserMcpServer[];
  /**
   * Host skills this agent did not select. Their tool ids are resolved off the
   * live tool list and added to the disabled complement, because a skill cannot
   * be withheld at spawn time the way a Droid or an MCP server can.
   */
  hiddenSkills?: { id: string; name: string }[];
  /**
   * The agent's system tool profile. Absent reads as `full`. `restrictTools`
   * remains the back-compatible way to say `custom`.
   */
  toolPolicy?: ToolPolicySpec;
  /**
   * Env overrides for anything this session spawns — the ephemeral `HOME` of a
   * `FactoryHomeOverlay` when this agent runs with host Droids or MCP servers
   * withheld. Absent means the session spawns with the app's own env.
   */
  spawnEnvOverrides?: Record<string, string>;
  onPermission: (ask: PermissionAsk) => PermissionDecision | Promise<PermissionDecision>;
  onNotification?: (n: DroidNotification) => void;
  onExit?: (code: number | null) => void;
  onStderr?: (text: string) => void;
  onModelWarning?: (warning: string) => void;
}
