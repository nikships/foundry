/** Shared parsing and approval helpers for Smith's fixed domain tools. */

import type {
  SmithActionRisk,
  SmithPrivateDisplay,
  SmithProposalExecutionResult,
  SmithSecretRequest,
} from '@shared/types.js';
import type { MainInvoker } from '../ipc/shared.js';
import type { ProposalQueue } from './proposals.js';

export interface SmithActionToolDeps {
  invoke: MainInvoker;
  queue: ProposalQueue;
  projectId: () => string | undefined;
}

export type JsonToolResult = {
  content: [{ type: 'text'; text: string }];
  details: undefined;
};

export function json(value: unknown): JsonToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], details: undefined };
}

export function paramsRecord(params: unknown): Record<string, unknown> {
  return params != null && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

export function field(params: unknown, name: string): unknown {
  return paramsRecord(params)[name];
}

export function stringField(params: unknown, name: string): string | null {
  const value = field(params, name);
  return typeof value === 'string' && value.trim() ? value : null;
}

export function numberField(params: unknown, name: string): number | null {
  const value = field(params, name);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function booleanField(params: unknown, name: string): boolean | undefined {
  const value = field(params, name);
  return typeof value === 'boolean' ? value : undefined;
}

export function objectField(params: unknown, name: string): Record<string, unknown> | null {
  const value = field(params, name);
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringArrayField(params: unknown, name: string): string[] | null {
  const value = field(params, name);
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

export function parseOperation<const T extends readonly string[]>(
  params: unknown,
  operations: T,
): T[number] | null {
  const value = stringField(params, 'operation');
  return value && (operations as readonly string[]).includes(value) ? (value as T[number]) : null;
}

export type ProjectResolution =
  { ok: true; projectId: string | undefined } | { ok: false; error: string };

/** The same resolution for operations that cannot run without a project. */
export type RequiredProjectResolution =
  { ok: true; projectId: string } | { ok: false; error: string };

/** An explicit `projectId` argument wins over the conversation's own scope. */
export function resolveProjectId(
  explicit: unknown,
  sessionProjectId: string | undefined,
): ProjectResolution {
  if (explicit !== undefined && (typeof explicit !== 'string' || !explicit.trim())) {
    return { ok: false, error: 'projectId must be a non-empty string' };
  }
  return { ok: true, projectId: typeof explicit === 'string' ? explicit : sessionProjectId };
}

export function requireProjectId(
  explicit: unknown,
  sessionProjectId: string | undefined,
): RequiredProjectResolution {
  const resolved = resolveProjectId(explicit, sessionProjectId);
  if (!resolved.ok) return resolved;
  return resolved.projectId
    ? { ok: true, projectId: resolved.projectId }
    : { ok: false, error: 'projectId is required in All projects scope' };
}

export async function immediate(
  deps: Pick<SmithActionToolDeps, 'invoke'>,
  channel: string,
  ...args: unknown[]
): Promise<JsonToolResult> {
  try {
    const result = await deps.invoke(channel, ...args);
    return json({ ok: true, result: result ?? null });
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) });
  }
}

export interface ActionRequest {
  operation: string;
  title: string;
  summary: string;
  args: Record<string, unknown>;
  risk: SmithActionRisk;
  secretRequest?: SmithSecretRequest;
  execute: (
    secret?: string,
  ) => Promise<{ modelResult: unknown; privateDisplay?: SmithPrivateDisplay } | unknown>;
}

export async function proposeAction(
  deps: Pick<SmithActionToolDeps, 'queue' | 'projectId'>,
  request: ActionRequest,
): Promise<JsonToolResult> {
  const projectId = deps.projectId();
  try {
    const outcome = await deps.queue.propose(
      {
        type: 'action',
        operation: request.operation,
        title: request.title,
        summary: request.summary,
        args: request.args,
        risk: request.risk,
        ...(projectId ? { projectId } : {}),
        ...(request.secretRequest ? { secretRequest: request.secretRequest } : {}),
      },
      async (answer) => {
        try {
          return executionResult(await request.execute(answer.secret));
        } catch (error) {
          return { ok: false, error: errorMessage(error) };
        }
      },
    );
    if (!outcome.approved) {
      return json({ ok: false, rejected: true, ...(outcome.note ? { note: outcome.note } : {}) });
    }
    return json(outcome.result);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) });
  }
}

/**
 * Reads what an executor returned. A `{ modelResult }` shape splits the model's
 * answer from an operator-only display; anything else is the handler's own
 * return value, which may itself carry a failure the model must see.
 */
function executionResult(raw: unknown): SmithProposalExecutionResult {
  if (raw != null && typeof raw === 'object' && 'modelResult' in raw) {
    const split = raw as { modelResult: unknown; privateDisplay?: SmithPrivateDisplay };
    return {
      ok: true,
      modelResult: split.modelResult,
      ...(split.privateDisplay ? { privateDisplay: split.privateDisplay } : {}),
    };
  }
  const failure = failureMessage(raw);
  return failure
    ? { ok: false, error: failure }
    : { ok: true, modelResult: { ok: true, result: raw ?? null } };
}

const SECRET_FIELD = /^(api[_-]?key|key|token|secret)$/i;

export function rejectSecretFields(params: unknown): string | null {
  const found = Object.keys(paramsRecord(params)).find((name) => SECRET_FIELD.test(name));
  return found ? `${found} must be entered only in the masked approval card` : null;
}

function failureMessage(value: unknown): string | null {
  if (value === false) return 'action returned false';
  if (value == null || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.ok !== false && typeof result.error !== 'string') return null;
  if (typeof result.error === 'string') return result.error;
  if (typeof result.detail === 'string') return result.detail;
  if (Array.isArray(result.issues)) return JSON.stringify(result.issues);
  return 'action failed';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
