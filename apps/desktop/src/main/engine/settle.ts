/**
 * Run settlement. "A run landed" used to be written four ways inside the
 * runs/prs IPC routers, which `src/main/ipc/AGENTS.md` declares logic-free.
 * This module owns that choreography so the routers stay arg-check + delegate.
 *
 * Two entry points:
 *   - `landRun` — merge the worktree, rebase-then-merge, or settle after a
 *     GitHub merge. The merge/trace/drift/notify tail lives once.
 *   - `repairBranch` — rebase the run branch onto a new base, then merge or
 *     force-with-lease push.
 *
 * Invariants, now internal rather than call-site ordering:
 *   - `setBranchPoint` before a post-repair merge, so `mergeBranch` sees the
 *     new base rather than refusing "base moved"
 *   - `setWorktree(null)` after discard (local merge discards on success)
 *   - command drift only after `merged = true`
 *   - `notifyRuns` after every path that writes the tracer
 *
 * Command drift is run-scoped until a run lands. Landing is `setMerged(true)`,
 * whether the operator merged locally, merged the PR on GitHub, or the
 * executor auto-merged: `command-drift.json` lives in the trace run dir, not
 * the worktree, so discard does not lose it. Every path goes through
 * `recordLanding`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings, PrMergeMethod, ProjectDef, RunRow } from '@shared/types.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import { mergePr, viewPr, type GhOptions } from '../system/gh.js';
import type { EventInput } from '../trace/tracer.js';
import { applyCommandDrifts, parseCommandDrift } from './detect.js';
import {
  deleteRemoteBranch,
  fastForwardBase,
  fetchRef,
  preferredRemote,
  pushBranchForceWithLease,
  resolveRef,
} from './git.js';
import { rebaseOntoBase, repairAgent } from './repair.js';
import * as worktreeLib from './worktree.js';

export interface SettleTracer {
  run(runId: string): RunRow | null;
  runDir(runId: string): string;
  event(input: EventInput): string;
  setMerged(runId: string, merged: boolean): void;
  setBranchPoint(runId: string, sha: string): void;
  setWorktree(runId: string, path: string | null, branch: string | null): void;
}

export interface SettleScope {
  project: ProjectDef;
  tracer: SettleTracer;
}

export interface SettleHooks {
  getSettings(): AppSettings;
  oneShot: OneShotFactory;
  notifyRuns(): void;
  notifySettings(): void;
  saveProject(next: ProjectDef): { ok: boolean };
  gh?: GhOptions;
}

export interface SettleResult {
  ok: boolean;
  detail: string;
  number?: number;
  url?: string;
}

export type LandRunInput =
  | { via: 'merge'; runId: string }
  | { via: 'fixMerge'; runId: string }
  | { via: 'ghMerge'; prNumber: number; method: PrMergeMethod };

export type RepairBranchInput =
  { runId: string; then: 'merge' } | { prNumber: number; then: 'push' };

export async function landRun(
  scoped: SettleScope,
  hooks: SettleHooks,
  input: LandRunInput,
): Promise<SettleResult> {
  if (input.via === 'ghMerge') return landViaGhMerge(scoped, hooks, input);
  if (input.via === 'fixMerge') {
    return repairBranch(scoped, hooks, { runId: input.runId, then: 'merge' });
  }
  return landViaLocalMerge(scoped, hooks, input.runId);
}

export async function repairBranch(
  scoped: SettleScope,
  hooks: SettleHooks,
  input: RepairBranchInput,
): Promise<SettleResult> {
  return input.then === 'push'
    ? repairThenPush(scoped, hooks, input.prNumber)
    : repairThenMerge(scoped, hooks, input.runId);
}

function handleFor(run: RunRow, project: ProjectDef): worktreeLib.WorktreeHandle | null {
  if (!run.worktreePath || !run.branch) return null;
  return {
    path: run.worktreePath,
    branch: run.branch,
    baseRef: run.baseRef ?? project.baseRef,
    branchPointSha: run.branchPointSha ?? '',
  };
}

async function landViaLocalMerge(
  scoped: SettleScope,
  hooks: SettleHooks,
  runId: string,
): Promise<SettleResult> {
  const run = scoped.tracer.run(runId);
  const handle = run ? handleFor(run, scoped.project) : null;
  if (!run || !handle) return { ok: false, detail: 'this run has no worktree' };

  const outcome = await worktreeLib.merge(scoped.project.path, handle);
  if (outcome.merged) {
    recordLanding(scoped, runId, handle.branch, hooks);
  }
  scoped.tracer.event({
    runId,
    type: 'log',
    name: 'worktree merge',
    payload: { detail: outcome.detail },
  });
  hooks.notifyRuns();
  return { ok: outcome.merged, detail: outcome.detail };
}

async function landViaGhMerge(
  scoped: SettleScope,
  hooks: SettleHooks,
  input: { prNumber: number; method: PrMergeMethod },
): Promise<SettleResult> {
  const { project, tracer } = scoped;
  const merged = await mergePr(project.path, input.prNumber, input.method, hooks.gh);
  if (!merged.ok) return { ok: false, detail: merged.detail, number: input.prNumber };

  const notes = [merged.detail];
  const branch = merged.headRefName;
  const isFoundryBranch = !!branch && branch.startsWith('foundry/');

  // A foundry branch maps 1:1 to a run; settle its local leftovers the same
  // way an in-app merge would, so nothing lingers in Maintenance.
  if (isFoundryBranch && branch) {
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
        if (removed.removed) notes.push('worktree removed');
      }
      recordLanding(scoped, runId, branch, hooks);
      tracer.event({
        runId,
        type: 'log',
        name: 'pr merge',
        payload: { detail: `${merged.detail} via ${input.method}` },
      });
    }
  }

  // The PR merged either way; everything below is local/remote cleanup,
  // and a skipped or failed step must say so rather than pass silently.
  const remote = await preferredRemote(project.path);
  if (!remote) {
    notes.push('no git remote found: skipped branch cleanup and base fast-forward');
  } else {
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

  hooks.notifyRuns();
  return { ok: true, detail: notes.join('; '), number: input.prNumber, url: merged.url };
}

async function repairThenMerge(
  scoped: SettleScope,
  hooks: SettleHooks,
  runId: string,
): Promise<SettleResult> {
  const run = scoped.tracer.run(runId);
  const handle = run ? handleFor(run, scoped.project) : null;
  if (!run || !handle) return { ok: false, detail: 'this run has no worktree' };
  if (run.merged) return { ok: false, detail: 'this run is already merged' };

  const ontoSha = await resolveRef(scoped.project.path, handle.baseRef);
  if (!ontoSha) return { ok: false, detail: `${handle.baseRef} does not resolve in this repo` };

  const repaired = await runRepair(scoped, hooks, {
    runId,
    worktreePath: handle.path,
    branch: handle.branch,
    ontoSha,
    ontoLabel: handle.baseRef,
  });
  if (!repaired.ok) return repaired;

  // The branch now sits on the base tip; record that *before* merge so the
  // base-moved check sees the new point rather than refusing the landing.
  scoped.tracer.setBranchPoint(runId, ontoSha);
  const merged = await worktreeLib.merge(scoped.project.path, {
    ...handle,
    branchPointSha: ontoSha,
  });
  if (merged.merged) {
    recordLanding(scoped, runId, handle.branch, hooks);
  }
  scoped.tracer.event({
    runId,
    type: 'log',
    name: 'worktree merge',
    payload: { detail: merged.detail },
  });
  hooks.notifyRuns();
  return {
    ok: merged.merged,
    detail: merged.merged
      ? `${repaired.detail}; merged into ${handle.baseRef}`
      : `${repaired.detail}; but the merge still failed: ${merged.detail}`,
  };
}

async function repairThenPush(
  scoped: SettleScope,
  hooks: SettleHooks,
  prNumber: number,
): Promise<SettleResult> {
  const { project, tracer } = scoped;
  const pr = await viewPr(project.path, prNumber, hooks.gh);
  if (!pr) {
    return { ok: false, detail: `could not read PR #${prNumber} via gh`, number: prNumber };
  }
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

  const repaired = await runRepair(scoped, hooks, {
    runId,
    worktreePath: run.worktreePath,
    branch: pr.headRefName,
    ontoSha,
    ontoLabel: `${remote}/${baseRef}`,
  });
  if (!repaired.ok) return { ...repaired, number: prNumber };

  tracer.setBranchPoint(runId, ontoSha);
  const pushed = await pushBranchForceWithLease(project.path, remote, pr.headRefName);
  hooks.notifyRuns();
  if (!pushed.ok) {
    return {
      ok: false,
      detail: `${repaired.detail}; but the push was refused: ${pushed.stdout.trim().split('\n')[0] || 'see git'}`,
      number: prNumber,
    };
  }
  return {
    ok: true,
    detail: `${repaired.detail}; pushed — GitHub is recomputing mergeability`,
    number: prNumber,
    url: pr.url,
  };
}

async function runRepair(
  scoped: SettleScope,
  hooks: SettleHooks,
  input: {
    runId: string;
    worktreePath: string;
    branch: string;
    ontoSha: string;
    ontoLabel: string;
  },
): Promise<SettleResult> {
  const settings = hooks.getSettings();
  const outcome = await rebaseOntoBase({
    worktreePath: input.worktreePath,
    branch: input.branch,
    ontoSha: input.ontoSha,
    ontoLabel: input.ontoLabel,
    agent: repairAgent(hooks.oneShot, settings, input.worktreePath),
  });
  scoped.tracer.event({
    runId: input.runId,
    type: 'log',
    name: 'agent fix',
    payload: { detail: outcome.detail },
  });
  if (!outcome.ok) {
    hooks.notifyRuns();
    return { ok: false, detail: outcome.detail };
  }
  return { ok: true, detail: outcome.detail };
}

/**
 * The one place a run becomes merged. Drift is applied here so every landing
 * path — local merge, repair-then-merge, GitHub merge, and the executor's
 * auto-merge — updates project commands the same way. Callers must not apply
 * drift without going through this, and must not call this unless the run
 * actually landed.
 */
export function recordLanding(
  scoped: SettleScope,
  runId: string,
  branch: string | null,
  hooks?: Pick<SettleHooks, 'saveProject' | 'notifySettings'>,
): void {
  scoped.tracer.setWorktree(runId, null, branch);
  scoped.tracer.setMerged(runId, true);
  if (hooks) applyStoredCommandDrift(scoped, hooks, runId);
}

function applyStoredCommandDrift(
  scoped: SettleScope,
  hooks: Pick<SettleHooks, 'saveProject' | 'notifySettings'>,
  runId: string,
): void {
  const file = join(scoped.tracer.runDir(runId), 'command-drift.json');
  if (!existsSync(file)) return;
  const drifts = parseCommandDrift(readFileSync(file, 'utf8'));
  if (!drifts.length) return;
  // A run can land long after it was recorded — a PR merged on GitHub weeks
  // later, most likely. Only apply a drift whose `from` still matches the
  // project's current argv; anything else would clobber a newer edit.
  const commandArgv = new Map(scoped.project.commands.map((c) => [c.name, c.argv]));
  const fresh = drifts.filter((d) => argvEqual(commandArgv.get(d.name), d.from));
  const stale = drifts.filter((d) => !fresh.includes(d));
  if (stale.length) {
    scoped.tracer.event({
      runId,
      type: 'log',
      name: 'command_drift_skipped',
      payload: { names: stale.map((d) => d.name) },
    });
  }
  if (!fresh.length) return;
  const saved = hooks.saveProject({
    ...scoped.project,
    commands: applyCommandDrifts(scoped.project.commands, fresh),
  });
  if (!saved.ok) return;
  scoped.tracer.event({
    runId,
    type: 'log',
    name: 'command_drift_applied',
    payload: { names: fresh.map((d) => d.name) },
  });
  hooks.notifySettings();
}

function argvEqual(current: string[] | undefined, from: string[]): boolean {
  return !!current && current.length === from.length && current.every((v, i) => v === from[i]);
}
