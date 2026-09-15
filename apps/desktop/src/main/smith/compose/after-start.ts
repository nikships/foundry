import type { AppContext } from '../../context.js';
import { warmStartPrep } from '../../engine/operations.js';
import { enabledModelIds, enabledModels } from '../../pi/enabled-models.js';
import { scmStatus } from '../../system/forge.js';
import type { PlanImageAttachment, ReasoningEffort } from '@shared/types.js';
import { resolveSmithModel } from './model.js';

export type ComposeContext = Pick<
  AppContext,
  'projects' | 'proposals' | 'rosterFor' | 'envelopes' | 'supportDir' | 'settings'
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
      ghAvailable: (path) => scmStatus(path).then((status) => status.available),
    },
  );
  if (!('error' in started)) afterComposeStart(ctx, projectId);
  return started;
}

function afterComposeStart(ctx: ComposeContext, projectId: string): void {
  // The catalog read is memoized upstream. Start reuses a success and retries a failure.
  void warmStartPrep(
    {
      projectById: (id) => ctx.projects.get(id),
      enabledModelIds: () => enabledModelIds(ctx.supportDir, ctx.settings.get().hiddenModelIds),
    },
    projectId,
  );
}
