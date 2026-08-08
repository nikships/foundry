import type { AppSettings } from '@shared/types.js';
import { IPC, type SaveResult } from '@shared/ipc-contract.js';
import { invalidateCatalog } from '../droid/catalog.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'settings' | 'broadcast'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.settingsGet, () => ctx.settings.get());
  handle(IPC.settingsPatch, (patch: Partial<AppSettings>): SaveResult<AppSettings> => {
    const result = ctx.settings.patch(patch);
    if (!result.ok) {
      return {
        ok: false,
        issues: result.issues.map((m) => ({ level: 'error', where: 'settings', message: m })),
      };
    }
    // A new droid path can mean a different model table.
    if (patch.clis) invalidateCatalog();
    notifySettings(ctx);
    return { ok: true, issues: noIssues, value: result.settings };
  });
}
