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
import { DETECT_PROMPT, parseDetectReply, sniffCommands } from '../engine/detect.js';
import { OneShotClient } from '../droid/oneshot.js';
import { isRepo } from '../engine/git.js';
import { checkProject } from '../system/doctor.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'projects' | 'settings' | 'window' | 'broadcast'>;

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);

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
}
