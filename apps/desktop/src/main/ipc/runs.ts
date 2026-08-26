import { existsSync } from 'node:fs';
import { shell } from 'electron';
import type {
  InterruptAnswer,
  RestorableCheckpointList,
  RestoreResult,
  RestoreRunInput,
  StartRunInput,
} from '@shared/types.js';
import { RESTORE_REFUSAL_COPY } from '@shared/types.js';
import {
  IPC,
  type ContextBreakdownResult,
  type EventPage,
  type RunDetail,
  type RunPlanExportResult,
  type RunPlanExportSelection,
  type WorktreeAction,
} from '@shared/ipc-contract.js';
import {
  emptyRunDetail,
  eventPage,
  runDetail,
  startRun,
  type StartRunDeps,
} from '../engine/operations.js';
import { listRestorableCheckpoints, restoreRun } from '../engine/restore.js';
import { landRun } from '../engine/settle.js';
import * as worktreeLib from '../engine/worktree.js';
import { exportRunPlan } from '../store/export-plan.js';
import { enabledModelIds } from '../pi/enabled-models.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifyRuns, notifySettings, restoreScope, settleHooks } from './shared.js';

type Ctx = Pick<
  AppContext,
  | 'projects'
  | 'roster'
  | 'pipelines'
  | 'rosterScope'
  | 'pipelineScope'
  | 'rosterFor'
  | 'commandNames'
  | 'registry'
  | 'settings'
  | 'envelopes'
  | 'broadcast'
  | 'oneShot'
  | 'supportDir'
>;

export type RunStartContext = Pick<
  Ctx,
  | 'projects'
  | 'pipelines'
  | 'pipelineScope'
  | 'rosterFor'
  | 'envelopes'
  | 'settings'
  | 'broadcast'
  | 'supportDir'
  | 'oneShot'
  | 'registry'
>;

export function runStartDeps(ctx: RunStartContext): StartRunDeps {
  return {
    projectById: (id) => ctx.projects.get(id),
    pipelineFor: (projectId, pipelineId) =>
      ctx.pipelines.get(pipelineId, ctx.pipelineScope(projectId)),
    rosterFor: (projectId) => ctx.rosterFor(projectId),
    envelopeDefs: () => ctx.envelopes.list(),
    settings: () => ctx.settings.get(),
    saveProject: (next) => {
      const result = ctx.projects.save(next);
      if (!result.ok) return next;
      notifySettings(ctx);
      return ctx.projects.get(next.id) ?? next;
    },
    enabledModelIds: () => enabledModelIds(ctx.supportDir, ctx.settings.get().hiddenModelIds),
    oneShot: ctx.oneShot,
    registry: ctx.registry,
  };
}

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);
  const tracerOf = (projectId: string) => {
    const project = projectOf(projectId);
    return project ? { project, tracer: ctx.registry.tracerFor(project) } : null;
  };

  // The start path lives in `engine/operations.ts`, shared verbatim with the
  // companion host so a phone-started run is the same run in every respect.
  handle(IPC.runsStart, (input: StartRunInput) => startRun(runStartDeps(ctx), input));

  handle(IPC.runsResume, (projectId: string, runId: string): WorktreeAction => {
    const project = projectOf(projectId);
    if (!project) return { ok: false, detail: 'project not found' };
    return ctx.registry.resume({
      project,
      runId,
      agents: ctx.rosterFor(projectId),
      envelopeDefs: ctx.envelopes.list(),
    });
  });

  handle(IPC.runsList, (projectId: string, includeArchived: boolean) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return [];
    return scoped.tracer.runs({ projectId, includeArchived });
  });

  handle(IPC.runsDetail, (projectId: string, runId: string): RunDetail => {
    const scoped = tracerOf(projectId);
    if (!scoped) return emptyRunDetail;
    return runDetail(scoped.tracer, runId, ctx.registry.isLive(runId));
  });

  handle(IPC.runsEvents, (projectId: string, runId: string, afterChangeId: number): EventPage => {
    const scoped = tracerOf(projectId);
    if (!scoped) return { events: [], cursor: afterChangeId };
    return eventPage(scoped.tracer, runId, afterChangeId);
  });

  handle(IPC.runsLiveTail, (phaseId: string) => ctx.registry.liveTail(phaseId));

  handle(
    IPC.runsContextBreakdown,
    async (projectId: string, runId: string, agent: string): Promise<ContextBreakdownResult> => {
      const project = projectOf(projectId);
      if (!project) return { breakdown: null, reason: 'not_live' };
      return ctx.registry.contextBreakdown(project, runId, agent);
    },
  );

  /** Prompts can be very large, so they are read on demand rather than polled. */
  handle(IPC.runsPrompt, (projectId: string, phaseId: string) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return '';
    const phase = scoped.tracer.phase(phaseId);
    return phase
      ? scoped.tracer.readPrompt(phase.runId, phase.owner, phase.name, phase.attempt)
      : '';
  });

  handle(IPC.runsKill, (projectId: string, runId: string) => {
    const project = projectOf(projectId);
    return project ? ctx.registry.kill(project, runId) : false;
  });

  handle(IPC.runsArchive, (projectId: string, runId: string, archived: boolean) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return;
    scoped.tracer.setArchived(runId, archived);
    notifyRuns(ctx);
  });

  handle(
    IPC.runsMergeWorktree,
    async (projectId: string, runId: string): Promise<WorktreeAction> => {
      const scoped = tracerOf(projectId);
      if (!scoped) return { ok: false, detail: 'project not found' };
      return landRun(scoped, settleHooks(ctx), { via: 'merge', runId });
    },
  );

  /**
   * The recovery path for a refused merge: an agent rebases the run branch
   * inside its own worktree, code verifies the result with git, and only then
   * lands the merge. One click from "base moved" to merged, and a failed
   * repair aborts back to exactly where the run left off.
   */
  handle(IPC.runsFixMerge, async (projectId: string, runId: string): Promise<WorktreeAction> => {
    const scoped = tracerOf(projectId);
    if (!scoped) return { ok: false, detail: 'project not found' };
    return landRun(scoped, settleHooks(ctx), { via: 'fixMerge', runId });
  });

  handle(
    IPC.runsDiscardWorktree,
    async (projectId: string, runId: string): Promise<WorktreeAction> => {
      const scoped = tracerOf(projectId);
      if (!scoped) return { ok: false, detail: 'project not found' };
      const { project, tracer } = scoped;
      const run = tracer.run(runId);
      if (!run?.worktreePath || !run.branch)
        return { ok: false, detail: 'this run has no worktree' };
      const outcome = await worktreeLib.discard(project.path, {
        path: run.worktreePath,
        branch: run.branch,
        baseRef: run.baseRef ?? project.baseRef,
        branchPointSha: run.branchPointSha ?? '',
      });
      tracer.setWorktree(runId, null, run.branch);
      tracer.event({
        runId,
        type: 'log',
        name: 'worktree discard',
        payload: { detail: outcome.detail },
      });
      notifyRuns(ctx);
      return { ok: outcome.removed, detail: outcome.detail };
    },
  );

  handle(IPC.runsOpenWorktree, (projectId: string, runId: string) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return;
    const run = scoped.tracer.run(runId);
    if (run?.worktreePath && existsSync(run.worktreePath)) shell.openPath(run.worktreePath);
  });

  // The plan is the trace's property: read from the run row, never the
  // pipeline store, so retroactive export survives app restarts.
  handle(IPC.runsPlan, (projectId: string, runId: string) => {
    const scoped = tracerOf(projectId);
    return scoped ? scoped.tracer.runPlan(runId) : null;
  });

  handle(
    IPC.runsExportPlan,
    (projectId: string, runId: string, selection: RunPlanExportSelection): RunPlanExportResult => {
      const scoped = tracerOf(projectId);
      if (!scoped) {
        return {
          ok: false,
          issues: [{ level: 'error', where: 'plan', message: 'Project not found.' }],
        };
      }
      const plan = scoped.tracer.runPlan(runId);
      if (!plan) {
        return {
          ok: false,
          issues: [
            {
              level: 'error',
              where: 'plan',
              message: 'This run has no generated plan to export.',
            },
          ],
        };
      }
      const result = exportRunPlan(plan, selection, {
        roster: ctx.roster,
        pipelines: ctx.pipelines,
        rosterScope: ctx.rosterScope(projectId),
        pipelineScope: ctx.pipelineScope(projectId),
        rosterAgents: ctx.rosterFor(projectId),
        commandNames: ctx.commandNames(projectId),
        knownEnvelopes: ctx.envelopes.list().map((envelope) => envelope.name),
      });
      if (result.ok) notifySettings(ctx);
      return result;
    },
  );

  /**
   * Restoring is engine choreography (`engine/restore.ts`), so these two are
   * arg-check and delegate. The list answers for a run it cannot restore too:
   * the checkpoints are readable history either way, and the refusal reason
   * travels with them so the picker says why rather than showing nothing.
   */
  handle(
    IPC.runsRestorableCheckpoints,
    async (projectId: string, runId: string): Promise<RestorableCheckpointList> => {
      const scoped = tracerOf(projectId);
      if (!scoped) {
        return {
          runId,
          refusal: 'run_not_found',
          detail: RESTORE_REFUSAL_COPY.run_not_found,
          checkpoints: [],
        };
      }
      return listRestorableCheckpoints(restoreScope(ctx, scoped.tracer), runId);
    },
  );

  handle(
    IPC.runsRestoreCheckpoint,
    async (projectId: string, input: RestoreRunInput): Promise<RestoreResult> => {
      const scoped = tracerOf(projectId);
      if (!scoped) {
        return {
          ok: false,
          refusal: 'run_not_found',
          detail: RESTORE_REFUSAL_COPY.run_not_found,
        };
      }
      if (!input?.runId || !input.checkpointId) {
        return {
          ok: false,
          refusal: 'checkpoint_not_found',
          detail: RESTORE_REFUSAL_COPY.checkpoint_not_found,
        };
      }
      return restoreRun(restoreScope(ctx, scoped.tracer), input);
    },
  );

  handle(IPC.runsRevealFiles, (projectId: string, runId: string) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return;
    const dir = scoped.tracer.runDir(runId);
    if (existsSync(dir)) shell.openPath(dir);
  });

  handle(IPC.interruptsList, () => ctx.registry.interrupts());
  handle(IPC.interruptsAnswer, (answer: InterruptAnswer) => ctx.registry.answer(answer));
}
