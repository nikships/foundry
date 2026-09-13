import type { AppContext } from '../../context.js';
import { warmStartPrep } from '../../engine/operations.js';
import { enabledModelIds, enabledModels } from '../../pi/enabled-models.js';
import { ghStatus } from '../../system/gh.js';
import { IPC } from '@shared/ipc-contract.js';
import type { PlanImageAttachment, ReasoningEffort } from '@shared/types.js';
import { resolveSmithModel } from './model.js';

export type ComposeContext = Pick<
  AppContext,
  | 'projects'
  | 'proposals'
  | 'rosterFor'
  | 'envelopes'
  | 'supportDir'
  | 'settings'
  | 'oneShot'
  | 'broadcast'
>;

/** The desktop and chat share guards, model resolution, and non-blocking prep. */
export function startComposeWithPrep(
  ctx: ComposeContext,
  projectId: string,
  input: {
    prompt: string;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    images?: PlanImageAttachment[];
  },
): { planId: string } | { error: string } {
  const started = ctx.proposals.start(
    ctx.projects.get(projectId),
    { ...input, ...resolveSmithModel(ctx.settings.get(), 'compose', input) },
    {
      rosterFor: (id) => ctx.rosterFor(id),
      envelopeDefs: ctx.envelopes.list(),
      defaultModel: ctx.settings.get().defaultModel,
      enabledModels: () => enabledModels(ctx.supportDir, ctx.settings.get().hiddenModelIds),
      ghAvailable: (path) => ghStatus(path).then((status) => status.available),
    },
  );
  if (!('error' in started)) afterComposeStart(ctx, projectId);
  return started;
}

function afterComposeStart(ctx: ComposeContext, projectId: string): void {
  // Both resources are deduped upstream. Start reuses successes and retries failures.
  void warmStartPrep(
    {
      projectById: (id) => ctx.projects.get(id),
      settings: () => ctx.settings.get(),
      saveProject: (next) => {
        if (ctx.projects.save(next).ok) ctx.broadcast(IPC.eventSettingsChanged);
      },
      enabledModelIds: () => enabledModelIds(ctx.supportDir, ctx.settings.get().hiddenModelIds),
      oneShot: ctx.oneShot,
    },
    projectId,
  );
}
