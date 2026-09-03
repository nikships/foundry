/**
 * Shared createAgentSession setup for the long-lived transport and the
 * one-shot. The two used to copy this block; a flag that exists in one and
 * not the other is how discovery leaks back in.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession as PiAgentSession,
  type ExtensionFactory,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { ContextBreakdown } from '@shared/types.js';
import type { PiModel, PiThinkingLevel } from './model.js';
import type { ContextStats } from './transport.js';
import { lastAssistantStop } from './vendor-events.js';

/** In-memory settings: engine owns compaction, the runtime may retry a flap. */
export function foundrySettings(): SettingsManager {
  return SettingsManager.inMemory(
    {
      compaction: { enabled: false },
      // This is connection liveness, not a turn deadline. A silent provider
      // stream becomes a retryable timeout while the overall run stays alive.
      httpIdleTimeoutMs: 300_000,
      retry: {
        enabled: true,
        maxRetries: 5,
        baseDelayMs: 2_000,
        // One semantic retry loop owns the budget. Provider retries here would
        // multiply the attempts invisibly before Pi's surfaced backoff begins.
        provider: { maxRetries: 0 },
      },
    },
    { projectTrusted: true },
  );
}

export function foundryResourceLoader(opts: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  /** Replaces Pi's default "you are pi" system prompt. */
  harness: string;
  extensionFactory: ExtensionFactory;
  /**
   * Resolved paths from the packages this build ships, filtered to what this
   * session type may load. They ride the additional-path channel, which pi
   * honours even while discovery is off — so what Foundry named loads and a
   * cloned repository's `.pi/` still cannot.
   */
  packageResources?: { extensionPaths: string[]; skillPaths: string[] };
}): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    settingsManager: opts.settingsManager,
    // Discovery is off: an agent's tools, prompt, and policy come from the
    // roster and this directory. Context files (AGENTS.md walking to /) and
    // .pi/APPEND_SYSTEM.md are prompt injection if left on. These flags stay
    // true with package resources present: the `no*` flags drop what pi
    // *discovered*, never what a caller named.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(opts.packageResources?.extensionPaths.length
      ? { additionalExtensionPaths: [...opts.packageResources.extensionPaths] }
      : {}),
    ...(opts.packageResources?.skillPaths.length
      ? { additionalSkillPaths: [...opts.packageResources.skillPaths] }
      : {}),
    systemPromptOverride: () => opts.harness,
    appendSystemPromptOverride: () => [],
    extensionFactories: [{ name: 'foundry', factory: opts.extensionFactory, hidden: true }],
  });
}

/**
 * Tool names the loaded package extensions registered.
 *
 * Read after `reload()` and before `createAgentSession`, because the list
 * handed to that call *is* the registry allowlist: a package tool absent from
 * it does not exist for the session. Foundry's inline extension is skipped —
 * its tools are already named by `tool-names.ts`, and a session's own tools
 * must not be re-derived from whatever happened to load.
 */
export function packageToolNames(loader: DefaultResourceLoader): string[] {
  const names = new Set<string>();
  for (const extension of loader.getExtensions().extensions) {
    if (extension.path.startsWith('<inline:')) continue;
    for (const name of extension.tools.keys()) names.add(name);
  }
  return [...names];
}

export async function openFoundrySession(input: {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model?: PiModel | null;
  thinkingLevel: PiThinkingLevel;
  tools: readonly string[];
  resourceLoader: DefaultResourceLoader;
  settingsManager: SettingsManager;
  sessionManager: SessionManager;
  /**
   * Widen the allowlist to whatever the loaded package extensions registered.
   * Off by default, and never set for a read-only profile: the tool list is
   * the capability boundary, so a session that must not be able to write stays
   * at exactly the names Foundry chose.
   */
  allowPackageTools?: boolean;
  onExtensionError?: (message: string) => void;
}): Promise<{
  session: PiAgentSession;
  modelFallbackMessage?: string;
  /** Package-registered tools this session actually admitted, for the policy. */
  packageTools: string[];
}> {
  await input.resourceLoader.reload();
  // After reload, before create: the `tools` array is the registry allowlist,
  // so a package tool not named here would load and then not exist.
  const packageTools = input.allowPackageTools ? packageToolNames(input.resourceLoader) : [];
  const created = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime: input.modelRuntime,
    ...(input.model ? { model: input.model } : {}),
    thinkingLevel: input.thinkingLevel,
    tools: [...new Set([...input.tools, ...packageTools])],
    resourceLoader: input.resourceLoader,
    sessionManager: input.sessionManager,
    settingsManager: input.settingsManager,
  });
  // Bind before the first prompt: unbound, tools exist but tool_call is not live.
  await created.session.bindExtensions({
    mode: 'print',
    onError: (err) =>
      input.onExtensionError?.(`extension error (${err.extensionPath}): ${err.error}`),
  });
  for (const failure of input.resourceLoader.getExtensions().errors) {
    input.onExtensionError?.(`extension failed to load (${failure.path}): ${failure.error}`);
  }
  return {
    session: created.session,
    packageTools,
    ...(created.modelFallbackMessage ? { modelFallbackMessage: created.modelFallbackMessage } : {}),
  };
}

/**
 * Resume a session file when there is one, otherwise start a new session in
 * the given directory. A missing or unreadable session is a fresh start, not
 * a failed run. Sessions live with the caller's other records, never `~/.pi`.
 */
export async function openOrCreateSessionManager(
  cwd: string,
  sessionDir: string,
  existingSessionId?: string | null,
): Promise<SessionManager> {
  if (existingSessionId) {
    try {
      const listed = await SessionManager.list(cwd, sessionDir);
      const match = listed.find((entry) => entry.id === existingSessionId);
      if (match) return SessionManager.open(match.path, sessionDir, cwd);
    } catch {
      // A missing or unreadable session dir is a fresh start, not a failed run.
    }
  }
  return SessionManager.create(cwd, sessionDir);
}

/**
 * The live branch, not the append-only file: after a rewind the abandoned
 * leaf is still in getEntries() and must not become the next anchor.
 */
export function lastUserMessageId(session: PiAgentSession | null): string | null {
  if (!session) return null;
  const entries = session.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === 'message' && entry.message.role === 'user') return entry.id;
  }
  return null;
}

export function sessionContextStats(session: PiAgentSession | null): ContextStats | null {
  const usage = session?.getContextUsage();
  if (!usage) return null;
  const used = usage.tokens ?? 0;
  return {
    used,
    limit: usage.contextWindow,
    remaining: Math.max(0, usage.contextWindow - used),
  };
}

/**
 * Pi accounts for context as one estimate for the whole conversation rather
 * than by source, so the breakdown is the model and its occupancy and
 * nothing else.
 */
export function sessionContextBreakdown(
  session: PiAgentSession | null,
  resolvedModel: PiModel | null,
  activeModel: string,
): ContextBreakdown | null {
  const usage = session?.getContextUsage();
  if (!usage) return null;
  const model = session?.model ?? resolvedModel;
  const used = usage.tokens ?? 0;
  return {
    modelId: activeModel,
    modelDisplayName: model?.name ?? activeModel,
    contextBudget: usage.contextWindow,
    usedTokens: used,
    freeTokens: Math.max(0, usage.contextWindow - used),
  };
}

export async function compactSession(
  session: PiAgentSession | null,
): Promise<{ removedCount: number } | null> {
  if (!session) return null;
  const before = session.messages.length;
  await session.compact();
  return { removedCount: Math.max(0, before - session.messages.length) };
}

/** Abort if something is running, then dispose. Safe when nothing was running. */
export async function closeLiveSession(session: PiAgentSession | null): Promise<void> {
  if (!session) return;
  try {
    await session.abort();
  } catch {
    // Nothing was running; disposal is what matters.
  }
  session.dispose();
}

export function lastAssistantText(session: PiAgentSession): string {
  return (session.getLastAssistantText() ?? '').trim();
}

/**
 * Prompt, wait through retries, then optionally continue (failover). Throws if
 * the model ended the turn with an error. Discovery templates stay off.
 */
export async function promptUntilIdle(
  session: PiAgentSession,
  text: string,
  afterIdle?: () => Promise<void>,
): Promise<{ stopReason: string; errorMessage?: string } | null> {
  await session.prompt(text, { expandPromptTemplates: false, source: 'extension' });
  await session.waitForIdle();
  await afterIdle?.();
  const last = lastAssistantStop(session);
  if (last?.stopReason === 'error') {
    throw new Error(last.errorMessage || 'the model ended the turn with an error');
  }
  return last;
}
