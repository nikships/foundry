import type { AppSettings } from '@shared/types.js';
import { IPC, type SaveResult } from '@shared/ipc-contract.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { noIssues, notifySettings } from './shared.js';

type Ctx = Pick<AppContext, 'settings' | 'projects' | 'roster' | 'broadcast' | 'applyTheme'>;

function resetHiddenAgentModels(ctx: Ctx, hiddenModelIds: readonly string[]): void {
  ctx.roster.resetHiddenModelPins(hiddenModelIds);
  for (const project of ctx.projects.list()) {
    if (ctx.roster.hasProjectCopy(project.id)) {
      ctx.roster.resetHiddenModelPins(hiddenModelIds, {
        projectId: project.id,
        ownRoster: true,
      });
    }
  }
}

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
    if (patch.hiddenModelIds !== undefined) {
      resetHiddenAgentModels(ctx, result.settings.hiddenModelIds);
    }
    ctx.applyTheme(result.settings.theme);
    notifySettings(ctx);
    return { ok: true, issues: noIssues, value: result.settings };
  });
}
