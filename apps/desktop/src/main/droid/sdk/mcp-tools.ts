/**
 * In-process Foundry MCP server attached to every droid session.
 *
 * Two tools only: progress is traced for the Inspector timeline, and the
 * envelope chain is readable mid-run. Neither writes the worktree, and neither
 * is a gate or acceptance signal — agents propose; code still disposes.
 *
 * SPIKE V8: the schema-less `tool()` overload is defective in SDK 0.7.0
 * (no inputSchema → handler gets the MCP extra context and fires twice).
 * Only the typed overload with the nested zod 3 from `sdk-zod.ts` is used.
 *
 * CRITICAL: attach via init-time `mcpServers` on create/resume. Never call
 * `session.addMcpServer()` — that permanently writes `~/.factory/mcp.json`.
 */

import { createSdkMcpServer, tool, type SdkMcpServer } from '@factory/droid-sdk/node';
import type { Envelope } from '../../engine/envelopes.js';
import type { Tracer } from '../../trace/tracer.js';
import { z } from './sdk-zod.js';

/** Server name as registered with the CLI; wire tool ids are `${name}___${tool}`. */
export const FOUNDRY_MCP_SERVER_NAME = 'foundry';

export const FOUNDRY_TOOL_NAMES = ['report_progress', 'read_phase_context'] as const;
export type FoundryToolName = (typeof FOUNDRY_TOOL_NAMES)[number];

/**
 * `listTools()` ids for the foundry tools. The allowlist complement must keep
 * these allowed even when a roster sets `restrictTools`.
 */
export const FOUNDRY_TOOL_IDS = FOUNDRY_TOOL_NAMES.map(
  (name) => `${FOUNDRY_MCP_SERVER_NAME}___${name}`,
);

/** What the handlers close over — Tracer + the live run's phase context. */
export interface FoundryMcpContext {
  runId: string;
  agentName: string;
  /** Current phase id for the trace row; null before the first turn. */
  phaseId: () => string | null;
  /** Validated envelopes for this run, keyed by phase name, insertion order. */
  envelopes: () => ReadonlyMap<string, Envelope>;
  tracer: Pick<Tracer, 'event'>;
}

/** One entry of the chain `read_phase_context` returns. */
export interface PhaseContextEntry {
  phase: string;
  envelope: Envelope;
}

/**
 * The SDK's `tool()` typings resolve `zod` against the app's zod 4, while the
 * runtime parse uses the nested zod 3 we pass here. Crossing those two type
 * graphs makes `tool()`'s generic explode (TS2589). The cast keeps the typed
 * four-arg overload at runtime without asking tsc to unify the two zods.
 */
type SdkTool = ReturnType<typeof tool>;
type SdkToolFactory = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: (input: Record<string, unknown>) => string | Promise<string>,
) => SdkTool;
const typedTool = tool as unknown as SdkToolFactory;

export function createFoundryMcpServer(ctx: FoundryMcpContext): SdkMcpServer {
  return createSdkMcpServer({
    name: FOUNDRY_MCP_SERVER_NAME,
    tools: [
      typedTool(
        'report_progress',
        'Record a short progress update for the current Foundry phase. The update is traced for the operator; it does not affect phase acceptance.',
        { summary: z.string() },
        (input) => {
          const summary = input.summary as string;
          ctx.tracer.event({
            runId: ctx.runId,
            phaseId: ctx.phaseId(),
            type: 'log',
            name: `${ctx.agentName}: progress`,
            payload: { message: summary, summary },
          });
          return 'recorded';
        },
      ),
      typedTool(
        'read_phase_context',
        'Return the validated envelope chain for the current Foundry run as JSON. Read-only; does not change any phase state.',
        {},
        () => {
          const chain: PhaseContextEntry[] = [];
          for (const [phase, envelope] of ctx.envelopes()) {
            chain.push({ phase, envelope });
          }
          return JSON.stringify(chain);
        },
      ),
    ],
  });
}
