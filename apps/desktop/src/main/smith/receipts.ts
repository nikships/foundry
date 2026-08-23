/**
 * Action receipts: durable evidence that an approved action actually ran.
 *
 * A design artifact is the model's account of something it wants to do. A
 * receipt is the opposite — main mints it here from the executor's own result
 * on the proposal answer path, so the transcript cannot claim an action
 * Foundry never performed. Approval is not success: a refused or failed
 * execution produces a receipt too, carrying the executor's words.
 *
 * Nothing in a receipt is live. It holds a snapshot plus identifiers, no
 * closure and no retry affordance, so restoring one after a relaunch cannot
 * re-run anything or offer a button that silently does nothing.
 */

import { randomUUID } from 'node:crypto';
import {
  SMITH_ARTIFACT_VERSION,
  type SmithActionProposal,
  type SmithActionReceipt,
  type SmithActionReceiptArtifact,
  type SmithReceiptLink,
} from '@shared/types.js';

/** Ceiling on the executor's failure text; the full error stays in the model result. */
const MAX_FAILURE = 600;
/** Ceiling on one restated argument value, so a long prompt cannot bloat the card. */
const MAX_ARG_VALUE = 200;

/** What the queue observed when it ran an approved action. */
export interface ActionExecutionRecord {
  outcome: 'succeeded' | 'failed';
  /** Executor wall time, not the time the card spent waiting on a human. */
  durationMs: number;
  /** The executor's own words. Read only when the outcome is `failed`. */
  error?: string;
  /**
   * The value the executor returned to the model. Read only to recover an
   * affected object's coordinates (a PR url, a started run id); never shown raw.
   */
  result?: unknown;
}

/**
 * Argument keys that name what an action ran against, most specific first.
 * A receipt has to say what was touched even when the operation is unfamiliar,
 * so this is a preference order rather than a per-operation table.
 */
const TARGET_KEYS = [
  'runId',
  'prNumber',
  'pipelineId',
  'name',
  'id',
  'from',
  'emblem',
  'deviceId',
  'providerId',
  'provider',
  'filePath',
  'projectId',
] as const;

/** A short, human value for one restated argument. */
function argText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * What the action ran against, in the operator's terms. Derived from the
 * proposal's already-redacted args, so a receipt cannot introduce a value the
 * approval card did not show.
 */
export function receiptTarget(proposal: SmithActionProposal): string {
  for (const key of TARGET_KEYS) {
    const value = proposal.args[key];
    if (value === undefined || value === null || value === '') continue;
    const text = argText(value);
    if (!text) continue;
    return key === 'prNumber' ? `PR #${text}` : clamp(text, MAX_ARG_VALUE);
  }
  return proposal.projectId ? `project ${proposal.projectId}` : 'Foundry';
}

/** A plain record of the approved args, each value bounded for display. */
function restateArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === 'string' ? clamp(value, MAX_ARG_VALUE) : value;
  }
  return out;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The executor's payload, unwrapped one level. Handlers reached through
 * `smith_*` tools answer as the handler's own value; `immediate`-style wrappers
 * nest it under `result`.
 */
function payload(result: unknown): Record<string, unknown> | null {
  const top = record(result);
  if (!top) return null;
  return record(top.result) ?? top;
}

/**
 * Where the affected object can be found afterwards, as identifiers only.
 *
 * Derived from what the executor returned rather than from the model's account
 * of it, and deliberately incomplete: an operation whose result names nothing
 * addressable gets no link instead of a guess that 404s later.
 */
export function receiptLink(
  proposal: SmithActionProposal,
  result: unknown,
): SmithReceiptLink | undefined {
  const data = payload(result);
  const url = data && typeof data.url === 'string' ? data.url : null;
  if (url) {
    return { kind: 'url', label: url.includes('/pull/') ? 'View pull request' : 'Open', url };
  }

  const projectId =
    typeof proposal.args.projectId === 'string' ? proposal.args.projectId : proposal.projectId;
  const runId =
    (data && typeof data.runId === 'string' ? data.runId : null) ??
    (typeof proposal.args.runId === 'string' ? proposal.args.runId : null);
  if (projectId && runId) return { kind: 'run', label: 'Open run', projectId, runId };

  const entity = entityKindOf(proposal.operation);
  const name = typeof proposal.args.to === 'string' ? proposal.args.to : nameArg(proposal.args);
  if (entity && name) return { kind: 'entity', label: `Open ${entity}`, entity, name };
  return undefined;
}

function nameArg(args: Record<string, unknown>): string | null {
  for (const key of ['name', 'id'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * The entity an operation edits, when it edits one. A removal is excluded on
 * purpose: linking to a definition the action just deleted is a dead end.
 */
function entityKindOf(operation: string): 'agent' | 'pipeline' | 'envelope' | null {
  if (operation.endsWith('_remove') || operation.endsWith('_remove_mark')) return null;
  if (operation.startsWith('agent_')) return 'agent';
  if (operation.startsWith('pipeline_')) return 'pipeline';
  if (operation.startsWith('envelope_')) return 'envelope';
  return null;
}

/**
 * Mint the receipt for one settled action. Called by the queue with what the
 * executor actually did, never with what the model asked for.
 */
export function buildActionReceipt(
  proposal: SmithActionProposal,
  execution: ActionExecutionRecord,
): SmithActionReceiptArtifact {
  const failed = execution.outcome === 'failed';
  const receipt: SmithActionReceipt = {
    operation: proposal.operation,
    title: proposal.title,
    target: receiptTarget(proposal),
    consequences: proposal.summary,
    risk: proposal.risk,
    outcome: execution.outcome,
    durationMs: Math.max(0, Math.round(execution.durationMs)),
    ...(failed ? { failure: clamp(execution.error ?? 'the action failed', MAX_FAILURE) } : {}),
    // A failed action changed nothing worth linking to, and its result may
    // name a half-created object.
    ...(failed ? {} : linkEntry(proposal, execution.result)),
    args: restateArgs(proposal.args),
  };
  return {
    id: randomUUID(),
    version: SMITH_ARTIFACT_VERSION,
    createdAt: Date.now(),
    ...(proposal.projectId ? { projectId: proposal.projectId } : {}),
    kind: 'action_receipt',
    warnings: [],
    receipt,
  };
}

function linkEntry(
  proposal: SmithActionProposal,
  result: unknown,
): { link: SmithReceiptLink } | Record<string, never> {
  const link = receiptLink(proposal, result);
  return link ? { link } : {};
}
