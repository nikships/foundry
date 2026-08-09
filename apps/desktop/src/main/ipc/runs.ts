import { existsSync } from 'node:fs';
import { shell } from 'electron';
import type { InterruptAnswer, StartRunInput } from '@shared/types.js';
import { IPC, type EventPage, type RunDetail, type WorktreeAction } from '@shared/ipc-contract.js';
import { DETECT_PROMPT, parseDetectReply } from '../engine/detect.js';
import { ensureMissingCommands, missingCommandRefs, preflightForRun } from '../engine/preflight.js';
import { OneShotClient } from '../droid/oneshot.js';
import { resolveRef } from '../engine/git.js';
import { rebaseOntoBase, repairAgent } from '../engine/repair.js';
import * as worktreeLib from '../engine/worktree.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifyRuns, notifySettings } from './shared.js';

type Ctx = Pick<
  AppContext,
  | 'projects'
  | 'pipelines'
  | 'pipelineScope'
  | 'rosterFor'
  | 'registry'
  | 'settings'
  | 'envelopes'
  | 'broadcast'
>;

const emptyDetail: RunDetail = {
  run: null,
  phases: [],
  envelopes: [],
  gates: [],
  sessions: [],
  live: false,
};

function startError(where: string, message: string) {
  return { ok: false as const, issues: [{ level: 'error' as const, where, message }] };
}

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);
  const tracerOf = (projectId: string) => {
    const project = projectOf(projectId);
    return project ? { project, tracer: ctx.registry.tracerFor(project) } : null;
  };

  handle(IPC.runsStart, async (input: StartRunInput) => {
    let project = projectOf(input.projectId);
    if (!project) return startError('project', 'project not found');
    const pipeline = ctx.pipelines.get(input.pipelineId, ctx.pipelineScope(input.projectId));
    if (!pipeline) return startError('pipeline', 'pipeline not found');
    if (!input.request.trim()) return startError('request', 'a run needs a request');
    const agents = ctx.rosterFor(input.projectId);

    // Missing project commands are a deterministic fail mid-run. Fill them from
    // manifests (free), then the default CLI, before refusing to start.
    const missing = missingCommandRefs(pipeline, project);
    if (missing.length) {
      const projectPath = project.path;
      // A project Foundry created empty has nothing for an agent to find, so
      // asking one costs a turn to learn what is already known. Manifest
      // sniffing still runs: it is free, and it starts answering the moment a
      // run writes the first package.json.
      const scaffold = project.scaffold === true;
      const ensured = await ensureMissingCommands(project, missing, {
        useAgent: !scaffold,
        detectWithAgent: async () => {
          const settings = ctx.settings.get();
          // Start-time fill honours the operator's detection choice, so the
          // CLI that answers here is the one the Project pane says it will be.
          const vendor =
            settings.detectCli === 'default' ? settings.defaultCli : settings.detectCli;
          const cli = settings.clis[vendor];
          const model = settings.detectModel || 'inherit';
          const client = new OneShotClient({
            vendor,
            cliPath: cli.path,
            extraArgs: cli.extraArgs,
            cwd: projectPath,
            autonomy: 'low',
            model,
            reasoningEffort: model === 'inherit' ? 'off' : settings.defaultReasoningEffort,
          });
          const turn = await client.send(DETECT_PROMPT, 300_000);
          return parseDetectReply(turn.text).commands;
        },
        save: (next) => {
          // Finding a command means the project has grown real code, so it is
          // no longer a scaffold: from here it gets the strict treatment, and a
          // later missing command is a misconfiguration again.
          const settled = next.scaffold ? { ...next, scaffold: false } : next;
          const result = ctx.projects.save(settled);
          if (!result.ok) return settled;
          notifySettings(ctx);
          return ctx.projects.get(settled.id) ?? settled;
        },
      });
      project = ensured.project;
    }

    const knownEnvelopes = ctx.envelopes.list().map((e) => e.name);
    const issues = preflightForRun(
      pipeline,
      agents,
      project.commands.map((c) => c.name),
      knownEnvelopes,
      { scaffold: project.scaffold === true },
    );
    if (issues.some((i) => i.level === 'error')) return { ok: false, issues };
    const runId = ctx.registry.start({
      project,
      pipeline,
      agents,
      envelopeDefs: ctx.envelopes.list(),
      request: input.request,
    });
    return { ok: true, runId, issues: noIssues };
  });

  handle(IPC.runsList, (projectId: string, includeArchived: boolean) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return [];
    return scoped.tracer.runs({ projectId, includeArchived });
  });

  handle(IPC.runsDetail, (projectId: string, runId: string): RunDetail => {
    const scoped = tracerOf(projectId);
    if (!scoped) return emptyDetail;
    const { tracer } = scoped;
    return {
      run: tracer.run(runId),
      phases: tracer.phases(runId),
      envelopes: tracer.envelopes(runId),
      gates: tracer.gateResults(runId),
      sessions: tracer.agentSessions(runId),
      live: ctx.registry.isLive(runId),
    };
  });

  handle(IPC.runsEvents, (projectId: string, runId: string, afterChangeId: number): EventPage => {
    const scoped = tracerOf(projectId);
    if (!scoped) return { events: [], cursor: afterChangeId };
    const events = scoped.tracer.eventsAfter(runId, afterChangeId);
    // Rows arrive in creation order, so the next cursor is the max revision
    // served, not the last row's: a page boundary must not skip a row whose
    // update landed out of rowid order.
    const cursor = events.length
      ? Math.max(afterChangeId, ...events.map((e) => e.changeId))
      : afterChangeId;
    return { events, cursor };
  });

  handle(IPC.runsLiveTail, (phaseId: string) => ctx.registry.liveTail(phaseId));

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
      const { project, tracer } = scoped;
      const run = tracer.run(runId);
      if (!run?.worktreePath || !run.branch)
        return { ok: false, detail: 'this run has no worktree' };
      const outcome = await worktreeLib.merge(project.path, {
        path: run.worktreePath,
        branch: run.branch,
        baseRef: run.baseRef ?? project.baseRef,
        branchPointSha: run.branchPointSha ?? '',
      });
      if (outcome.merged) tracer.setMerged(runId, true);
      tracer.event({
        runId,
        type: 'log',
        name: 'worktree merge',
        payload: { detail: outcome.detail },
      });
      notifyRuns(ctx);
      return { ok: outcome.merged, detail: outcome.detail };
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
    const { project, tracer } = scoped;
    const run = tracer.run(runId);
    if (!run?.worktreePath || !run.branch) return { ok: false, detail: 'this run has no worktree' };
    if (run.merged) return { ok: false, detail: 'this run is already merged' };

    const baseRef = run.baseRef ?? project.baseRef;
    const ontoSha = await resolveRef(project.path, baseRef);
    if (!ontoSha) return { ok: false, detail: `${baseRef} does not resolve in this repo` };

    const settings = ctx.settings.get();
    const outcome = await rebaseOntoBase({
      worktreePath: run.worktreePath,
      branch: run.branch,
      ontoSha,
      ontoLabel: baseRef,
      agent: repairAgent(settings, run.worktreePath),
      timeoutMs: settings.turnTimeoutMs,
    });
    tracer.event({ runId, type: 'log', name: 'agent fix', payload: { detail: outcome.detail } });
    if (!outcome.ok) {
      notifyRuns(ctx);
      return { ok: false, detail: outcome.detail };
    }

    // The branch now sits on the base tip; record that and land the merge.
    tracer.setBranchPoint(runId, ontoSha);
    const merged = await worktreeLib.merge(project.path, {
      path: run.worktreePath,
      branch: run.branch,
      baseRef,
      branchPointSha: ontoSha,
    });
    if (merged.merged) tracer.setMerged(runId, true);
    tracer.event({
      runId,
      type: 'log',
      name: 'worktree merge',
      payload: { detail: merged.detail },
    });
    notifyRuns(ctx);
    return {
      ok: merged.merged,
      detail: merged.merged
        ? `${outcome.detail}; merged into ${baseRef}`
        : `${outcome.detail}; but the merge still failed: ${merged.detail}`,
    };
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

  handle(IPC.runsRevealFiles, (projectId: string, runId: string) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return;
    const dir = scoped.tracer.runDir(runId);
    if (existsSync(dir)) shell.openPath(dir);
  });

  handle(IPC.interruptsList, () => ctx.registry.interrupts());
  handle(IPC.interruptsAnswer, (answer: InterruptAnswer) => ctx.registry.answer(answer));
}
