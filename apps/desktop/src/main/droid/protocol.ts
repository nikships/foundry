/**
 * Wire shape of droid's stream-JSON-RPC surface, as observed against the CLI.
 * Three load-bearing details:
 *
 *  1. Every message carries a `type` discriminator alongside `jsonrpc` and the
 *     Factory version fields; a plain JSON-RPC frame is rejected as -32700.
 *  2. Request `id` must be a string (numeric ids are rejected the same way).
 *  3. Session settings (model, reasoning effort, autonomy) are FLAT params on
 *     `droid.update_session_settings`, not nested under `settings`. CLI -m and
 *     --auto do not configure an RPC session, so model substitution travels here.
 */

export const FACTORY_API_VERSION = '1.0.0';
export const FACTORY_PROTOCOL_VERSION = '1.151.0';

/**
 * The one autonomy level Foundry runs at. Foundry pipelines are unattended by
 * design, so it is a constant rather than a setting — and it is always sent
 * explicitly: omitting `autonomyLevel` happens to default to high, which is
 * exactly why it is never omitted. Safety is post-hoc and code-owned (write
 * boundaries, protected paths), not a level the CLI enforces for us.
 */
export const AUTONOMY_LEVEL = 'high';

export interface RpcNotification {
  jsonrpc: '2.0';
  type: 'notification';
  method: string;
  params: { sessionId?: string; notification: DroidNotification };
}

// ── notification payloads ────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
  factoryCredits?: number;
}

export interface ToolUse {
  type: string;
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

export type DroidNotification =
  | { type: 'settings_updated'; requestId?: string; settings: SessionSettings }
  | { type: 'droid_working_state_changed'; newState: string }
  | { type: 'assistant_text_delta'; messageId: string; blockIndex: number; textDelta: string }
  | { type: 'assistant_text_complete'; messageId: string; blockIndex: number }
  | { type: 'thinking_text_delta'; messageId: string; textDelta: string }
  | { type: 'thinking_text_complete'; messageId: string }
  | { type: 'tool_call'; toolUse: ToolUse }
  | { type: 'tool_result'; toolUseId: string; content?: string; isError?: boolean }
  | { type: 'tool_execution_phase_changed'; toolUseId: string; toolName: string; phase: string }
  | {
      type: 'session_token_usage_changed';
      sessionId: string;
      tokenUsage: TokenUsage;
      inclusiveTokenUsage?: TokenUsage;
    }
  | { type: 'create_message'; message: DroidMessage }
  | {
      type: 'agent_turn_completed';
      reason: string;
      turnId: string;
      tokenUsage?: TokenUsage;
      cumulativeTokenUsage?: TokenUsage;
    }
  | { type: string; [key: string]: unknown };

export interface DroidMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: { type: string; text?: string; thinking?: string; name?: string; input?: unknown }[];
  modelId?: string;
  visibility?: string;
}

export interface SessionSettings {
  modelId?: string;
  reasoningEffort?: string;
  autonomyLevel?: string;
  autonomyMode?: string;
  interactionMode?: string;
  additionalToolIds?: string[];
  enabledToolIds?: string[];
  disabledToolIds?: string[];
  restrictToolIds?: string[];
}

export interface AvailableModel {
  id: string;
  modelId: string;
  modelProvider: string;
  displayName: string;
  shortDisplayName?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  deprecated?: boolean;
  isCustom?: boolean;
  tokenMultiplier?: number;
}

export interface InitializeSessionResult {
  sessionId: string;
  hostId?: string;
  settings: SessionSettings;
  availableModels?: AvailableModel[];
}

export interface ListToolsResult {
  tools: {
    id: string;
    llmId: string;
    displayName: string;
    description: string;
    category: string;
    defaultAllowed: boolean;
    currentlyAllowed?: boolean;
  }[];
}

export interface ContextStatsResult {
  used: number;
  remaining: number;
  limit: number;
  accuracy?: string;
}

/** Reasoning efforts droid accepts beyond the four Foundry exposes. */
export const EFFORT_ALIASES: Record<string, string> = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
};

export function sumUsage(u: TokenUsage | undefined): number {
  if (!u) return 0;
  return (
    (u.inputTokens ?? 0) +
    (u.outputTokens ?? 0) +
    (u.cacheCreationTokens ?? 0) +
    (u.cacheReadTokens ?? 0)
  );
}
