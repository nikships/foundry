import type { AgentDef } from '@shared/types.js';
import { IPC, type SaveResult } from '@shared/ipc-contract.js';
import { validate as validateAgent } from '../store/roster.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'roster' | 'rosterFor' | 'rosterScope' | 'broadcast'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.rosterList, (projectId?: string) => ctx.rosterFor(projectId));

  handle(IPC.rosterSave, (agent: AgentDef, projectId?: string): SaveResult<AgentDef[]> => {
    const result = ctx.roster.save(agent, ctx.rosterScope(projectId));
    if (!result.ok) return { ok: false, issues: result.issues };
    notifySettings(ctx);
    return { ok: true, issues: noIssues, value: result.agents };
  });

  handle(IPC.rosterRemove, (name: string, projectId?: string) => {
    const agents = ctx.roster.remove(name, ctx.rosterScope(projectId));
    notifySettings(ctx);
    return agents;
  });

  handle(IPC.rosterDuplicate, (name: string, projectId?: string) =>
    ctx.roster.duplicate(name, ctx.rosterScope(projectId)),
  );

  handle(IPC.rosterValidate, (agent: AgentDef) => validateAgent(agent));

  handle(IPC.rosterReset, () => {
    const agents = ctx.roster.resetToBuiltins();
    notifySettings(ctx);
    return agents;
  });
}
