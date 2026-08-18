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
import {
  deleteRemoteBranch,
  fastForwardBase,
  fetchRef,
  preferredRemote,
  pushBranchForceWithLease,
  resolveRef,
} from '../engine/git.js';
import { rebaseOntoBase, repairAgent } from '../engine/repair.js';
import * as worktreeLib from '../engine/worktree.js';
import * as ghLib from '../system/gh.js';
import type { AppContext } from '../context.js';
import type { Handle } from './shared.js';
import { notifyRuns } from './shared.js';

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
            tracer.setWorktree(runId, null, branch);
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

  /**
   * A conflicting foundry PR still has its worktree, which is exactly the
   * workspace an agent needs: rebase onto the freshly fetched base there,
   * verify with git, force-with-lease push the result. The PR turns mergeable
   * without the operator leaving the app or a hedged error explaining itself.
   */
  handle(IPC.prsFixConflicts, async (projectId: string, prNumber: number): Promise<PrAction> => {
    const scoped = tracerOf(projectId);
    if (!scoped) return { ok: false, detail: 'project not found' };
    const { project, tracer } = scoped;

    const pr = await ghLib.viewPr(project.path, prNumber);
    if (!pr)
      return { ok: false, detail: `could not read PR #${prNumber} via gh`, number: prNumber };
    if (!pr.headRefName.startsWith('foundry/')) {
      return {
        ok: false,
        detail: `#${prNumber} is not a foundry run branch — resolve it where the branch lives`,
        number: prNumber,
      };
    }
    const runId = pr.headRefName.slice('foundry/'.length);
    const run = tracer.run(runId);
    if (!run?.worktreePath) {
      return {
        ok: false,
        detail: "this run's worktree is gone, so there is nowhere local to repair the branch",
        number: prNumber,
      };
    }

    const remote = await preferredRemote(project.path);
    if (!remote) return { ok: false, detail: 'this repo has no git remote', number: prNumber };
    const baseRef = pr.baseRefName || project.baseRef;
    const fetched = await fetchRef(project.path, remote, baseRef);
    if (!fetched.ok) {
      return { ok: false, detail: `could not fetch ${baseRef} from ${remote}`, number: prNumber };
    }
    const ontoSha = await resolveRef(project.path, 'FETCH_HEAD');
    if (!ontoSha) {
      return { ok: false, detail: `could not resolve the fetched ${baseRef}`, number: prNumber };
    }

    const settings = ctx.settings.get();
    const outcome = await rebaseOntoBase({
      worktreePath: run.worktreePath,
      branch: pr.headRefName,
      ontoSha,
      ontoLabel: `${remote}/${baseRef}`,
      agent: repairAgent(ctx.oneShot, settings, run.worktreePath),
      timeoutMs: settings.turnTimeoutMs,
    });
    tracer.event({ runId, type: 'log', name: 'agent fix', payload: { detail: outcome.detail } });
    if (!outcome.ok) {
      notifyRuns(ctx);
      return { ok: false, detail: outcome.detail, number: prNumber };
    }

    tracer.setBranchPoint(runId, ontoSha);
    const pushed = await pushBranchForceWithLease(project.path, remote, pr.headRefName);
    notifyRuns(ctx);
    if (!pushed.ok) {
      return {
        ok: false,
        detail: `${outcome.detail}; but the push was refused: ${pushed.stdout.trim().split('\n')[0] || 'see git'}`,
        number: prNumber,
      };
    }
    return {
      ok: true,
      detail: `${outcome.detail}; pushed — GitHub is recomputing mergeability`,
      number: prNumber,
      url: pr.url,
    };
  });
}
