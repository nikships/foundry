import type { CliVendor } from '@shared/types.js';
import { IPC } from '@shared/ipc-contract.js';
import { GATE_DESCRIPTIONS } from '../engine/gates.js';
import { TEMPLATE_VARIABLES } from '../engine/prompts.js';
import { invalidateCatalog } from '../droid/catalog.js';
import { adapterFor, allAdapters, cliConfigFor } from '../cli/index.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';

type Ctx = Pick<AppContext, 'settings'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.catalogModels, (vendor: CliVendor, force?: boolean) => {
    if (force) invalidateCatalog();
    return adapterFor(vendor).models(cliConfigFor(ctx.settings.get().clis, vendor).path);
  });
  handle(IPC.catalogTools, (vendor: CliVendor, model?: string) => {
    const adapter = adapterFor(vendor);
    // Only droid enumerates tools; the rest scope them by sandbox, so an empty
    // list is the honest answer rather than a failed call. droid's own answer is
    // empty too until a session has run — enumerating tools is not something a
    // binary can be asked without one.
    return (
      adapter.tools?.(cliConfigFor(ctx.settings.get().clis, vendor).path, model) ??
      Promise.resolve([])
    );
  });
  handle(IPC.catalogClis, () =>
    allAdapters().map((a) => ({
      id: a.id,
      label: a.label,
      binary: a.binary,
      docsUrl: a.docsUrl,
      authEnvVars: a.authEnvVars,
      supportsRpc: a.supportsRpc,
      caveats: a.caveats,
    })),
  );
  handle(IPC.catalogGates, () =>
    Object.entries(GATE_DESCRIPTIONS).map(([id, description]) => ({ id, description })),
  );
  handle(IPC.catalogTemplateVariables, () => TEMPLATE_VARIABLES);
}
