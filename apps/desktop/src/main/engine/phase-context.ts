/**
 * What a phase runner is allowed to see. Deliberately narrower than the
 * executor: a runner sequences nothing, settles nothing, and cannot reach the
 * worktree handle or finish().
 */

import type { CommandResult, PhaseDef, PhaseKind, PipelineDef, ProjectDef } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import type { Envelope } from './envelopes.js';
import type { IssueAction, PrAction } from '@shared/ipc-contract.js';
import type { CommandDriftRecord } from './detect.js';
import type { HealingSupport } from './healing.js';

export interface RunContext {
  readonly tracer: Tracer;
  readonly runId: string;
  readonly project: ProjectDef;
  readonly pipeline: PipelineDef;
  readonly request: string;
  /** The worktree when isolated, the checkout otherwise. */
  readonly cwd: string;
  readonly handoffDir: string;
  /** Isolated run branch (`foundry/<runId>`), or null when isolation is off. */
  readonly branch: string | null;
  /** Project base ref the PR targets. */
  readonly baseRef: string;
  /** Base commit the isolated run branched from. */
  readonly branchPointSha: string;

  /** Envelopes from completed phases, by phase name. Runners write here. */
  readonly envelopes: Map<string, Envelope>;
  /** Command results from completed code phases, by phase name. */
  readonly commandResults: Map<string, CommandResult>;
  /** Failure evidence a code phase routed back to an agent phase. */
  readonly feedback: Map<string, string>;
  /**
   * Per-phase notes for a phase being restarted rather than entered for the
   * first time — today, the phase a kill interrupted. Written by the executor
   * at resume, read by the agent runner when it composes the prompt.
   */
  readonly recoveryNotes: Map<string, string>;
  /**
   * `{ref}` commands whose worktree sniff disagreed with the frozen project
   * argv. Run-scoped: never written to project settings until merge.
   */
  readonly commandDrift: Map<string, CommandDriftRecord>;

  /**
   * How a failing code phase opens a healing turn, or `null` when this install
   * has no healing model. Absent means a red command escalates exactly as it
   * did before healing existed.
   */
  readonly healing: HealingSupport | null;

  /** True once cancel() ran; runners must bail at their next await point. */
  cancelled(): boolean;
  /**
   * Registers something a run-level cancel must interrupt, and returns the
   * function that unregisters it.
   *
   * Polling `cancelled()` is only honest between awaits: a turn already in
   * flight has no next await point until it answers, which for a model turn is
   * minutes away. An agent phase escapes that because its session is killable
   * through the executor's own map; anything else that blocks a phase on a
   * model has to hand over its own interrupt or Stop silently does nothing.
   */
  onCancel(abort: () => void): () => void;
  /** The trace phase id queued up front for this phase name. */
  phaseId(name: string): string;
  /**
   * Push the run branch and open (or discover) the PR. Engine-owned: the
   * agent only drafts title/body. Failure is the exact gh/git error.
   */
  recordPr(input: { title: string; body: string }): Promise<PrAction>;
  /**
   * File a GitHub issue. Engine-owned like recordPr: the agent only drafts
   * title/body/labels, and gh runs against the project checkout.
   */
  recordIssue(input: { title: string; body: string; labels?: string[] }): Promise<IssueAction>;
}

/** Where the walk goes after a phase. Unchanged from executor.ts. */
export type PhaseJump =
  { kind: 'next' } | { kind: 'goto'; phase: string } | { kind: 'abort'; detail: string };

/**
 * One runner per phase kind. A runner owns everything inside one phase
 * (retries, corrections, boundary, gates) and decides only where the walk
 * goes next. It never decides run status, and it always closes its own trace
 * phase.
 */
export interface PhaseRunner {
  readonly kind: PhaseKind;
  run(phase: PhaseDef, ctx: RunContext): Promise<PhaseJump>;
}
