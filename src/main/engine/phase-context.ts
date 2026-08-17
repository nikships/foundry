/**
 * What a phase runner is allowed to see. Deliberately narrower than the
 * executor: a runner sequences nothing, settles nothing, and cannot reach the
 * worktree handle or finish().
 */

import type { PhaseDef, PhaseKind } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import type { ProjectDef, PipelineDef } from '@shared/types.js';
import type { Envelope } from './envelopes.js';
import type { CommandResult } from '@shared/types.js';
import type { InterruptRequest } from '../droid/agent.js';
import type { PrAction } from '@shared/ipc-contract.js';
import type { CommandDriftRecord } from './detect.js';

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

  /** Envelopes from completed phases, by phase name. Runners write here. */
  readonly envelopes: Map<string, Envelope>;
  /** Command results from completed code phases, by phase name. */
  readonly commandResults: Map<string, CommandResult>;
  /** Failure evidence a code phase routed back to an agent phase. */
  readonly feedback: Map<string, string>;
  /**
   * `{ref}` commands whose worktree sniff disagreed with the frozen project
   * argv. Run-scoped: never written to project settings until merge.
   */
  readonly commandDrift: Map<string, CommandDriftRecord>;

  /** True once cancel() ran; runners must bail at their next await point. */
  cancelled(): boolean;
  /** The trace phase id queued up front for this phase name. */
  phaseId(name: string): string;
  /** Raises the interrupt sheet. Only engineer phases reach it. */
  askHuman(req: InterruptRequest): Promise<{ approve: boolean; text?: string }>;
  /**
   * Push the run branch and open (or discover) the PR. Engine-owned: the
   * agent only drafts title/body. Failure is the exact gh/git error.
   */
  recordPr(input: { title: string; body: string }): Promise<PrAction>;
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
