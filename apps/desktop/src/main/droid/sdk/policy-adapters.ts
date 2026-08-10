/**
 * SDK permission/ask_user adapters shared by SdkSession and DaemonSession.
 *
 * The engine policy speaks allow/deny; the SDK speaks selections. The SDK also
 * validates handler selections against params.options and silently converts an
 * unoffered selection to cancel — so an allow must never return a bare enum
 * value without checking what the ask offered (proceedOption).
 */

import {
  ToolConfirmationOutcome,
  type AskUserRequestParams,
  type AskUserResult,
  type RequestPermissionHandlerResult,
  type RequestPermissionRequestParams,
} from '@factory/droid-sdk';
import type { PermissionAsk, PermissionDecision } from '../turn.js';

/** Every selection that lets the tool run, i.e. what an `allow` may answer. */
export type ProceedOutcome = Exclude<ToolConfirmationOutcome, ToolConfirmationOutcome.ProceedEdit>;

/**
 * The policy reads a flat ask (`toolName`, `command`, `file_path`); the SDK
 * nests the same facts one level down and splits them across `toolUse.input`
 * and the typed confirmation `details`.
 */
export function flattenToolUse(params: RequestPermissionRequestParams): Record<string, unknown> {
  const first = params.toolUses?.[0];
  if (!first) return { ...params } as unknown as Record<string, unknown>;
  const details = first.details as Record<string, unknown>;
  return {
    toolName: first.toolUse.name,
    ...first.toolUse.input,
    ...(typeof details.command === 'string' ? { command: details.command } : {}),
    ...(typeof details.filePath === 'string' ? { file_path: details.filePath } : {}),
  };
}

/**
 * The SDK answers `cancel` for any selection the ask did not offer, so an
 * allow that names an unavailable option lands as a silent denial. Asks
 * normally offer `proceed_once`; take whatever proceed they do offer instead
 * of assuming, and never fall back to a selection that stops the tool.
 */
export function proceedOption(params: RequestPermissionRequestParams): ProceedOutcome {
  const offered = params.options?.map((option) => option.value) ?? [];
  if (offered.includes(ToolConfirmationOutcome.ProceedOnce)) {
    return ToolConfirmationOutcome.ProceedOnce;
  }
  // ProceedEdit is left out because it is only answerable with edited content.
  const proceed = offered.filter(
    (value): value is ProceedOutcome =>
      value !== ToolConfirmationOutcome.Cancel && value !== ToolConfirmationOutcome.ProceedEdit,
  );
  return proceed[0] ?? ToolConfirmationOutcome.ProceedOnce;
}

/** Map a policy decision onto the SDK permission handler result. */
export function toPermissionHandlerResult(
  decision: PermissionDecision,
  params: RequestPermissionRequestParams,
): RequestPermissionHandlerResult {
  if (decision.outcome !== 'allow') {
    return {
      selectedOption: ToolConfirmationOutcome.Cancel,
      comment: decision.reason ?? 'denied by policy',
    };
  }
  return proceedOption(params);
}

/**
 * `cancelled` is never used for an ordinary question: the CLI reads it as a
 * refusal and the agent asks again, which is exactly the stall the policy
 * exists to prevent.
 */
export function toAskUserResult(decision: PermissionDecision): AskUserResult {
  if (decision.outcome === 'allow' && decision.answers) return { answers: decision.answers };
  return { cancelled: true, answers: [] };
}

/** Build the PermissionAsk the engine policy expects from an SDK permission request. */
export function toPermissionAsk(params: RequestPermissionRequestParams): PermissionAsk {
  return {
    method: 'droid.request_permission',
    params: flattenToolUse(params),
  };
}

/** Build the PermissionAsk the engine policy expects from an SDK ask_user request. */
export function toAskUserAsk(params: AskUserRequestParams): PermissionAsk {
  return {
    method: 'droid.ask_user',
    params: params as unknown as Record<string, unknown>,
  };
}
