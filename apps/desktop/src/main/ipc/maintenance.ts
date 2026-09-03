import { existsSync } from 'node:fs';
import type { MaintenanceReport, OrphanWorktree } from '@shared/types.js';
import { IPC, type WorktreeAction } from '@shared/ipc-contract.js';
import * as worktreeLib from '../engine/worktree.js';
import { runDoctor } from '../system/doctor.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifyRuns } from './shared.js';

type Ctx = Pick<
  AppContext,
  'settings' | 'projects' | 'registry' | 'broadcast' | 'bridge' | 'supportDir'
>;

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);

  handle(IPC.doctorRun, () =>
    runDoctor({
      ensureBridge: async () => {
        const result = await ctx.bridge.ensure();
        return result.ok
          ? { ok: true, detail: `serving on ${result.baseUrl}` }
          : { ok: false, detail: result.detail, reason: result.reason };
      },
      bridgeProviders: () => ctx.bridge.snapshot().providers,
      agentModels: async () => {
        // Lazy: building pi's runtime reads catalogs off disk, and the doctor
        // is the only caller in this router that needs one.
        const { availableModels } = await import('../pi/catalog.js');
        return availableModels(ctx.supportDir);
      },
      hiddenModelIds: () => ctx.settings.get().hiddenModelIds,
    }),
  );

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

  handle(IPC.maintenanceRemoveAllWorktrees, async (): Promise<WorktreeAction> => {
    const projects = ctx.projects.list();
    const targetLists = await Promise.all(
      projects.map(async (project) => {
        if (!existsSync(project.path)) return [];
        return worktreeLib.findOrphans({
          repo: project.path,
          projectId: project.id,
          activeRunIds: ctx.registry.tracerFor(project).activeRunIds(),
        });
      }),
    );
    const targets = targetLists.flat();
    if (targets.length === 0) return { ok: true, detail: 'no leftover worktrees' };
    const byProject = new Map<string, OrphanWorktree[]>();
    for (const orphan of targets) {
      const list = byProject.get(orphan.projectId) ?? [];
      list.push(orphan);
      byProject.set(orphan.projectId, list);
    }
    // One project at a time: git serialises on a lock per repository, so
    // parallel removals in the same repo only queue behind each other anyway.
    let removed = 0;
    const failures: string[] = [];
    for (const [projectId, orphans] of byProject) {
      const project = projectOf(projectId);
      if (!project) {
        failures.push(`${projectId}: project not found`);
        continue;
      }
      for (const orphan of orphans) {
        const runId = orphan.path.split('/').pop() ?? '';
        const outcome = await worktreeLib.discard(project.path, {
          path: orphan.path,
          branch: worktreeLib.branchNameFor(runId),
          baseRef: project.baseRef,
          branchPointSha: '',
        });
        if (outcome.removed) removed += 1;
        else failures.push(`${orphan.path}: ${outcome.detail}`);
      }
    }
    const detail =
      failures.length === 0
        ? `removed ${removed} leftover worktree${removed === 1 ? '' : 's'}`
        : `removed ${removed} of ${targets.length} leftover worktrees: ${failures.join('; ')}`;
    return { ok: failures.length === 0, detail };
  });

  handle(IPC.maintenanceRetention, (): MaintenanceReport => {
    const days = ctx.settings.get().retentionDays;
    let runsDeleted = 0;
    let bytesReclaimed = 0;
    if (days) {
      for (const project of ctx.projects.list()) {
        const swept = ctx.registry.tracerFor(project).deleteRunsOlderThan(days);
        runsDeleted += swept.runIds.length;
        bytesReclaimed += swept.bytesReclaimed;
      }
    }
    notifyRuns(ctx);
    // Worktrees are removed through `maintenanceRemoveWorktree`, which is a
    // separate operator action; retention has never touched one.
    return { runsDeleted, bytesReclaimed, worktreesRemoved: 0 };
  });

  handle(IPC.maintenanceCompact, () => {
    for (const project of ctx.projects.list()) ctx.registry.tracerFor(project).compact();
  });
}
