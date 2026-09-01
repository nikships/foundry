/**
 * Tool allowlist names, kept free of the vendor package.
 *
 * `session.ts` and the policy tests need the Foundry tool names at import
 * time. Putting them here — rather than in `tools.ts`, which defines the
 * tools and used to pull `@earendil-works/pi-coding-agent` in with them —
 * means constructing `AppContext` no longer parses the agent runtime.
 */
import type { ToolProfile } from '@shared/types.js';

export const FOUNDRY_TOOL_NAMES = [
  'report_progress',
  'read_phase_context',
  'git_diff',
  'submit_envelope',
] as const;
export type FoundryToolName = (typeof FOUNDRY_TOOL_NAMES)[number];
/** Schema-bound answer channel for one-shot helpers such as the Orchestrator. */
export const ONESHOT_OUTPUT_TOOL_NAME = 'submit_result';

/** Pi's built-ins. A phase runs all of them; none of them prompts a human. */
export const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * The read-only subset, and the whole of what a detection or a setup session
 * gets. The tool list is the allowlist: an editing or shell tool is not merely
 * denied by policy, it is absent from the registry, so a session that runs
 * against the operator's own checkout has nothing that could write to it.
 */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/**
 * The whole allowlist a run session is opened with, for one agent's profile.
 *
 * Foundry's own tools are named alongside the built-ins because the list given
 * to `createAgentSession` *is* the registry. A `read-only` agent gets the read
 * subset: `edit`, `write`, and `bash` do not exist for it, which is the only
 * form of read-only this directory recognises.
 *
 * Foundry's tools are in both profiles, `git_diff` included. It reads history
 * the agent could already read through `read`, cannot run anything else, and is
 * strictly narrower than the `bash` a full-surface agent already has.
 */
export function runToolsFor(profile: ToolProfile | undefined): string[] {
  const builtins = profile === 'read-only' ? READ_ONLY_TOOLS : BUILTIN_TOOLS;
  return [...builtins, ...FOUNDRY_TOOL_NAMES];
}
