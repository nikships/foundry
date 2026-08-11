/**
 * The Smith IPC slice: the approval gate, and the handoff into the user's
 * terminal. Four invoke channels — two that read what a session needs and open a
 * terminal at it, two that drive the proposal card — plus `saveProposal`, the
 * store write an approve resolves to.
 */

import { existsSync } from 'node:fs';
import type {
  AgentDef,
  EnvelopeDef,
  PipelineDef,
  SmithLaunchInfo,
  SmithProposal,
  SmithProposalAnswer,
} from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import { foundryCliPath, smithBootstrap, smithSkillDir } from '../smith/launch.js';
import { openDirectoryInTerminal, terminalFor, terminalInstalled } from '../system/terminal.js';
import type { Handle } from './shared.js';
import { notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'smith' | 'broadcast'>;

/** What the launcher reads and what the terminal button acts on. */
type LaunchCtx = Pick<AppContext, 'projects' | 'settings' | 'smith'>;

export function registerLaunch(ctx: LaunchCtx, handle: Handle): void {
  handle(IPC.smithLaunchInfo, (projectId: string): SmithLaunchInfo => launchInfo(ctx, projectId));

  handle(
    IPC.smithOpenTerminal,
    async (projectId: string): Promise<{ ok: boolean; error?: string }> => {
      const project = projectId ? ctx.projects.get(projectId) : null;
      if (!project) return { ok: false, error: 'Select a project first' };
      const terminal = terminalFor(ctx.settings.get().terminalApp);
      try {
        await openDirectoryInTerminal(project.path, terminal.appName);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  );
}

/**
 * Resolved once per launcher open rather than cached: the app can be moved, the
 * terminal preference changed, and the project switched between opens.
 */
function launchInfo(ctx: LaunchCtx, projectId: string): SmithLaunchInfo {
  const project = projectId ? ctx.projects.get(projectId) : null;
  const cliPath = foundryCliPath();
  const terminal = terminalFor(ctx.settings.get().terminalApp);
  return {
    cliPath,
    skillDir: smithSkillDir(),
    socketPath: ctx.smith.socket.path(),
    bootstrap: smithBootstrap({ cliPath, projectId: project?.id }),
    terminal: { ...terminal, installed: terminalInstalled(terminal.appName) },
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
