/**
 * Pull requests, driven entirely through the operator's own `gh` CLI. This
 * router owns the two moments where remote and local state must move together:
 * opening a PR records its coordinates on the run, and merging one settles the
 * matching foundry worktree and fast-forwards the local base ref so the repo
 * agrees with GitHub afterwards.
 */

import type { GhStatus, PrMergeMethod } from '@shared/types.js';
import { IPC, type PrAction, type PrList } from '@shared/ipc-contract.js';
import { landRun, repairBranch } from '../engine/settle.js';
import * as ghLib from '../system/gh.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifyRuns, settleHooks } from './shared.js';

type Ctx = Pick<AppContext, 'projects' | 'registry' | 'settings' | 'broadcast' | 'oneShot'>;

export function register(ctx: Ctx, handle: Handle): void {
  const projectOf = (projectId: string) => ctx.projects.get(projectId);
  const tracerOf = (projectId: string) => {
    const project = projectOf(projectId);
    return project ? { project, tracer: ctx.registry.tracerFor(project) } : null;
  };

  handle(IPC.prsStatus, async (projectId: string): Promise<GhStatus> => {
    const project = projectOf(projectId);
    if (!project) return { available: false, detail: 'project not found' };
    return ghLib.ghStatus(project.path);
  });

  handle(IPC.prsList, async (projectId: string): Promise<PrList> => {
    const project = projectOf(projectId);
    if (!project) return { ok: false, detail: 'project not found', prs: [] };
    return ghLib.listOpenPrs(project.path);
  });

  handle(
    IPC.prsCreate,
    async (projectId: string, runId: string, title: string, body: string): Promise<PrAction> => {
      const scoped = tracerOf(projectId);
      if (!scoped) return { ok: false, detail: 'project not found' };
      const { project, tracer } = scoped;
      const run = tracer.run(runId);
      if (!run?.branch) return { ok: false, detail: 'this run has no branch to open a PR from' };
      if (run.prUrl) {
        return {
          ok: true,
          detail: `a pull request already exists for this run: ${run.prUrl}`,
          number: run.prNumber ?? undefined,
          url: run.prUrl,
        };
      }

      const result = await ghLib.openPr(project.path, {
        branch: run.branch,
        baseRef: run.baseRef ?? project.baseRef,
        title: title.trim() || `${run.pipelineName}: ${run.request.slice(0, 72)}`,
        body,
      });
      if (result.ok && result.number && result.url) tracer.setPr(runId, result.number, result.url);
      tracer.event({
        runId,
        type: 'log',
        name: 'pr create',
        payload: { detail: result.detail },
      });
      notifyRuns(ctx);
      return result;
    },
  );

  handle(
    IPC.prsMerge,
    async (projectId: string, prNumber: number, method: PrMergeMethod): Promise<PrAction> => {
      const scoped = tracerOf(projectId);
      if (!scoped) return { ok: false, detail: 'project not found' };
      return landRun(scoped, settleHooks(ctx), { via: 'ghMerge', prNumber, method });
    },
  );

  /**
   * A conflicting foundry PR still has its worktree, which is exactly the
   * workspace an agent needs: rebase onto the freshly fetched base there,
   * verify with git, force-with-lease push the result. The PR turns mergeable
   * without the operator leaving the app or a hedged error explaining itself.
   */
  handle(IPC.prsFixConflicts, async (projectId: string, prNumber: number): Promise<PrAction> => {
    const scoped = tracerOf(projectId);
    if (!scoped) return { ok: false, detail: 'project not found' };
    return repairBranch(scoped, settleHooks(ctx), { prNumber, then: 'push' });
  });
}
