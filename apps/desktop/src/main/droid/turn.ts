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

export interface TurnResult {
  /** Final assistant text — what the envelope is parsed from. */
  text: string;
  usage: TokenUsage | null;
  reason: string;
  interrupted: boolean;
}

export interface PermissionAsk {
  method: 'droid.request_permission' | 'droid.ask_user';
  params: Record<string, unknown>;
}

export type PermissionDecision =
  | { outcome: 'allow'; answers?: { index: number; question: string; answer: string }[] }
  | { outcome: 'deny'; reason?: string };
