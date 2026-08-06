/**
 * The entire IPC surface. Every handler is invoke/handle: there is no
 * `ipcRenderer.send` path into the main process and no remote module, so the
 * renderer's only capability is this list.
 *
 * Trace data crosses as polled pages with a rowid cursor rather than a push
 * stream, which is why live view and history are the same query.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentDef,
  AppSettings,
  DryRunPrompt,
  InterruptAnswer,
  MaintenanceReport,
  OrphanWorktree,
  PipelineDef,
  ProjectDef,
  StartRunInput,
  ValidationIssue,
} from '@shared/types.js';
import { IPC, type EventPage, type RunDetail, type SaveResult, type TryCommandResult, type WorktreeAction } from '@shared/ipc-contract.js';
import { GATE_DESCRIPTIONS } from './engine/gates.js';
import { TEMPLATE_VARIABLES, renderPrompt } from './engine/prompts.js';
import { runCommand } from './engine/commands.js';
import { isRepo } from './engine/git.js';
import * as worktreeLib from './engine/worktree.js';
import { validate as validatePipeline } from './store/pipelines.js';
import { loadCatalog, loadTools, invalidateCatalog } from './droid/catalog.js';
import { checkProject, runDoctor } from './system/doctor.js';
import type { AppContext } from './context.js';

const noIssues: ValidationIssue[] = [];
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

export function registerIpc(ctx: AppContext): void {
  const handle = <T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (_event, ...args) => fn(...(args as never[])));
  };

  const notifySettings = (): void => ctx.broadcast(IPC.eventSettingsChanged);
  const notifyRuns = (): void => ctx.broadcast(IPC.eventRunsChanged);

  const projectOf = (projectId: string) => ctx.projects.get(projectId);
  const tracerOf = (projectId: string) => {
    const project = projectOf(projectId);
    return project ? { project, tracer: ctx.registry.tracerFor(project) } : null;
  };

  // ── settings ──────────────────────────────────────────────────────────────

  handle(IPC.settingsGet, () => ctx.settings.get());
  handle(IPC.settingsPatch, (patch: Partial<AppSettings>): SaveResult<AppSettings> => {
    const result = ctx.settings.patch(patch);
    if (!result.ok) {
      return { ok: false, issues: result.issues.map((m) => ({ level: 'error', where: 'settings', message: m })) };
    }
    if (patch.droidPath) invalidateCatalog();
    notifySettings();
    return { ok: true, issues: noIssues, value: result.settings };
  });

  // ── projects ──────────────────────────────────────────────────────────────

  handle(IPC.projectsList, () => ctx.projects.list());

  handle(IPC.projectsAdd, async (): Promise<ProjectDef | null> => {
    const window = BrowserWindow.getFocusedWindow() ?? ctx.window();
    const result = await dialog.showOpenDialog(window!, {
      title: 'Add a project',
      properties: ['openDirectory', 'createDirectory'],
      message: 'Pick a git repository for Foundry to run against.',
    });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    if (!(await isRepo(path))) {
      await dialog.showMessageBox(window!, {
        type: 'warning',
        message: 'That folder is not a git repository',
        detail: 'Foundry isolates each run in a git worktree, so a project has to be a repo.',
      });
      return null;
    }
    const project = ctx.projects.add(path);
    notifySettings();
    return project;
  });

  handle(IPC.projectsSave, (project: ProjectDef): SaveResult<ProjectDef[]> => {
    const result = ctx.projects.save(project);
    if (!result.ok) return { ok: false, issues: result.issues };
    notifySettings();
    return { ok: true, issues: noIssues, value: result.projects };
  });

  handle(IPC.projectsRemove, (id: string) => {
    const projects = ctx.projects.remove(id);
    notifySettings();
    return projects;
  });

  handle(IPC.projectsExport, (id: string) => {
    const project = projectOf(id);
    return project ? ctx.projects.export(project) : null;
  });

  handle(IPC.projectsTryCommand, async (id: string, argv: string[]): Promise<TryCommandResult> => {
    const project = projectOf(id);
    if (!project) {
      return { exitCode: null, passed: false, outputTail: 'project not found', durationMs: 0 };
    }
    const { exitCode, passed, outputTail, durationMs } = await runCommand({
      argv,
      cwd: project.path,
      timeoutMs: 300_000,
    });
    return { exitCode, passed, outputTail, durationMs };
  });

  handle(IPC.projectsCheck, async (id: string) => {
    const project = projectOf(id);
    return project ? checkProject(project) : [];
  });

  handle(IPC.projectsReveal, (path: string) => {
    if (existsSync(path)) shell.openPath(path);
  });

  // ── roster ────────────────────────────────────────────────────────────────

  handle(IPC.rosterList, (projectId?: string) => ctx.rosterFor(projectId));

  handle(IPC.rosterSave, (agent: AgentDef, projectId?: string): SaveResult<AgentDef[]> => {
    const result = ctx.roster.save(agent, ctx.rosterScope(projectId));
    if (!result.ok) return { ok: false, issues: result.issues };
    notifySettings();
    return { ok: true, issues: noIssues, value: result.agents };
  });

  handle(IPC.rosterRemove, (name: string, projectId?: string) => {
    const agents = ctx.roster.remove(name, ctx.rosterScope(projectId));
    notifySettings();
    return agents;
  });

  handle(IPC.rosterDuplicate, (name: string, projectId?: string) =>
    ctx.roster.duplicate(name, ctx.rosterScope(projectId)),
  );

  handle(IPC.rosterReset, () => {
    const agents = ctx.roster.resetToBuiltins();
    notifySettings();
    return agents;
  });

  // ── pipelines ─────────────────────────────────────────────────────────────

  handle(IPC.pipelinesList, (projectId?: string) => ctx.pipelinesFor(projectId));

  handle(IPC.pipelinesSave, (pipeline: PipelineDef, projectId?: string): SaveResult<PipelineDef[]> => {
    const result = ctx.pipelines.save(
      pipeline,
      ctx.rosterFor(projectId),
      ctx.commandNames(projectId),
      ctx.pipelineScope(projectId),
    );
    if (!result.ok) return { ok: false, issues: result.issues };
    notifySettings();
    return { ok: true, issues: noIssues, value: result.pipelines };
  });

  handle(IPC.pipelinesRemove, (id: string, projectId?: string) => {
    const pipelines = ctx.pipelines.remove(id, ctx.pipelineScope(projectId));
    notifySettings();
    return pipelines;
  });

  handle(IPC.pipelinesDuplicate, (id: string, projectId?: string) =>
    ctx.pipelines.duplicate(id, ctx.pipelineScope(projectId)),
  );

  handle(IPC.pipelinesValidate, (pipeline: PipelineDef, projectId?: string) =>
    validatePipeline(pipeline, ctx.rosterFor(projectId), ctx.commandNames(projectId)),
  );

  /** Renders exactly what a run would send, without spending a token. */
  handle(IPC.pipelinesDryRun, (pipelineId: string, projectId: string, request: string): DryRunPrompt[] => {
    const project = projectOf(projectId);
    const pipeline = ctx.pipelines.get(pipelineId, ctx.pipelineScope(projectId));
    if (!project || !pipeline) return [];
    const agents = ctx.rosterFor(projectId);
    const worktree = join(project.path, '.foundry-worktrees', 'run_dryrun');
    const out: DryRunPrompt[] = [];
    const envelopes = new Map<string, Record<string, unknown>>();
    for (const phase of pipeline.phases) {
      if (phase.kind !== 'agent') continue;
      const agent = agents.find((a) => a.name === phase.agent);
      if (!agent) continue;
      const rendered = renderPrompt(agent, phase, {
        request,
        runId: 'run_dryrun',
        worktree,
        handoffDir: join(worktree, '.foundry-handoff'),
        handoffFiles: [],
        // Earlier phases are stood in for with a placeholder envelope, so a
        // later prompt shows its real shape instead of "(not available)".
        envelopes: envelopes as never,
      });
      out.push({
        phase: phase.name,
        agent: agent.name,
        model: agent.model,
        systemPrompt: rendered.system,
        userPrompt: rendered.user,
      });
      envelopes.set(phase.name, {
        status: 'success',
        summary: `[${phase.name} envelope from a previous phase]`,
        artifacts: [],
        notes_for_next_agent: '',
        commit_message: `[${phase.name} commit message]`,
        changed_files: [],
      });
    }
    return out;
  });

  handle(IPC.pipelinesReset, () => {
    const pipelines = ctx.pipelines.resetToBuiltins();
    notifySettings();
    return pipelines;
  });

  // ── catalog ───────────────────────────────────────────────────────────────

  handle(IPC.catalogModels, (force?: boolean) => loadCatalog(ctx.settings.get().droidPath, !!force));
  handle(IPC.catalogTools, (model?: string) => loadTools(ctx.settings.get().droidPath, model));
  handle(IPC.catalogGates, () =>
    Object.entries(GATE_DESCRIPTIONS).map(([id, description]) => ({ id, description })),
  );
  handle(IPC.catalogTemplateVariables, () => TEMPLATE_VARIABLES);

  // ── runs ──────────────────────────────────────────────────────────────────

  handle(IPC.runsStart, (input: StartRunInput) => {
    const project = projectOf(input.projectId);
    if (!project) return startError('project', 'project not found');
    const pipeline = ctx.pipelines.get(input.pipelineId, ctx.pipelineScope(input.projectId));
    if (!pipeline) return startError('pipeline', 'pipeline not found');
    if (!input.request.trim()) return startError('request', 'a run needs a request');
    const agents = ctx.rosterFor(input.projectId);
    // Blocking errors are surfaced before a run starts, not discovered mid-phase.
    const issues = validatePipeline(pipeline, agents, ctx.commandNames(input.projectId)).filter(
      (i) => i.level === 'error',
    );
    if (issues.length) return { ok: false, issues };
    const runId = ctx.registry.start({ project, pipeline, agents, request: input.request });
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

  handle(IPC.runsEvents, (projectId: string, runId: string, afterRowid: number): EventPage => {
    const scoped = tracerOf(projectId);
    if (!scoped) return { events: [], cursor: afterRowid };
    const events = scoped.tracer.eventsAfter(runId, afterRowid);
    const cursor = events.length ? events[events.length - 1]!.rowid : afterRowid;
    return { events, cursor };
  });

  handle(IPC.runsLiveTail, (phaseId: string) => ctx.registry.liveTail(phaseId));

  /** Prompts can be very large, so they are read on demand rather than polled. */
  handle(IPC.runsPrompt, (projectId: string, phaseId: string) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return '';
    const phase = scoped.tracer.phase(phaseId);
    return phase ? scoped.tracer.readPrompt(phase.runId, phase.owner, phase.name, phase.attempt) : '';
  });

  handle(IPC.runsKill, (projectId: string, runId: string) => {
    const project = projectOf(projectId);
    return project ? ctx.registry.kill(project, runId) : false;
  });

  handle(IPC.runsArchive, (projectId: string, runId: string, archived: boolean) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return;
    scoped.tracer.setArchived(runId, archived);
    notifyRuns();
  });

  handle(IPC.runsMergeWorktree, async (projectId: string, runId: string): Promise<WorktreeAction> => {
    const scoped = tracerOf(projectId);
    if (!scoped) return { ok: false, detail: 'project not found' };
    const { project, tracer } = scoped;
    const run = tracer.run(runId);
    if (!run?.worktreePath || !run.branch) return { ok: false, detail: 'this run has no worktree' };
    const outcome = await worktreeLib.merge(project.path, {
      path: run.worktreePath,
      branch: run.branch,
      baseRef: run.baseRef ?? project.baseRef,
      branchPointSha: run.branchPointSha ?? '',
    });
    if (outcome.merged) tracer.setMerged(runId, true);
    tracer.event({ runId, type: 'log', name: 'worktree merge', payload: { detail: outcome.detail } });
    notifyRuns();
    return { ok: outcome.merged, detail: outcome.detail };
  });

  handle(IPC.runsDiscardWorktree, async (projectId: string, runId: string): Promise<WorktreeAction> => {
    const scoped = tracerOf(projectId);
    if (!scoped) return { ok: false, detail: 'project not found' };
    const { project, tracer } = scoped;
    const run = tracer.run(runId);
    if (!run?.worktreePath || !run.branch) return { ok: false, detail: 'this run has no worktree' };
    const outcome = await worktreeLib.discard(project.path, {
      path: run.worktreePath,
      branch: run.branch,
      baseRef: run.baseRef ?? project.baseRef,
      branchPointSha: run.branchPointSha ?? '',
    });
    tracer.setWorktree(runId, null, run.branch);
    tracer.event({ runId, type: 'log', name: 'worktree discard', payload: { detail: outcome.detail } });
    notifyRuns();
    return { ok: outcome.removed, detail: outcome.detail };
  });

  handle(IPC.runsOpenWorktree, (projectId: string, runId: string) => {
    const scoped = tracerOf(projectId);
    if (!scoped) return;
    const run = scoped.tracer.run(runId);
    if (run?.worktreePath && existsSync(run.worktreePath)) shell.openPath(run.worktreePath);
  });

  // ── interrupts ────────────────────────────────────────────────────────────

  handle(IPC.interruptsList, () => ctx.registry.interrupts());
  handle(IPC.interruptsAnswer, (answer: InterruptAnswer) => ctx.registry.answer(answer));

  // ── doctor and maintenance ────────────────────────────────────────────────

  handle(IPC.doctorRun, () => runDoctor(ctx.settings.get().droidPath));

  handle(IPC.maintenanceOrphans, async (): Promise<OrphanWorktree[]> => {
    const out: OrphanWorktree[] = [];
    for (const project of ctx.projects.list()) {
      if (!existsSync(project.path)) continue;
      const orphans = await worktreeLib.findOrphans({
        repo: project.path,
        projectId: project.id,
        activeRunIds: ctx.registry.tracerFor(project).activeRunIds(),
      });
      out.push(...orphans);
    }
    return out;
  });

  handle(IPC.maintenanceRemoveWorktree, async (projectId: string, path: string): Promise<WorktreeAction> => {
    const project = projectOf(projectId);
    if (!project) return { ok: false, detail: 'project not found' };
    const runId = path.split('/').pop() ?? '';
    const outcome = await worktreeLib.discard(project.path, {
      path,
      branch: worktreeLib.branchNameFor(runId),
      baseRef: project.baseRef,
      branchPointSha: '',
    });
    return { ok: outcome.removed, detail: outcome.detail };
  });

  handle(IPC.maintenanceRetention, (): MaintenanceReport => {
    const days = ctx.settings.get().retentionDays;
    let runsDeleted = 0;
    if (days) {
      for (const project of ctx.projects.list()) {
        runsDeleted += ctx.registry.tracerFor(project).deleteRunsOlderThan(days).length;
      }
    }
    notifyRuns();
    return { runsDeleted, bytesReclaimed: 0, worktreesRemoved: 0 };
  });

  handle(IPC.maintenanceCompact, () => {
    for (const project of ctx.projects.list()) ctx.registry.tracerFor(project).compact();
  });

  // ── app ───────────────────────────────────────────────────────────────────

  handle(IPC.appOpenExternal, (url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
  });
  handle(IPC.appAssetUrl, (relPath: string) => ctx.assetUrl(relPath));
  handle(IPC.appVersion, () => ctx.version);
}
