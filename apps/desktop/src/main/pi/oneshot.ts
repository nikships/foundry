/**
 * The one-shot seam: a whole agent turn that belongs to no run.
 *
 * Helpers in this app ask an agent one question and act on the answer —
 * repository context, command detection, setup-script generation, planning,
 * run-start command fill, rebase repair, and readiness. None is a pipeline:
 * there is no worktree to merge, no phase to fail, no envelope, no trace row.
 * What they need is a turn, a live transcript, and explicit cancellation.
 *
 * This file is the contract for that, and it names no vendor. `pi-oneshot.ts`
 * is the implementation; a test implements `OneShotFactory` directly and drives
 * the same call sites with no model, no credential, and no network.
 */

import type { PlanImageAttachment, ReasoningEffort } from '@shared/types.js';
import type {
  OutputFormat,
  PermissionAsk,
  PermissionDecision,
  TransportEvent,
  TurnUsage,
} from './transport.js';

export interface OneShotOptions {
  /** Where the agent runs. Read-only callers pass the operator's checkout. */
  cwd: string;
  /** Model id, or `inherit` to let this install choose. */
  model: string;
  reasoningEffort: ReasoningEffort;
  /**
   * Whether this session may change the working directory.
   *
   * `read` exposes exactly the read-only tools; an editing or shell tool is
   * absent from the registry rather than merely denied, which is what makes a
   * session safe to point at the operator's own checkout, where nothing would
   * revert a write. `write` exposes the rest behind a policy scoped to `cwd`.
   */
  access: 'read' | 'write';
  /** Live transcript: the same neutral events an agent phase emits. */
  onEvent?: (event: TransportEvent) => void;
  /** A model substitution or an extension error; never fatal on its own. */
  onWarning?: (warning: string) => void;
  /** Every verdict a write-capable session's policy gave, for the caller's log. */
  onDecision?: (ask: PermissionAsk, decision: PermissionDecision, reason: string) => void;
  /**
   * Standing rules for this one-shot, installed as the system prompt. The
   * string passed to `send()` is the user ask only.
   */
  systemPrompt?: string;
  /**
   * Optional schema-bound answer channel. When present, the session exposes
   * `submit_result` with this schema and returns the captured arguments
   * separately from assistant prose.
   */
  outputFormat?: OutputFormat;
}

export interface OneShotResult {
  /** Final assistant text, used by callers that did not request structured output. */
  text: string;
  usage: TurnUsage | null;
  /** The runtime's own word for how the turn ended, kept for the detail line. */
  reason: string;
  interrupted: boolean;
  /**
   * The arguments accepted by `submit_result`, or null when the caller did not
   * request structured output or the model never submitted it.
   */
  structuredOutput: Record<string, unknown> | null;
}

/**
 * One question, then disposal. `send` is called once; `abort` ends the turn in
 * flight, which is what a cancel button and a poll-kill both do.
 */
/** Vendor-neutral image attachment for a one-shot turn. */
export type OneShotImage = PlanImageAttachment;

export interface OneShotSession {
  send(prompt: string, images?: readonly OneShotImage[]): Promise<OneShotResult>;
  /** Ends whatever is running. Safe before `send` and after it resolves. */
  abort(): void;
}

/**
 * How a call site obtains its session. Injected at every one of them, so the
 * composition root picks the real runtime and a test picks a scripted turn.
 */
export type OneShotFactory = (opts: OneShotOptions) => OneShotSession;
