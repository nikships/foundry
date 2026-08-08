import { existsSync } from 'node:fs';
import type { MaintenanceReport, OrphanWorktree } from '@shared/types.js';
import { IPC, type WorktreeAction } from '@shared/ipc-contract.js';
import * as worktreeLib from '../engine/worktree.js';
import { runDoctor } from '../system/doctor.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifyRuns } from './shared.js';

type Ctx = Pick<AppContext, 'settings' | 'projects' | 'registry' | 'broadcast'>;

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);

  handle(IPC.doctorRun, () => runDoctor(ctx.settings.get()));

  handle(IPC.maintenanceOrphans, async (): Promise<OrphanWorktree[]> => {
    const out: OrphanWorktree[] = [];
    for (const project of ctx.projects.list()) {
      if (!existsSync(project.path)) continue;
      const orphans = await worktreeLib.findOrphans({
        repo: project.path,
        projectId: project.id,
        activeRunIds: ctx.registry.tracerFor(project).activeRunIds(),
      });
      out.push(...orphans);
    }
    return out;
  });

  handle(
    IPC.maintenanceRemoveWorktree,
    async (projectId: string, path: string): Promise<WorktreeAction> => {
      const project = projectOf(projectId);
      if (!project) return { ok: false, detail: 'project not found' };
      const runId = path.split('/').pop() ?? '';
      const outcome = await worktreeLib.discard(project.path, {
        path,
        branch: worktreeLib.branchNameFor(runId),
        baseRef: project.baseRef,
        branchPointSha: '',
      });
      return { ok: outcome.removed, detail: outcome.detail };
    },
  );

  handle(IPC.maintenanceRetention, (): MaintenanceReport => {
    const days = ctx.settings.get().retentionDays;
    let runsDeleted = 0;
    if (days) {
      for (const project of ctx.projects.list()) {
        runsDeleted += ctx.registry.tracerFor(project).deleteRunsOlderThan(days).length;
      }
    }
    notifyRuns(ctx);
    return { runsDeleted, bytesReclaimed: 0, worktreesRemoved: 0 };
  });

  handle(IPC.maintenanceCompact, () => {
    for (const project of ctx.projects.list()) ctx.registry.tracerFor(project).compact();
  });
}
