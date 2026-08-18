/**
 * Agent-assisted repair for the one git state code cannot resolve on its own:
 * a run branch that no longer applies cleanly to its base. The division of
 * labour is the engine's usual one — the agent proposes (it rebases and
 * resolves conflicts inside the worktree), code disposes (it verifies the
 * result with git and only then merges or pushes). A repair that does not
 * verify is aborted, so the worktree is never left mid-rebase.
 *
 * Same pattern as command detection in Settings: one bounded one-shot turn,
 * no new session machinery.
 */

import type { AppSettings } from '@shared/types.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import { abortRebase, isAncestor, resolveRef, status } from './git.js';

/** The one method a repair needs; a one-shot session satisfies it structurally. */
export interface RepairAgent {
  send(text: string, timeoutMs: number): Promise<{ text: string }>;
}

export interface RepairOutcome {
  ok: boolean;
  detail: string;
}

/**
 * The repair agent, write-capable inside the run's own worktree.
 *
 * A rebase is commands and writes, so this is the one one-shot that needs
 * them — the policy keeps them inside `cwd`, and the run worktree is already
 * the only place this run's work lives. Nothing the agent claims is believed:
 * `rebaseOntoBase` re-derives the outcome from git afterwards.
 */
export function repairAgent(
  oneShot: OneShotFactory,
  settings: AppSettings,
  cwd: string,
): RepairAgent {
  const model = settings.defaultModel || 'inherit';
  return oneShot({
    cwd,
    access: 'write',
    model,
    reasoningEffort: model === 'inherit' ? 'off' : settings.defaultReasoningEffort,
    systemPrompt: REBASE_SYSTEM,
  });
}

/** Standing rebase rules. The user turn names the branch and the target. */
export const REBASE_SYSTEM = [
  'You are repairing a git worktree whose branch no longer applies cleanly to its base.',
  'Resolve conflicts so both sides survive: keep the intent of the branch commits and the changes that landed on the base.',
  'When a conflict is genuinely one-or-the-other, prefer the base and adapt the branch work on top of it.',
  '',
  'Rules:',
  '- Work only inside this directory.',
  '- Complete the rebase (`git rebase --continue` until done). Never leave it in progress.',
  '- Do not push, do not merge, do not touch any other branch.',
  '- Finish with a clean `git status` (no unstaged, staged, or untracked leftovers).',
].join('\n');

export function rebasePrompt(input: {
  branch: string;
  ontoLabel: string;
  ontoSha: string;
}): string {
  return [
    `The worktree is on \`${input.branch}\`. Rebase it onto ${input.ontoLabel} (commit ${input.ontoSha}).`,
    '',
    'Finish by summarising what conflicted and how you resolved it, in one short paragraph.',
  ].join('\n');
}

/**
 * One agent turn, then the checks that decide whether it counts:
 * the worktree is clean, the new base is an ancestor of HEAD, and the
 * branch still carries work of its own. Anything else is aborted back to
 * where it started.
 */
export async function rebaseOntoBase(input: {
  worktreePath: string;
  branch: string;
  ontoSha: string;
  ontoLabel: string;
  agent: RepairAgent;
  timeoutMs: number;
}): Promise<RepairOutcome> {
  const { worktreePath, branch, ontoSha, ontoLabel } = input;
  const before = await resolveRef(worktreePath, 'HEAD');

  let reply = '';
  try {
    reply = (await input.agent.send(rebasePrompt({ branch, ontoLabel, ontoSha }), input.timeoutMs))
      .text;
  } catch (e) {
    await abortRebase(worktreePath);
    return { ok: false, detail: `the repair agent failed: ${(e as Error).message}` };
  }

  const failed = async (detail: string): Promise<RepairOutcome> => {
    await abortRebase(worktreePath);
    // The agent may have committed partial work before stopping; a hard reset
    // would delete resolutions worth reading, so only the rebase is unwound.
    return { ok: false, detail };
  };

  const leftovers = await status(worktreePath);
  if (leftovers.length > 0) {
    return failed(
      `the agent did not leave a clean worktree (${leftovers.length} paths still dirty) — rebase aborted`,
    );
  }

  const after = await resolveRef(worktreePath, 'HEAD');
  if (!(await isAncestor(worktreePath, ontoSha, after))) {
    return failed(
      `the branch does not sit on ${ontoLabel} after the agent's turn — rebase aborted`,
    );
  }
  if (after === ontoSha) {
    return failed(
      `the rebase left no commits of its own on ${ontoLabel} — the run's work would be lost, so nothing was kept`,
    );
  }

  const summary = reply.trim().split('\n').filter(Boolean).pop() ?? '';
  return {
    ok: true,
    detail:
      `rebased ${branch} onto ${ontoLabel} (${before.slice(0, 8)} → ${after.slice(0, 8)})` +
      (summary ? ` — ${summary.slice(0, 200)}` : ''),
  };
}
