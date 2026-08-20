import { IPC } from '@shared/ipc-contract.js';
import { withoutHiddenModels } from '@shared/model-visibility.js';
import { GATE_DESCRIPTIONS } from '../engine/gates.js';
import { TEMPLATE_VARIABLES } from '../engine/prompts.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';

type Ctx = Pick<AppContext, 'supportDir' | 'settings'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.catalogGates, () =>
    Object.entries(GATE_DESCRIPTIONS).map(([id, description]) => ({ id, description })),
  );
  handle(IPC.catalogTemplateVariables, () => TEMPLATE_VARIABLES);
  handle(IPC.catalogAgentModels, async () => {
    // Loaded lazily: building pi's runtime restores catalogs off disk, and a
    // renderer that never opens the model picker should not pay for it.
    const { availableModels } = await import('../pi/catalog.js');
    try {
      const models = await availableModels(ctx.supportDir);
      return withoutHiddenModels(models, ctx.settings.get().hiddenModelIds);
    } catch {
      // An unbuildable runtime (a half-written catalog, no credentials at all)
      // is an empty picker, not a failed call: the pane says "no models" rather
      // than showing an error the operator cannot act on.
      return [];
    }
  });
}
