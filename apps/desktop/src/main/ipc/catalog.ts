import { IPC } from '@shared/ipc-contract.js';
import { enabledModels } from '../pi/enabled-models.js';
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
  // The picker offers exactly what the Orchestrator's rail accepts, because
  // both read the same answer.
  handle(IPC.catalogAgentModels, () =>
    enabledModels(ctx.supportDir, ctx.settings.get().hiddenModelIds),
  );
}
