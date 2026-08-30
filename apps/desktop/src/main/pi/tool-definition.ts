/**
 * The vendor tool-definition surface, re-exported through the pi seam.
 *
 * Modules outside this directory (Smith's entity tools, for one) define pi
 * tools but may not name `@earendil-works/pi-*` — the ESLint
 * `no-restricted-imports` boundary keeps the runtime replaceable. The type
 * still comes from the vendor; `defineTool` is a local identity so importing
 * this file does not parse the agent runtime. A runtime swap still costs one
 * directory.
 */

export type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/**
 * Preserve parameter inference for standalone tool definitions.
 *
 * Pi's `defineTool` is the same identity; keeping it local is what lets Smith
 * tool modules load at app start without pulling the vendor package.
 */
export function defineTool<T>(tool: T): T {
  return tool;
}
