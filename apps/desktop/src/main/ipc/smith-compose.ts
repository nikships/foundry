import type {
  GeneratedRunPlan,
  PlanImageAttachment,
  ProposalSnapshot,
  ReasoningEffort,
} from '@shared/types.js';
import { IPC, type ComposeAcceptResult } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import { startComposeWithPrep } from '../smith/compose/after-start.js';
import type { Handle } from './shared.js';

type Ctx = Pick<
  AppContext,
  | 'projects'
  | 'plans'
  | 'proposals'
  | 'rosterFor'
  | 'envelopes'
  | 'supportDir'
  | 'settings'
  | 'oneShot'
  | 'broadcast'
>;

export function register(ctx: Ctx, handle: Handle): void {
  /**
   * Opens a planning session and returns its id immediately; the plan (or the
   * failure) arrives on `smith-compose-progress`, never on this invoke — a
   * click is not left awaiting a five-minute turn.
   */
  handle(
    IPC.smithComposeStart,
    (
      projectId: string,
      prompt: string,
      model: string,
      reasoningEffort: ReasoningEffort,
      images?: PlanImageAttachment[],
    ): { planId: string } | { error: string } => {
      // Durable proposals: one independent row per call, never cancelling
      // siblings. The composer stays usable for the next prompt immediately.
      return startComposeWithPrep(ctx, projectId, { prompt, model, reasoningEffort, images });
    },
  );

  /**
   * Takes one follow-up message about the accepted plan and returns
   * immediately; the reply arrives on `smith-compose-progress` like the plan
   * itself did. A non-null return is the refusal reason.
   */
  handle(IPC.smithComposeRevise, (planId: string, text: string): string | null =>
    ctx.plans.message(planId, text),
  );

  handle(IPC.smithComposeCancel, (planId: string) => ctx.proposals.cancel(planId));

  /**
   * Durable reads for restore/reconnect: the DB is the source of truth, so a
   * reloaded renderer re-reads these and subscribes to `proposals-changed`.
   */
  handle(IPC.smithComposeList, (projectId: string): ProposalSnapshot[] =>
    ctx.proposals.list(projectId),
  );

  handle(IPC.smithComposeGet, (planId: string): ProposalSnapshot | null =>
    ctx.proposals.get(planId),
  );

  /**
   * Exactly-once accept: proposal accepts must go through here, not
   * `runs:start` directly, so the durable `accepted_run_id` key covers
   * restarts and double-clicks share one run.
   */
  handle(
    IPC.smithComposeAccept,
    (planId: string, plan?: GeneratedRunPlan): Promise<ComposeAcceptResult> =>
      ctx.proposals.accept(planId, plan),
  );

  handle(IPC.smithComposeDiscard, (planId: string) => ctx.proposals.discard(planId));
}
