import type { AgentDef } from '@shared/types.js';
import {
  IPC,
  type AgentMarkUploadResult,
  type RenameResult,
  type SaveResult,
} from '@shared/ipc-contract.js';
import { exampleFor } from '../engine/envelopes.js';
import { validate as validateAgent } from '../store/roster.js';
import { removeAgentMark, saveAgentMark } from '../store/agent-marks.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<
  AppContext,
  | 'roster'
  | 'rosterFor'
  | 'rosterScope'
  | 'pipelines'
  | 'pipelineScope'
  | 'envelopes'
  | 'broadcast'
  | 'supportDir'
>;

export function register(ctx: Ctx, handle: Handle): void {
  const knownEnvelopeNames = () => ctx.envelopes.list().map((e) => e.name);

  handle(IPC.rosterList, (projectId?: string) => ctx.rosterFor(projectId));
  handle(IPC.rosterStaleBuiltins, (projectId?: string) =>
    ctx.roster.staleBuiltins(ctx.rosterScope(projectId)),
  );

  handle(IPC.rosterSave, (agent: AgentDef, projectId?: string): SaveResult<AgentDef[]> => {
    const result = ctx.roster.save(agent, ctx.rosterScope(projectId), knownEnvelopeNames());
    if (!result.ok) return { ok: false, issues: result.issues };
    notifySettings(ctx);
    return { ok: true, issues: noIssues, value: result.agents };
  });

  handle(IPC.rosterRename, (from: string, to: string, projectId?: string): RenameResult => {
    const result = ctx.roster.rename(from, to, ctx.rosterScope(projectId));
    if (!result.ok) return { ok: false, issues: result.issues };
    // A fork leaves the old agent in place, so phases naming it still resolve;
    // only a true rename would strand them.
    if (!result.forked) {
      ctx.pipelines.renameAgentRefs(from, to, ctx.pipelineScope(projectId));
    }
    notifySettings(ctx);
    return { ok: true, issues: noIssues, agents: result.agents, forked: result.forked };
  });

  handle(IPC.rosterRemove, (name: string, projectId?: string) => {
    const agents = ctx.roster.remove(name, ctx.rosterScope(projectId));
    notifySettings(ctx);
    return agents;
  });

  handle(IPC.rosterDuplicate, (name: string, projectId?: string) =>
    ctx.roster.duplicate(name, ctx.rosterScope(projectId)),
  );

  handle(IPC.rosterValidate, (agent: AgentDef) => validateAgent(agent, knownEnvelopeNames()));

  // Rendered from the draft rather than the saved agent so the preview tracks
  // an unsaved edit, and through `exampleFor` so it is the same text the run
  // embeds in the prompt.
  handle(IPC.rosterPreview, (agent: AgentDef) =>
    exampleFor(agent.envelope, agent.customFields, ctx.envelopes.list()),
  );

  handle(IPC.rosterReset, (name: string, projectId?: string) => {
    const agents = ctx.roster.resetBuiltin(name, ctx.rosterScope(projectId));
    notifySettings(ctx);
    return agents;
  });

  handle(IPC.rosterUploadMark, (bytesB64: string, mime: string): AgentMarkUploadResult =>
    saveAgentMark(ctx.supportDir, bytesB64, mime),
  );

  handle(IPC.rosterRemoveMark, (emblem: string): boolean =>
    removeAgentMark(ctx.supportDir, emblem),
  );
}
