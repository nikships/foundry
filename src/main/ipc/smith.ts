/**
 * The Smith IPC slice: the approval gate, and the handoff into the user's
 * terminal. Five invoke channels — three that read what a session needs and get
 * one running, two that drive the proposal card — plus `saveProposal`, the store
 * write an approve resolves to.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type {
  AgentDef,
  EnvelopeDef,
  PipelineDef,
  SmithLaunchInfo,
  SmithProposal,
  SmithProposalAnswer,
  SmithStartResult,
} from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import { whichBinary } from '../system/env.js';
import { foundryCliPath, smithBootstrap, smithPrompt, smithSkillDir } from '../smith/launch.js';
import { prepareSession } from '../smith/session.js';
import {
  openDirectoryInTerminal,
  runCommandInTerminal,
  terminalFor,
  terminalInstalled,
} from '../system/terminal.js';
import type { Handle } from './shared.js';
import { notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'smith' | 'broadcast'>;

/**
 * The agent a prepared Smith window opens on.
 *
 * Smith is a skill loaded into the operator's own agent, so this names the one
 * harness Foundry can start unattended rather than the transport the app runs
 * its own phases on. An operator on any other agent uses the copyable bootstrap.
 */
const SMITH_AGENT_BINARY = 'droid';

/** What the launcher reads and what the terminal button acts on. */
type LaunchCtx = Pick<AppContext, 'projects' | 'settings' | 'smith' | 'supportDir'>;

export function registerLaunch(ctx: LaunchCtx, handle: Handle): void {
  handle(IPC.smithLaunchInfo, (projectId: string): SmithLaunchInfo => launchInfo(ctx, projectId));

  /**
   * The sidebar's click. Answers `started` only when a session is genuinely up,
   * so the renderer never has to guess whether to open the launcher.
   */
  handle(IPC.smithStart, async (projectId: string): Promise<SmithStartResult> => {
    const info = launchInfo(ctx, projectId);
    const project = projectId ? ctx.projects.get(projectId) : null;
    if (!project || !info.project?.exists) {
      return { status: 'needs-launcher', reason: 'project' };
    }
    if (!info.canAutoStart) {
      return { status: 'needs-launcher', reason: info.autoStartBlocked };
    }
    try {
      await startPreparedSession(ctx, info, project);
      return { status: 'started' };
    } catch (e) {
      return { status: 'error', error: (e as Error).message };
    }
  });

  handle(
    IPC.smithOpenTerminal,
    async (projectId: string): Promise<{ ok: boolean; error?: string }> => {
      const project = projectId ? ctx.projects.get(projectId) : null;
      if (!project) return { ok: false, error: 'Select a project first' };
      const info = launchInfo(ctx, projectId);
      try {
        if (info.canAutoStart) {
          await startPreparedSession(ctx, info, project);
        } else {
          await openDirectoryInTerminal(project.path, info.terminal.appName);
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
}

/**
 * Writes the session files and hands them to the terminal. Shared by both
 * launch channels so the sidebar's one-click path and the launcher's button
 * cannot drift into starting two different sessions.
 */
async function startPreparedSession(
  ctx: LaunchCtx,
  info: SmithLaunchInfo,
  project: { id: string; path: string },
): Promise<void> {
  const session = prepareSession({
    sessionDir: join(ctx.supportDir, 'smith'),
    cliPath: info.cliPath,
    agentPath: agentCliPath(),
    prompt: info.prompt,
    projectPath: project.path,
    socketPath: info.socketPath,
    shell: loginShell(),
    projectId: project.id,
  });
  await runCommandInTerminal({
    appName: info.terminal.appName,
    directoryPath: project.path,
    command: ['/bin/sh', session.scriptPath],
  });
}

/**
 * The agent CLI a prepared session starts.
 *
 * Smith runs in the user's own terminal on the user's own agent, so this is a
 * PATH lookup rather than a setting: Foundry itself no longer spawns an agent
 * binary and has nowhere to record one. A bare name is not something a script
 * with its own PATH can be trusted to resolve, so an auto-start demands a real
 * file and declines otherwise rather than opening a window that fails on its
 * first line.
 */
function agentCliPath(): string {
  return whichBinary(SMITH_AGENT_BINARY) ?? SMITH_AGENT_BINARY;
}

function agentCliInstalled(): boolean {
  const path = agentCliPath();
  return isAbsolute(path) && existsSync(path);
}

/** The shell the window is left in once the agent exits. */
function loginShell(): string {
  const shell = process.env.SHELL;
  return shell && existsSync(shell) ? shell : '/bin/zsh';
}

/**
 * Resolved once per launcher open rather than cached: the app can be moved, the
 * terminal preference changed, and the project switched between opens.
 */
function launchInfo(ctx: LaunchCtx, projectId: string): SmithLaunchInfo {
  const project = projectId ? ctx.projects.get(projectId) : null;
  const cliPath = foundryCliPath();
  const skillDir = smithSkillDir();
  const terminal = terminalFor(ctx.settings.get().terminalApp);
  const installed = terminalInstalled(terminal.appName);
  const terminalCapable = !!terminal.prepared && installed;
  const hasAgent = agentCliInstalled();
  const projectReady = !!project && existsSync(project.path);
  // The project's own problems are reported by the launcher's own notice, so
  // they are not repeated as an auto-start blocker — only as a reason not to
  // claim the session will start itself.
  const blocked = !terminalCapable ? 'terminal' : !hasAgent ? 'agent-cli' : undefined;
  return {
    cliPath,
    skillDir,
    socketPath: ctx.smith.socket.path(),
    bootstrap: smithBootstrap({ cliPath, projectId: project?.id }),
    terminal: { ...terminal, installed },
    canAutoStart: !blocked && projectReady,
    autoStartBlocked: blocked,
    prompt: smithPrompt({ skillDir, projectName: project?.name }),
    project: project
      ? {
          id: project.id,
          name: project.name,
          path: project.path,
          exists: existsSync(project.path),
        }
      : null,
  };
}

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.smithProposalsList, () => ctx.smith.proposals.list());
  handle(IPC.smithProposalAnswer, (id: string, answer: SmithProposalAnswer) =>
    ctx.smith.proposals.answer(id, answer),
  );
}

/**
 * Persists an approved proposal through the existing store layer, scope-aware,
 * and broadcasts the same settings-changed event a form save would. Returns the
 * saved entity for the CLI, or an error the proposal card can show. Wired into
 * the queue from `context.ts` so the queue never imports a store.
 */
export function saveProposal(
  ctx: Pick<
    AppContext,
    | 'roster'
    | 'pipelines'
    | 'envelopes'
    | 'rosterScope'
    | 'pipelineScope'
    | 'rosterFor'
    | 'commandNames'
    | 'broadcast'
  >,
  proposal: SmithProposal,
): { ok: true; entity: unknown } | { ok: false; error: string } {
  const projectId = proposal.projectId || undefined;
  const knownEnvelopes = ctx.envelopes.list().map((e) => e.name);

  if (proposal.kind === 'agent') {
    const agent = proposal.spec as AgentDef;
    const result = ctx.roster.save(agent, ctx.rosterScope(projectId), knownEnvelopes);
    if (!result.ok) return { ok: false, error: issueText(result.issues) };
    notifySettings(ctx);
    return { ok: true, entity: agent };
  }

  if (proposal.kind === 'pipeline') {
    const pipeline = proposal.spec as PipelineDef;
    const result = ctx.pipelines.save(
      pipeline,
      ctx.rosterFor(projectId),
      ctx.commandNames(projectId),
      ctx.pipelineScope(projectId),
      knownEnvelopes,
    );
    if (!result.ok) return { ok: false, error: issueText(result.issues) };
    notifySettings(ctx);
    return { ok: true, entity: pipeline };
  }

  const envelope = proposal.spec as EnvelopeDef;
  const result = ctx.envelopes.save(envelope);
  if (!result.ok) return { ok: false, error: issueText(result.issues) };
  notifySettings(ctx);
  return { ok: true, entity: envelope };
}

function issueText(issues: { where: string; message: string }[]): string {
  return issues.map((i) => `${i.where}: ${i.message}`).join('; ') || 'save failed';
}
