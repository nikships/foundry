/**
 * The Foundry extension: Foundry's tools and Foundry's policy, in-process.
 *
 * Pi has no permission handler to install — the enforcement point is the
 * `tool_call` event, which runs before a tool executes and can block it. So
 * the policy lives in an inline extension rather than a callback on the
 * session, and a denied call comes back to the model as an error result naming
 * the reason, which is how the agent learns to try something else.
 *
 * `submit_envelope` changes shape per phase, so this also owns re-registering
 * it. Registration goes through `pi.registerTool`, which replaces the tool by
 * name and rebuilds the registry: pi-ai caches compiled validators against the
 * schema object's identity, so a swap must hand over a whole new definition.
 * Only ever between turns; mid-turn the agent is looking at the old schema.
 */

import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  gitDiffTool,
  readPhaseContextTool,
  reportProgressTool,
  type SubmissionTool,
} from './tools.js';
import type { FoundryToolContext, PermissionAsk, PermissionDecision } from './transport.js';

/** Per-turn system role text, applied through `before_agent_start`. */
interface SystemPromptSlot {
  useSystemPrompt(text: string | null): void;
  apply(pi: ExtensionAPI): void;
}

function systemPromptSlot(): SystemPromptSlot {
  let pending: string | null = null;
  return {
    useSystemPrompt(text) {
      pending = text?.trim() ? text : null;
    },
    apply(pi) {
      pi.on('before_agent_start', (event) => {
        if (!pending) return;
        // Append the roster / one-shot role to Pi's built prompt (Foundry
        // harness + cwd). Returning nothing would reset to the harness alone.
        return { systemPrompt: `${event.systemPrompt}\n\n${pending}` };
      });
    },
  };
}

export interface FoundryExtensionOptions {
  tools: FoundryToolContext;
  /**
   * Rules on every call and traces the verdict. The session owns this, so the
   * policy that answers here is the same one the trace records.
   */
  decide: (ask: PermissionAsk) => PermissionDecision | Promise<PermissionDecision>;
}

/** What the transport keeps so it can swap the envelope tool between turns. */
export interface FoundryExtensionHandle {
  factory: ExtensionFactory;
  /**
   * Install this phase's `submit_envelope`. A no-op until the extension has
   * bound, which is when `pi` exists to register against.
   */
  useEnvelopeTool(tool: SubmissionTool | null): void;
  /**
   * Standing role for the next turn. Applied in `before_agent_start` so it
   * stays in the system role instead of being stuffed into the user message.
   */
  useSystemPrompt(text: string | null): void;
}

function makePolicyExtension(
  decide: FoundryExtensionOptions['decide'],
  bind?: (pi: ExtensionAPI) => void,
): {
  factory: ExtensionFactory;
  useSystemPrompt(text: string | null): void;
} {
  const system = systemPromptSlot();
  return {
    factory: (pi) => {
      bind?.(pi);
      installPolicy(pi, decide);
      system.apply(pi);
    },
    useSystemPrompt(text) {
      system.useSystemPrompt(text);
    },
  };
}

export function foundryExtension(opts: FoundryExtensionOptions): FoundryExtensionHandle {
  let api: ExtensionAPI | null = null;
  let pending: SubmissionTool | null = null;
  const base = makePolicyExtension(opts.decide, (pi) => {
    api = pi;
    pi.registerTool(reportProgressTool(opts.tools));
    pi.registerTool(readPhaseContextTool(opts.tools));
    pi.registerTool(gitDiffTool(opts.tools));
    if (pending) pi.registerTool(pending.definition);
  });

  return {
    factory: base.factory,
    useEnvelopeTool(tool) {
      pending = tool;
      if (api && tool) api.registerTool(tool.definition);
    },
    useSystemPrompt: base.useSystemPrompt,
  };
}

/**
 * The policy without Foundry's run tools, for a session that has no phase.
 * A caller may supply one schema-bound result tool; writes are still ruled on.
 */
export function policyOnlyExtension(
  decide: FoundryExtensionOptions['decide'],
  outputTool?: SubmissionTool,
): {
  factory: ExtensionFactory;
  useSystemPrompt(text: string | null): void;
} {
  return makePolicyExtension(decide, (pi) => {
    if (outputTool) pi.registerTool(outputTool.definition);
  });
}

/**
 * The extension Smith's chat session binds: the caller's own tools (entity /
 * readiness, defined through the `tool-definition.ts` seam), the policy hook,
 * and the per-turn system slot that carries the screen context. No envelope
 * tool — a chat has no phase to answer for.
 */
export function smithExtension(opts: {
  tools: readonly ToolDefinition[];
  decide: FoundryExtensionOptions['decide'];
}): {
  factory: ExtensionFactory;
  useSystemPrompt(text: string | null): void;
} {
  return makePolicyExtension(opts.decide, (pi) => {
    for (const tool of opts.tools) pi.registerTool(tool);
  });
}

/**
 * Everything the model asks for passes through here, including Foundry's own
 * tools: a policy with a hole in it is not a policy.
 */
function installPolicy(pi: ExtensionAPI, decide: FoundryExtensionOptions['decide']): void {
  pi.on('tool_call', async (event) => {
    const decision = await decide({
      tool: event.toolName,
      input: { ...event.input },
      ...commandOf(event.input),
      ...pathOf(event.input),
    });
    if (decision.outcome === 'allow') return;
    return { block: true, reason: decision.reason };
  });
}

function commandOf(input: Record<string, unknown>): { command?: string } {
  const command = input.command;
  return typeof command === 'string' ? { command } : {};
}

function pathOf(input: Record<string, unknown>): { path?: string } {
  const path = input.path;
  return typeof path === 'string' ? { path } : {};
}
