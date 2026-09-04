import type { PlanImageAttachment, ReasoningEffort } from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import { enabledModels } from '../pi/enabled-models.js';
import { startPlan } from '../orchestrator/start.js';
import { ghStatus } from '../system/gh.js';
import type { Handle } from './shared.js';

type Ctx = Pick<
  AppContext,
  'projects' | 'plans' | 'rosterFor' | 'envelopes' | 'supportDir' | 'settings'
>;

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
      images?: PlanImageAttachment[],
    ): { planId: string } | { error: string } => {
      return startPlan(
        ctx.plans,
        ctx.projects.get(projectId),
        { prompt, model, reasoningEffort, images },
        {
          rosterFor: (id) => ctx.rosterFor(id),
          envelopeDefs: ctx.envelopes.list(),
          defaultModel: ctx.settings.get().defaultModel,
          enabledModels: () => enabledModels(ctx.supportDir, ctx.settings.get().hiddenModelIds),
          ghAvailable: (path) => ghStatus(path).then((status) => status.available),
        },
      );
    },
  );

  /**
   * Takes one follow-up message about the accepted plan and returns
   * immediately; the reply arrives on `orchestrator-progress` like the plan
   * itself did. A non-null return is the refusal reason.
   */
  handle(IPC.orchestratorMessage, (planId: string, text: string): string | null =>
    ctx.plans.message(planId, text),
  );

  handle(IPC.orchestratorCancel, (planId: string) => ctx.plans.cancel(planId));
}
