/**
 * Durable orchestrator proposals: one independent record per `startPlan` call.
 *
 * The live `PlanSession` is only the turn cache; the DB row is the history.
 * Concurrent starts create distinct rows and never cancel siblings. Progress
 * persists via `onProgress` (wired as the `createPlans` callback) and
 * broadcasts both `orchestrator-progress` (live turn) and
 * `proposals-changed` (list invalidation), so updates arrive independently of
 * the originating composer or hook. Accept is exactly-once via the in-memory
 * flight lock plus the durable `accepted_run_id` key.
 */

import type {
  GeneratedRunPlan,
  ProposalSnapshot,
  ProposalStatus,
  ValidationIssue,
} from '@shared/types.js';
import type { OrchestratorAcceptResult, OrchestratorState } from '@shared/ipc-contract.js';
import { IPC } from '@shared/ipc-contract.js';
import type { PanelRegistry } from '../session/index.js';
import { PANEL_MAX_ENTRIES } from '../session/index.js';
import type { Tracer } from '../trace/tracer.js';
import type { PlanStart } from './plan-session.js';
import {
  startPlan,
  type PlanStartInput,
  type PlanStartProject,
  type PlanStartServices,
} from './start.js';

export interface ProposalStoreDeps {
  tracerFor(projectId: string): Tracer | null;
  projectIds(): string[];
  plans: PanelRegistry<PlanStart, OrchestratorState>;
  broadcast(channel: string, payload?: unknown): void;
  now?: () => number;
  /**
   * Privileged run start for the exact accepted snapshot. Wired by `context`
   * to `startRun(runStartDeps(ctx), { projectId, pipelineId, request, plan })`,
   * which re-validates via `checkPlanRails`. Injected so tests count starts.
   */
  startRun(plan: GeneratedRunPlan): Promise<OrchestratorAcceptResult>;
}

function toProposalStatus(state: OrchestratorState): {
  status: ProposalStatus;
  terminal: boolean;
} {
  if (state.status === 'running') return { status: 'generating', terminal: false };
  if (state.status === 'cancelled') return { status: 'cancelled', terminal: true };
  if (state.status === 'failed') return { status: 'failed', terminal: true };
  if (state.plan) return { status: 'ready', terminal: true };
  return { status: 'failed', terminal: true };
}

/** Terminal without a run: never flips back via progress once reached. */
function isFrozen(status: ProposalStatus): boolean {
  return status === 'cancelled' || status === 'discarded' || status === 'accepted';
}

/**
 * Durable snapshot projected onto the live turn shape for pre-durability
 * callers (companion `state`). `discarded` has no live equivalent and
 * answers `null`. `accepted` reads as `done` with the accepted snapshot.
 */
export function proposalToLiveState(snapshot: ProposalSnapshot): OrchestratorState | null {
  if (snapshot.status === 'discarded') return null;
  const liveStatus =
    snapshot.status === 'generating'
      ? 'running'
      : snapshot.status === 'ready' || snapshot.status === 'accepted'
        ? 'done'
        : snapshot.status;
  return {
    planId: snapshot.planId,
    projectId: snapshot.projectId,
    status: liveStatus,
    model: snapshot.model,
    reasoningEffort: snapshot.reasoningEffort,
    prompt: snapshot.prompt,
    entries: snapshot.entries.map((entry) => ({ ...entry })),
    plan: snapshot.status === 'accepted' ? (snapshot.acceptedPlan ?? snapshot.plan) : snapshot.plan,
    rawReply: snapshot.rawReply,
    detail: snapshot.detail,
    startedAt: snapshot.createdAt,
    ...(snapshot.endedAt !== undefined ? { endedAt: snapshot.endedAt } : {}),
    messages: snapshot.messages.map((message) => ({ ...message })),
    revision: snapshot.revision,
  };
}

function acceptIssue(where: string, message: string): OrchestratorAcceptResult {
  const issues: ValidationIssue[] = [{ level: 'error', where, message }];
  return { ok: false, issues };
}

export class ProposalStore {
  private readonly acceptInFlight = new Map<string, Promise<OrchestratorAcceptResult>>();

  constructor(private readonly deps: ProposalStoreDeps) {}

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private broadcastProposals(projectId: string, planId?: string): void {
    this.deps.broadcast(IPC.eventProposalsChanged, { projectId, ...(planId ? { planId } : {}) });
  }

  private broadcastProgress(state: OrchestratorState): void {
    this.deps.broadcast(IPC.eventOrchestratorProgress, state);
  }

  /**
   * Validates via the shared `startPlan` path, then persists the durable row
   * before the turn can finish. Never cancels siblings: one row per call.
   */
  start(
    project: PlanStartProject | null | undefined,
    input: PlanStartInput,
    services: PlanStartServices,
  ): { planId: string } | { error: string } {
    const started = startPlan(this.deps.plans, project, input, services);
    if ('error' in started) return started;
    const planId = started.planId;
    const projectId = project?.id;
    if (!projectId) return { planId };
    const tracer = this.deps.tracerFor(projectId);
    if (!tracer) return { planId };
    const at = this.clock();
    try {
      tracer.createProposal({
        planId,
        projectId,
        prompt: input.prompt,
        model: input.model || 'inherit',
        reasoningEffort: input.reasoningEffort,
        createdAt: at,
      });
    } catch {
      // The live session still runs; the next progress persists the row.
      return { planId };
    }
    this.broadcastProposals(projectId, planId);
    return { planId };
  }

  /**
   * Persists every live transition and fans out both push channels. Late
   * completion with no renderer attached is just a broadcast: the DB is the
   * source of truth, so no hook needs to have been alive.
   */
  onProgress(state: OrchestratorState): void {
    this.broadcastProgress(state);
    const tracer = this.deps.tracerFor(state.projectId);
    if (!tracer) return;
    const stored = this.safeGet(tracer, state.planId);
    if (!stored) {
      this.ensureRow(tracer, state);
      return;
    }
    if (isFrozen(stored.status)) return;
    this.writeProgress(tracer, state);
  }

  private safeGet(tracer: Tracer, planId: string): ProposalSnapshot | null {
    try {
      return tracer.proposal(planId);
    } catch {
      return null;
    }
  }

  private ensureRow(tracer: Tracer, state: OrchestratorState): void {
    const at = this.clock();
    try {
      tracer.createProposal({
        planId: state.planId,
        projectId: state.projectId,
        prompt: state.prompt,
        model: state.model,
        reasoningEffort: state.reasoningEffort,
        createdAt: at,
      });
    } catch {
      return;
    }
    this.writeProgress(tracer, state);
  }

  private writeProgress(tracer: Tracer, state: OrchestratorState): void {
    const mapped = toProposalStatus(state);
    const at = this.clock();
    try {
      tracer.updateProposal(state.planId, {
        status: mapped.status,
        detail: state.detail,
        entriesJson: JSON.stringify(state.entries.slice(-PANEL_MAX_ENTRIES)),
        planJson: state.plan ? JSON.stringify(state.plan) : null,
        rawReply: state.rawReply,
        messagesJson: JSON.stringify(state.messages),
        revision: state.revision,
        updatedAt: at,
        endedAt: mapped.terminal ? at : null,
      });
    } catch {
      return;
    }
    this.broadcastProposals(state.projectId, state.planId);
  }

  list(projectId: string): ProposalSnapshot[] {
    const tracer = this.deps.tracerFor(projectId);
    if (!tracer) return [];
    try {
      return tracer.proposalsByProject(projectId);
    } catch {
      return [];
    }
  }

  get(planId: string): ProposalSnapshot | null {
    const found = this.locate(planId);
    return found ? found.snapshot : null;
  }

  private locate(planId: string): { tracer: Tracer; snapshot: ProposalSnapshot } | null {
    for (const projectId of this.deps.projectIds()) {
      const tracer = this.deps.tracerFor(projectId);
      if (!tracer) continue;
      try {
        const snapshot = tracer.proposal(planId);
        if (snapshot) return { tracer, snapshot };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Aborts the live turn and marks the durable row `cancelled`. A `cancelled`
   * row is retained but hidden from the sidebar and not actionable. Terminal
   * rows are a no-op `false`.
   */
  cancel(planId: string): boolean {
    const found = this.locate(planId);
    if (!found) return this.deps.plans.cancel(planId);
    if (found.snapshot.status !== 'generating') return false;
    this.deps.plans.cancel(planId);
    const at = this.clock();
    try {
      const current = found.tracer.proposal(planId);
      if (!current || current.status !== 'generating') return true;
      found.tracer.updateProposal(planId, {
        status: 'cancelled',
        detail: 'cancelled',
        updatedAt: at,
        endedAt: at,
      });
    } catch {
      return true;
    }
    this.broadcastProposals(found.snapshot.projectId, planId);
    return true;
  }

  /**
   * Tombstones a proposal. If `generating`, cancels first. `accepted` rows
   * refuse (`false`); discard is otherwise idempotent. Late completion after
   * discard is dropped by `onProgress` (row stays `discarded`).
   */
  discard(planId: string): boolean {
    if (this.acceptInFlight.has(planId)) return false;
    const found = this.locate(planId);
    if (!found) return false;
    if (found.snapshot.status === 'accepted') return false;
    if (found.snapshot.status === 'discarded') return true;
    if (found.snapshot.status === 'generating') this.deps.plans.cancel(planId);
    const at = this.clock();
    try {
      found.tracer.updateProposal(planId, {
        status: 'discarded',
        updatedAt: at,
        endedAt: at,
      });
    } catch {
      return true;
    }
    this.broadcastProposals(found.snapshot.projectId, planId);
    return true;
  }

  /**
   * Exactly-once run creation. Concurrent accepts share one promise
   * (in-memory lock); sequential repeats hit the durable `accepted_run_id`
   * and start nothing. The exact effective plan is persisted as
   * `acceptedPlan` and becomes the run's `plan_json` via `startRun`.
   */
  accept(planId: string, plan?: GeneratedRunPlan): Promise<OrchestratorAcceptResult> {
    const inflight = this.acceptInFlight.get(planId);
    if (inflight) return inflight;
    const task = this.doAccept(planId, plan).finally(() => {
      if (this.acceptInFlight.get(planId) === task) this.acceptInFlight.delete(planId);
    });
    this.acceptInFlight.set(planId, task);
    return task;
  }

  private async doAccept(
    planId: string,
    override?: GeneratedRunPlan,
  ): Promise<OrchestratorAcceptResult> {
    const found = this.locate(planId);
    if (!found) return acceptIssue('plan', 'proposal not found');
    if (found.snapshot.acceptedRunId) {
      return { ok: true, runId: found.snapshot.acceptedRunId };
    }
    if (found.snapshot.status === 'discarded') {
      return acceptIssue('plan', 'proposal discarded');
    }
    if (found.snapshot.status !== 'ready') {
      return acceptIssue('plan', 'proposal is not ready to start');
    }
    const effective = override ?? found.snapshot.plan;
    if (!effective) return acceptIssue('plan', 'proposal has no plan to start');
    if (effective.projectId !== found.snapshot.projectId) {
      return acceptIssue('plan', 'this plan was generated for a different project');
    }
    const outcome = await this.deps.startRun(effective);
    if (!outcome.ok) return outcome;
    const at = this.clock();
    try {
      found.tracer.updateProposal(planId, {
        status: 'accepted',
        acceptedRunId: outcome.runId,
        acceptedPlanJson: JSON.stringify(effective),
        updatedAt: at,
        endedAt: at,
      });
    } catch {
      return { ok: true, runId: outcome.runId };
    }
    this.broadcastProposals(found.snapshot.projectId, planId);
    return { ok: true, runId: outcome.runId };
  }

  /**
   * Boot/restore: `generating` rows can never resume (one-shots cannot be
   * re-attached), so they become `failed/interrupted` with retry affordance.
   * Ready/failed/cancelled/accepted rows are untouched. Emits one
   * `proposals-changed` per affected project.
   */
  restoreOnBoot(projectIds?: string[]): void {
    const ids = projectIds ?? this.deps.projectIds();
    for (const projectId of ids) {
      this.restoreProject(projectId);
    }
  }

  private restoreProject(projectId: string): void {
    const tracer = this.deps.tracerFor(projectId);
    if (!tracer) return;
    let rows: ProposalSnapshot[];
    try {
      rows = tracer.proposalsByProject(projectId, { includeDiscarded: true });
    } catch {
      return;
    }
    const at = this.clock();
    let touched = false;
    for (const row of rows) {
      if (row.status !== 'generating') continue;
      try {
        tracer.updateProposal(row.planId, {
          status: 'failed',
          detail: 'Planning was interrupted by restart. Try again.',
          updatedAt: at,
          endedAt: at,
        });
        touched = true;
      } catch {
        continue;
      }
    }
    if (touched) this.broadcastProposals(projectId);
  }
}
