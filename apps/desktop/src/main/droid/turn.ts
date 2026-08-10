/**
 * What a turn is, independent of how it travels.
 *
 * `agent.ts` and `permissions.ts` sit above the transport and must not know
 * whether a turn ran over the SDK session or the one-shot child, so the shapes
 * both paths agree on live here rather than in either transport.
 */

import type { TokenUsage } from './protocol.js';

/** A roster entry may decline to pick a model and take droid's own default. */
export const INHERIT_MODEL = 'inherit';

/**
 * A JSON Schema the final message of one turn must conform to. Only the shape
 * travels here; where the schema comes from is the engine's business.
 */
export interface OutputFormat {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

export interface TurnOptions {
  /** Constrains the FINAL message only; mid-turn tool use is unaffected. */
  outputFormat?: OutputFormat;
}

export interface TurnResult {
  /** Final assistant text — what the envelope is parsed from. */
  text: string;
  usage: TokenUsage | null;
  reason: string;
  interrupted: boolean;
  /**
   * What the transport shaped for us, `null` when it could not or was never
   * asked. It is a candidate, never a verdict: the caller still parses it.
   */
  structuredOutput: Record<string, unknown> | null;
}

export interface PermissionAsk {
  method: 'droid.request_permission' | 'droid.ask_user';
  params: Record<string, unknown>;
}

/**
 * The whole of what a transport gets back for an ask — nothing else crosses
 * the seam, which is why `droid.ask_user` answers travel here rather than
 * beside the decision. An allow that reaches the wire without them is replied
 * to as `{cancelled:true}`, which the CLI reads as a refusal, and the agent
 * asks the same question again.
 */
export type PermissionDecision =
  | { outcome: 'allow'; answers?: { index: number; question: string; answer: string }[] }
  | { outcome: 'deny'; reason?: string };
