/**
 * The vendor tool-definition surface, re-exported through the pi seam.
 *
 * Modules outside this directory (Smith's entity tools, for one) define pi
 * tools but may not name `@earendil-works/pi-*` — the ESLint
 * `no-restricted-imports` boundary keeps the runtime replaceable. This thin
 * re-export is the sanctioned crossing: it adds nothing, so a runtime swap
 * still costs one directory.
 */

export { defineTool } from '@earendil-works/pi-coding-agent';
export type { ToolDefinition } from '@earendil-works/pi-coding-agent';
