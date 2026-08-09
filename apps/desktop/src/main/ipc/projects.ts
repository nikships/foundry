import { BrowserWindow, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import type { ProjectDef } from '@shared/types.js';
import {
  IPC,
  type DetectCommandsResult,
  type SaveResult,
  type TryCommandResult,
} from '@shared/ipc-contract.js';
import { runCommand } from '../engine/commands.js';
import { sniffCommands } from '../engine/detect.js';
import { adapterFor } from '../cli/index.js';
import { currentBranch, isRepo } from '../engine/git.js';
import { checkProject } from '../system/doctor.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'projects' | 'settings' | 'window' | 'broadcast' | 'detections'>;

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);
  const detections = ctx.detections;

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
    notifySettings(ctx);
    return ctx.projects.get(project.id) ?? project;
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
      const vendor = settings.detectCli === 'default' ? settings.defaultCli : settings.detectCli;
      const cli = settings.clis[vendor];
      if (!cli) return { error: `no CLI configured for ${vendor}` };

      // A model id is meaningful only to the CLI that published it. An id
      // chosen while another vendor was selected would be rejected on the
      // first turn, so it is dropped rather than sent.
      let model = settings.detectModel || 'inherit';
      if (model !== 'inherit') {
        const known = await adapterFor(vendor)
          .models(cli.path)
          .catch(() => []);
        if (known.length && !known.some((m) => m.id === model)) model = 'inherit';
      }

      const session = detections.start({
        projectId: project.id,
        projectPath: project.path,
        existingCommands: project.commands.map((c) => c.name),
        settings,
        vendor,
        model,
      });
      return { detectionId: session.detectionId };
    },
  );

  handle(IPC.projectsCancelDetection, (detectionId: string) => detections.cancel(detectionId));

  handle(IPC.projectsDetection, (detectionId: string) => detections.get(detectionId));

  handle(IPC.projectsCheck, async (id: string) => {
    const project = projectOf(id);
    return project ? checkProject(project) : [];
  });

  handle(IPC.projectsReveal, (path: string) => {
    if (existsSync(path)) shell.openPath(path);
  });
}
