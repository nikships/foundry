import type { AppSettings } from '@shared/types.js';
import { IPC, type SaveResult } from '@shared/ipc-contract.js';
import { invalidateCatalog } from '../droid/catalog.js';
import { shutdownDaemonManager } from '../droid/sdk/daemon.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'settings' | 'broadcast' | 'syncFactoryAuth'>;

export function register(ctx: Ctx, handle: Handle): void {
  handle(IPC.settingsGet, () => ctx.settings.get());
  handle(IPC.settingsPatch, (patch: Partial<AppSettings>): SaveResult<AppSettings> => {
    const previous = ctx.settings.get();
    const previousKey = previous.factoryApiKey.trim();
    const result = ctx.settings.patch(patch);
    if (!result.ok) {
      return {
        ok: false,
        issues: result.issues.map((m) => ({ level: 'error', where: 'settings', message: m })),
      };
    }
    // A new droid path can mean a different model table.
    if (patch.clis) invalidateCatalog();
    const nextKey = result.settings.factoryApiKey.trim();
    // Airgap decides both the daemon credential and which models exist, so it
    // needs the same treatment as a key change: re-sync, drop the catalog, and
    // retire a daemon that came up under the old rule.
    if (previous.airgapMode !== result.settings.airgapMode || previousKey !== nextKey) {
      ctx.syncFactoryAuth();
      invalidateCatalog();
      // Drop a daemon that authenticated with the previous credential.
      void shutdownDaemonManager();
    }
    notifySettings(ctx);
    return { ok: true, issues: noIssues, value: result.settings };
  });
}
