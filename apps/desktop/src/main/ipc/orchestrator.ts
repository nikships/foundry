import type { ReasoningEffort } from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import { ghStatus } from '../system/gh.js';
import type { Handle } from './shared.js';

type Ctx = Pick<AppContext, 'projects' | 'plans' | 'rosterFor' | 'envelopes'>;

export function register(ctx: Ctx, handle: Handle): void {
  /**
   * Opens a planning session and returns its id immediately; the plan (or the
   * failure) arrives on `orchestrator-progress`, never on this invoke — a
   * click is not left awaiting a five-minute turn.
   */
  handle(
    IPC.orchestratorPlan,
    (
      projectId: string,
      prompt: string,
      model: string,
      reasoningEffort: ReasoningEffort,
    ): { planId: string } | { error: string } => {
      const project = ctx.projects.get(projectId);
      if (!project) return { error: 'project not found' };
      if (!prompt.trim()) return { error: 'a plan needs a request' };

      const planId = ctx.plans.start({
        projectId: project.id,
        projectPath: project.path,
        prompt,
        model: model || 'inherit',
        reasoningEffort,
        contextSummary: project.contextSummary ?? '',
        commands: project.commands,
        roster: ctx.rosterFor(projectId),
        envelopeDefs: ctx.envelopes.list(),
        scaffold: project.scaffold === true,
        ghAvailable: async () => (await ghStatus(project.path)).available,
      });
      return { planId };
    },
  );

  handle(IPC.orchestratorCancel, (planId: string) => ctx.plans.cancel(planId));
}
