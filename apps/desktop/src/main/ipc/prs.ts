/**
 * Pull requests, driven entirely through the operator's own `gh` CLI. This
 * router owns the two moments where remote and local state must move together:
 * opening a PR records its coordinates on the run, and merging one settles the
 * matching foundry worktree and fast-forwards the local base ref so the repo
 * agrees with GitHub afterwards.
 */

import type { PrMergeMethod } from '@shared/types.js';
import { IPC, type PrAction, type PrList } from '@shared/ipc-contract.js';
import type { GhStatus } from '@shared/types.js';
import { deleteRemoteBranch, fastForwardBase, preferredRemote } from '../engine/git.js';
import * as worktreeLib from '../engine/worktree.js';
import * as ghLib from '../system/gh.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifyRuns } from './shared.js';

type Ctx = Pick<AppContext, 'projects' | 'registry' | 'broadcast'>;

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
      const { project, tracer } = scoped;

      const merged = await ghLib.mergePr(project.path, prNumber, method);
      if (!merged.ok) return { ok: false, detail: merged.detail, number: prNumber };

      const notes = [merged.detail];
      const branch = merged.headRefName;
      const isFoundryBranch = !!branch && branch.startsWith('foundry/');

      // A foundry branch maps 1:1 to a run; settle its local leftovers the
      // same way an in-app merge would, so nothing lingers in Maintenance.
      if (isFoundryBranch) {
        const runId = branch.slice('foundry/'.length);
        const run = tracer.run(runId);
        if (run) {
          if (run.worktreePath) {
            const removed = await worktreeLib.discard(project.path, {
              path: run.worktreePath,
              branch,
              baseRef: run.baseRef ?? project.baseRef,
              branchPointSha: run.branchPointSha ?? '',
            });
            tracer.setWorktree(runId, null, run.branch);
            if (removed.removed) notes.push('worktree removed');
          }
          tracer.setMerged(runId, true);
          tracer.event({
            runId,
            type: 'log',
            name: 'pr merge',
            payload: { detail: `${merged.detail} via ${method}` },
          });
        }
      }

      // The PR merged either way; everything below is local/remote cleanup,
      // and a skipped or failed step must say so rather than pass silently.
      const remote = await preferredRemote(project.path);
      if (!remote) {
        notes.push('no git remote found: skipped branch cleanup and base fast-forward');
      } else {
        // Only foundry branches are Foundry's to clean up on the remote.
        if (isFoundryBranch && branch) {
          const del = await deleteRemoteBranch(project.path, remote, branch);
          if (!del.ok) {
            notes.push(
              `could not delete remote ${branch}: ${del.stdout.trim().split('\n')[0] || 'see git'}`,
            );
          }
        }
        const baseRef = merged.baseRefName || project.baseRef;
        const ff = await fastForwardBase(project.path, remote, baseRef);
        notes.push(
          ff.ok
            ? `${baseRef} fast-forwarded`
            : `could not fast-forward ${baseRef}: ${ff.stdout.trim().split('\n')[0] || 'see git'}`,
        );
      }

      notifyRuns(ctx);
      return { ok: true, detail: notes.join('; '), number: prNumber, url: merged.url };
    },
  );
}
