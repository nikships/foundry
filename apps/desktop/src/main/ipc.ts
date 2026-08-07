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
  CliVendor,
  DryRunPrompt,
  InterruptAnswer,
  MaintenanceReport,
  OrphanWorktree,
  PipelineDef,
  ProjectDef,
  StartRunInput,
  ValidationIssue,
} from '@shared/types.js';
import { IPC, type DetectCommandsResult, type EventPage, type RunDetail, type SaveResult, type TryCommandResult, type WorktreeAction } from '@shared/ipc-contract.js';
import { GATE_DESCRIPTIONS } from './engine/gates.js';
import { TEMPLATE_VARIABLES, renderPrompt } from './engine/prompts.js';
import { runCommand } from './engine/commands.js';
import { DETECT_PROMPT, parseDetectReply, sniffCommands } from './engine/detect.js';
import { OneShotClient } from './droid/oneshot.js';
import { isRepo } from './engine/git.js';
import * as worktreeLib from './engine/worktree.js';
import { validate as validatePipeline } from './store/pipelines.js';
import { invalidateCatalog } from './droid/catalog.js';
import { adapterFor, allAdapters } from './cli/index.js';
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
    // A new droid path can mean a different model table.
    if (patch.clis) invalidateCatalog();
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
    // Manifest sniffing is free and needs no run, so a new project arrives with
    // its commands already filled in. Only a project with none is seeded, so
    // re-adding a path can never clobber commands the user edited. Nothing is
    // executed here: the add dialog must not block on a test suite.
    if (!project.commands.length) {
      const sniffed = await sniffCommands(project.path);
      if (sniffed.length) {
        ctx.projects.save({ ...project, commands: sniffed.map(({ name, argv }) => ({ name, argv })) });
      }
    }
    notifySettings();
    return ctx.projects.get(project.id) ?? project;
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

  /**
   * Proposes commands; never writes them. The renderer shows what came back and
   * the human accepts, so a wrong guess costs a glance rather than a silently
   * broken test phase.
   */
  handle(
    IPC.projectsDetectCommands,
    async (id: string, useAgent?: boolean): Promise<DetectCommandsResult> => {
      const project = projectOf(id);
      if (!project) return { commands: [], via: 'none', detail: 'project not found' };

      let candidates = await sniffCommands(project.path);
      let via: DetectCommandsResult['via'] = candidates.length ? 'manifest' : 'none';

      if (!candidates.length && useAgent) {
        try {
          const settings = ctx.settings.get();
          // Read-only autonomy: discovery reads the repo and must not be able
          // to change it, and this runs against the base checkout, not a
          // worktree, because no run owns it.
          // Discovery runs on the default CLI: it is the one the operator has
          // certainly authenticated, and this is not a phase anyone chose an
          // agent for. Read-only autonomy, against the base checkout rather
          // than a worktree, because no run owns it.
          const vendor = settings.defaultCli;
          const cli = settings.clis[vendor];
          const client = new OneShotClient({
            vendor,
            cliPath: cli.path,
            extraArgs: cli.extraArgs,
            cwd: project.path,
            autonomy: 'low',
            // A model id is meaningful only to the CLI that published it, and
            // defaultModel is droid's. Any other vendor gets its own default
            // rather than a droid id it would reject on the first turn.
            model: vendor === 'droid' ? settings.defaultModel : 'inherit',
            reasoningEffort: vendor === 'droid' ? settings.defaultReasoningEffort : 'off',
          });
          const turn = await client.send(DETECT_PROMPT, 300_000);
          candidates = parseDetectReply(turn.text);
          if (candidates.length) via = 'agent';
        } catch (e) {
          return {
            commands: [],
            via: 'none',
            detail: `could not ask an agent: ${(e as Error).message}`,
          };
        }
      }

      if (!candidates.length) {
        return {
          commands: [],
          via: 'none',
          detail: useAgent
            ? 'no command found in the manifests or by reading the repo'
            : 'no command found in the manifests',
        };
      }

      // Running each candidate is the point: a command that passes here is
      // evidence, while a command merely typed into a field is a hope.
      const commands = await Promise.all(
        candidates.map(async (c) => {
          const result = await runCommand({ argv: c.argv, cwd: project.path, timeoutMs: 300_000 });
          return {
            name: c.name,
            argv: c.argv,
            source: c.source,
            verified: result.passed,
            exitCode: result.exitCode,
            outputTail: result.outputTail,
            durationMs: result.durationMs,
          };
        }),
      );

      const passed = commands.filter((c) => c.verified).length;
      return {
        commands,
        via,
        detail: `${commands.length} found via ${via}, ${passed} verified by running`,
      };
    },
  );

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

  handle(IPC.catalogModels, (vendor: CliVendor, force?: boolean) => {
    if (force) invalidateCatalog();
    return adapterFor(vendor).models(ctx.settings.get().clis[vendor].path);
  });
  handle(IPC.catalogTools, (vendor: CliVendor, model?: string) => {
    const adapter = adapterFor(vendor);
    // Only droid enumerates tools; the rest scope them by sandbox, so an empty
    // list is the honest answer rather than a failed call.
    return adapter.tools?.(ctx.settings.get().clis[vendor].path, model) ?? Promise.resolve([]);
  });
  handle(IPC.catalogClis, () =>
    allAdapters().map((a) => ({
      id: a.id,
      label: a.label,
      binary: a.binary,
      docsUrl: a.docsUrl,
      authEnvVars: a.authEnvVars,
      supportsRpc: a.supportsRpc,
      caveats: a.caveats,
    })),
  );
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

  handle(IPC.doctorRun, () => runDoctor(ctx.settings.get()));

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
