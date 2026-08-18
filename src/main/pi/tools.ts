/**
 * Foundry's own tools, registered directly on the agent session.
 *
 * With the agent running in this process there is no MCP server to stand up, no
 * wire-prefixed ids (`foundry___report_progress`), and no second schema dialect
 * to keep in sync. A tool is a plain object with a JSON Schema and a function.
 *
 * Three tools, and none of them writes the worktree:
 * - `report_progress` traces a line for the Inspector timeline.
 * - `read_phase_context` reads back the validated envelope chain.
 * - `submit_envelope` is how a phase answers. Its schema is the phase's own
 *   envelope schema, so a conforming call always parses.
 *
 * `submit_envelope` accepts the answer but does not decide anything: the phase
 * still fails until code validates the envelope and the gates pass. Agents
 * propose; code disposes.
 */

import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Envelope } from '../engine/envelopes.js';
import type { FoundryToolContext } from './transport.js';

export const FOUNDRY_TOOL_NAMES = [
  'report_progress',
  'read_phase_context',
  'submit_envelope',
] as const;
export type FoundryToolName = (typeof FOUNDRY_TOOL_NAMES)[number];

/** Pi's built-ins. A phase runs all of them; none of them prompts a human. */
export const BUILTIN_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'] as const;

/**
 * The read-only subset, and the whole of what a detection or a setup session
 * gets. The tool list is the allowlist: an editing or shell tool is not merely
 * denied by policy, it is absent from the registry, so a session that runs
 * against the operator's own checkout has nothing that could write to it.
 */
export const READ_ONLY_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

/** One entry of the chain `read_phase_context` returns. */
export interface PhaseContextEntry {
  phase: string;
  envelope: Envelope;
}

/**
 * `TSchema` is an empty interface, so any JSON Schema object satisfies it
 * structurally — but `Static<TSchema>` then degrades to `unknown`, which is why
 * every `execute` below narrows its params by hand instead of trusting
 * inference.
 */
type AnyTool = ToolDefinition;

/** A tool answer is content plus details; Foundry's tools return plain text. */
function text(value: string): { content: [{ type: 'text'; text: string }]; details: undefined } {
  return { content: [{ type: 'text', text: value }], details: undefined };
}

function field(params: unknown, name: string): unknown {
  return params && typeof params === 'object'
    ? (params as Record<string, unknown>)[name]
    : undefined;
}

export function reportProgressTool(ctx: FoundryToolContext): AnyTool {
  return defineTool({
    name: 'report_progress',
    label: 'Progress',
    description:
      'Record a short progress update for the current Foundry phase. The update is traced for the operator; it does not affect phase acceptance.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line describing what just happened.' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    execute: (_id, params) => {
      const raw = field(params, 'summary');
      const summary = typeof raw === 'string' ? raw : String(raw ?? '');
      ctx.tracer.event({
        runId: ctx.runId,
        phaseId: ctx.phaseId(),
        type: 'log',
        name: `${ctx.agentName}: progress`,
        payload: { message: summary, summary },
      });
      return Promise.resolve(text('recorded'));
    },
  });
}

export function readPhaseContextTool(ctx: FoundryToolContext): AnyTool {
  return defineTool({
    name: 'read_phase_context',
    label: 'Phase context',
    description:
      'Return the validated envelope chain for the current Foundry run as JSON. Read-only; does not change any phase state.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => {
      const chain: PhaseContextEntry[] = [];
      for (const [phase, envelope] of ctx.envelopes()) chain.push({ phase, envelope });
      return Promise.resolve(text(JSON.stringify(chain)));
    },
  });
}

/** The tool plus the arguments the agent last submitted through it. */
export interface EnvelopeTool {
  definition: AnyTool;
  /** The most recent submission, or null when the turn never called the tool. */
  submitted(): Record<string, unknown> | null;
}

/**
 * The phase's answer channel, schema-constrained to that phase's envelope.
 *
 * The schema comes from `jsonSchemaFor` — the same schema the reply is parsed
 * against — so the tool call, the prompt example, and the parse cannot drift.
 * A call that conforms is a structured answer no text parse has to guess at;
 * `parseEnvelope` stays as the fallback for a turn that answers in prose.
 *
 * Built fresh per turn on purpose. pi-ai caches compiled validators in a
 * WeakMap keyed on the schema object's identity, so a phase-specific schema has
 * to arrive as a new definition object; mutating `parameters` in place would
 * keep the previous phase's validator.
 */
export function submitEnvelopeTool(schema: Record<string, unknown>): EnvelopeTool {
  let captured: Record<string, unknown> | null = null;

  const definition = defineTool({
    name: 'submit_envelope',
    label: 'Submit envelope',
    description:
      "Submit this phase's result envelope. Call this once, at the end of your work, with the final answer. Submitting does not complete the phase: Foundry validates the envelope and runs the phase gates afterwards.",
    parameters: schema,
    execute: (_id, params) => {
      captured = params && typeof params === 'object' ? (params as Record<string, unknown>) : null;
      return Promise.resolve(text('envelope received'));
    },
  });

  return { definition, submitted: () => captured };
}
