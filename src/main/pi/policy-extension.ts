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

import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { readPhaseContextTool, reportProgressTool, type EnvelopeTool } from './tools.js';
import type { FoundryToolContext, PermissionAsk, PermissionDecision } from './transport.js';

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
  useEnvelopeTool(tool: EnvelopeTool | null): void;
}

export function foundryExtension(opts: FoundryExtensionOptions): FoundryExtensionHandle {
  let api: ExtensionAPI | null = null;
  let pending: EnvelopeTool | null = null;

  const install = (tool: EnvelopeTool | null): void => {
    if (!api || !tool) return;
    api.registerTool(tool.definition);
  };

  const factory: ExtensionFactory = (pi) => {
    api = pi;
    pi.registerTool(reportProgressTool(opts.tools));
    pi.registerTool(readPhaseContextTool(opts.tools));
    install(pending);

    // Everything the model asks for passes through here, including Foundry's
    // own tools: a policy with a hole in it is not a policy.
    pi.on('tool_call', async (event) => {
      const decision = await opts.decide({
        tool: event.toolName,
        input: { ...event.input },
        ...commandOf(event.input),
        ...pathOf(event.input),
      });
      if (decision.outcome === 'allow') return;
      return { block: true, reason: decision.reason };
    });
  };

  return {
    factory,
    useEnvelopeTool(tool) {
      pending = tool;
      install(tool);
    },
  };
}

function commandOf(input: Record<string, unknown>): { command?: string } {
  const command = input.command;
  return typeof command === 'string' ? { command } : {};
}

function pathOf(input: Record<string, unknown>): { path?: string } {
  const path = input.path;
  return typeof path === 'string' ? { path } : {};
}
