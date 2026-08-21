/**
 * Shared createAgentSession setup for the long-lived transport and the
 * one-shot. The two used to copy this block; a flag that exists in one and
 * not the other is how discovery leaks back in.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  SettingsManager,
  type AgentSession as PiAgentSession,
  type ExtensionFactory,
  type ModelRuntime,
  type SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { PiModel, PiThinkingLevel } from './model.js';

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
}): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    settingsManager: opts.settingsManager,
    // Discovery is off: an agent's tools, prompt, and policy come from the
    // roster and this directory. Context files (AGENTS.md walking to /) and
    // .pi/APPEND_SYSTEM.md are prompt injection if left on.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => opts.harness,
    appendSystemPromptOverride: () => [],
    extensionFactories: [{ name: 'foundry', factory: opts.extensionFactory, hidden: true }],
  });
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
  onExtensionError?: (message: string) => void;
}): Promise<{ session: PiAgentSession; modelFallbackMessage?: string }> {
  await input.resourceLoader.reload();
  const created = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    modelRuntime: input.modelRuntime,
    ...(input.model ? { model: input.model } : {}),
    thinkingLevel: input.thinkingLevel,
    tools: [...input.tools],
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
  return {
    session: created.session,
    ...(created.modelFallbackMessage ? { modelFallbackMessage: created.modelFallbackMessage } : {}),
  };
}
