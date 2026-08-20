import { BrowserWindow, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import type { GithubAccount, ProjectDef } from '@shared/types.js';
import {
  IPC,
  type DetectCommandsResult,
  type NewRepoInput,
  type NewRepoResult,
  type SaveResult,
  type TryCommandResult,
} from '@shared/ipc-contract.js';
import { runCommand } from '../engine/commands.js';
import { sniffCommands } from '../engine/detect.js';
import { sniffSetupScript } from '../engine/setup.js';
import { inspectBase, syncBase } from '../engine/base-sync.js';
import { currentBranch, isRepo } from '../engine/git.js';
import { checkProject } from '../system/doctor.js';
import { createRepo, githubAccount } from '../system/gh.js';
import type { AppContext } from '../context.js';
import { ensureProjectContext } from '../project-context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<
  AppContext,
  | 'projects'
  | 'settings'
  | 'supportDir'
  | 'window'
  | 'broadcast'
  | 'detections'
  | 'setups'
  | 'roster'
  | 'pipelines'
  | 'oneShot'
>;

/**
 * The model a detection or setup turn should run on.
 *
 * A stored id that no provider currently serves falls back to `inherit` rather
 * than being sent: the turn would be refused on its first message, and "the
 * agent found nothing" is the least useful way to learn a provider was
 * disconnected. An unreadable catalog also falls back, because refusing to
 * start on a catalog read is worse than starting on this install's default.
 */
async function resolveTurnModel(supportDir: string, stored: string): Promise<string> {
  const model = stored || 'inherit';
  if (model === 'inherit') return 'inherit';
  const { availableModels } = await import('../pi/catalog.js');
  const known = await availableModels(supportDir).catch(() => []);
  if (!known.length) return 'inherit';
  return known.some((m) => m.id === model) ? model : 'inherit';
}

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);
  const detections = ctx.detections;
  const setups = ctx.setups;

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
    const curBranch = await currentBranch(path);
    const project = ctx.projects.add(path, curBranch || undefined);
    // Manifest sniffing is free and needs no run, so a new project arrives with
    // its commands already filled in. Only a project with none is seeded, so
    // re-adding a path can never clobber commands the user edited. Nothing is
    // executed here: the add dialog must not block on a test suite.
    if (!project.commands.length) {
      const sniffed = await sniffCommands(project.path);
      if (sniffed.length) {
        ctx.projects.save({
          ...project,
          commands: sniffed.map(({ name, argv }) => ({ name, argv })),
        });
      }
    }
    void ensureProjectContext({
      project: ctx.projects.get(project.id) ?? project,
      settings: ctx.settings.get(),
      oneShot: ctx.oneShot,
      persist: (next) => {
        const current = ctx.projects.get(next.id);
        if (!current) return;
        ctx.projects.save({
          ...current,
          contextSummary: next.contextSummary,
        });
      },
    }).then(() => notifySettings(ctx));
    notifySettings(ctx);
    return ctx.projects.get(project.id) ?? project;
  });

  handle(IPC.projectsGithubAccount, (): Promise<GithubAccount> => githubAccount());

  handle(IPC.projectsChooseParentDir, async (): Promise<string | null> => {
    const window = BrowserWindow.getFocusedWindow() ?? ctx.window();
    // The parent of an existing project is where the next repo most likely
    // belongs; home is the fallback for a first-ever project.
    const known = ctx.projects.list().at(-1)?.path;
    const result = await dialog.showOpenDialog(window!, {
      title: 'Where should the new repository live?',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: known ? dirname(known) : homedir(),
      message: 'Foundry clones the new repository into this folder.',
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  /**
   * Creates on GitHub through the operator's own gh, then registers the clone.
   *
   * No manifest sniffing here, unlike `projects:add`: a repository created
   * moments ago has nothing to sniff, and the `scaffold` flag is what tells the
   * engine to skip command-shaped phases until the project grows one.
   */
  handle(IPC.projectsCreateGithub, async (input: NewRepoInput): Promise<NewRepoResult> => {
    const created = await createRepo(input);
    if (!created.ok || !created.path) return created;

    const path = created.path;
    if (!(await isRepo(path))) {
      return { ...created, ok: false, detail: `${path} was cloned but is not a git repository` };
    }
    const curBranch = await currentBranch(path);
    const project = ctx.projects.add(path, curBranch || undefined, { scaffold: true });
    void ensureProjectContext({
      project,
      settings: ctx.settings.get(),
      oneShot: ctx.oneShot,
      persist: (next) => {
        const current = ctx.projects.get(next.id);
        if (!current) return;
        ctx.projects.save({
          ...current,
          contextSummary: next.contextSummary,
        });
      },
    }).then(() => notifySettings(ctx));
    notifySettings(ctx);
    return { ...created, project: ctx.projects.get(project.id) ?? project };
  });

  handle(IPC.projectsSave, (project: ProjectDef): SaveResult<ProjectDef[]> => {
    const result = ctx.projects.save(project);
    if (!result.ok) return { ok: false, issues: result.issues };
    notifySettings(ctx);
    return { ok: true, issues: noIssues, value: result.projects };
  });

  handle(IPC.projectsRemove, (id: string) => {
    const projects = ctx.projects.remove(id);
    notifySettings(ctx);
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
   * Manifest sniffing only: free, no model, no child process. Proposes
   * commands and never writes them, so a wrong guess costs a glance rather
   * than a silently broken test phase.
   */
  handle(IPC.projectsSniffCommands, async (id: string): Promise<DetectCommandsResult> => {
    const project = projectOf(id);
    if (!project) return { commands: [], via: 'none', detail: 'project not found' };

    const candidates = await sniffCommands(project.path);
    if (!candidates.length) {
      return { commands: [], via: 'none', detail: 'no command found in the manifests' };
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
      via: 'manifest',
      detail: `${commands.length} found in the manifests, ${passed} verified by running`,
    };
  });

  /**
   * Always asks an agent. Manifest results are handed to it as context to
   * confirm or correct, never used as a reason to skip it: a button labelled
   * "Ask AI" that quietly returned a manifest guess is indistinguishable from
   * a broken one.
   *
   * Returns as soon as the session exists so the click is never left awaiting
   * a five-minute turn; progress arrives on `detection-progress`.
   */
  handle(
    IPC.projectsAskAgentCommands,
    async (id: string): Promise<{ detectionId: string } | { error: string }> => {
      const project = projectOf(id);
      if (!project) return { error: 'project not found' };

      const settings = ctx.settings.get();
      const model = await resolveTurnModel(ctx.supportDir, settings.detectModel);

      const detectionId = detections.start({
        projectId: project.id,
        projectPath: project.path,
        existingCommands: project.commands.map((c) => c.name),
        settings,
        model,
      });
      return { detectionId };
    },
  );

  handle(IPC.projectsCancelDetection, (detectionId: string) => detections.cancel(detectionId));

  handle(IPC.projectsDetection, (detectionId: string) => detections.get(detectionId));

  handle(IPC.projectsSetupScriptGet, (id: string): string => {
    const project = projectOf(id);
    return project?.setupScript ?? '';
  });

  handle(IPC.projectsSetupScriptSave, (id: string, script: string): SaveResult<ProjectDef[]> => {
    const project = projectOf(id);
    if (!project)
      return {
        ok: false,
        issues: [{ level: 'error', where: 'project', message: 'project not found' }],
      };
    if (script.length > 8000) {
      return {
        ok: false,
        issues: [
          { level: 'error', where: 'setupScript', message: 'script too long (max 8000 chars)' },
        ],
      };
    }
    const result = ctx.projects.save({ ...project, setupScript: script });
    if (!result.ok) return { ok: false, issues: result.issues };
    notifySettings(ctx);
    return { ok: true, issues: noIssues, value: result.projects };
  });

  handle(IPC.projectsSetupScriptSniff, async (id: string) => {
    const project = projectOf(id);
    if (!project) return { script: '', detail: 'project not found', sources: [] as string[] };
    return sniffSetupScript(project.path);
  });

  handle(IPC.projectsSetupScriptTry, async (id: string, script: string) => {
    const project = projectOf(id);
    if (!project) {
      return {
        exitCode: null as number | null,
        passed: false,
        outputTail: 'project not found',
        durationMs: 0,
      };
    }
    if (!script.trim()) {
      return {
        exitCode: 0 as number | null,
        passed: true,
        outputTail: 'nothing to run',
        durationMs: 0,
      };
    }
    const result = await runCommand({
      argv: ['sh', '-c', script],
      cwd: project.path,
      timeoutMs: 300_000,
    });
    return {
      exitCode: result.exitCode,
      passed: result.passed,
      outputTail: result.outputTail,
      durationMs: result.durationMs,
    };
  });

  handle(
    IPC.projectsSetupScriptAskAgent,
    async (id: string): Promise<{ setupId: string } | { error: string }> => {
      const project = projectOf(id);
      if (!project) return { error: 'project not found' };
      const settings = ctx.settings.get();
      const model = await resolveTurnModel(ctx.supportDir, settings.detectModel);
      const setupId = setups.start({
        projectId: project.id,
        projectPath: project.path,
        settings,
        model,
      });
      return { setupId };
    },
  );

  handle(IPC.projectsSetupProgress, (setupId: string) => setups.get(setupId));

  handle(IPC.projectsSetupCancel, (setupId: string) => setups.cancel(setupId));

  handle(IPC.projectsCheck, async (id: string) => {
    const project = projectOf(id);
    return project ? checkProject(project) : [];
  });

  handle(IPC.projectsReveal, (path: string) => {
    if (existsSync(path)) shell.openPath(path);
  });

  handle(IPC.projectsScopeCopies, (id: string) => ({
    roster: ctx.roster.hasProjectCopy(id),
    pipelines: ctx.pipelines.hasProjectCopy(id),
  }));

  handle(IPC.projectsBaseSyncInspect, async (id: string) => {
    const project = projectOf(id);
    if (!project) return null;
    const status = await inspectBase(project.path, project.baseRef);
    return { ...status, projectId: project.id };
  });

  handle(IPC.projectsBaseSync, async (id: string) => {
    const project = projectOf(id);
    if (!project) return null;
    const result = await syncBase(project.path, project.baseRef);
    return { ok: result.ok, status: { ...result.status, projectId: project.id } };
  });
}
