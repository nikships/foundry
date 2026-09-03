/**
 * Healing: one write-capable agent turn against a programmatic phase that
 * failed, then the same command again.
 *
 * The engine's usual division of labour, applied to a red check. A code phase
 * runs a frozen command, so a failure has no agent in it to correct — the only
 * options used to be handing the log tail back to a whole earlier phase or
 * failing the run. A healer sits between them: the smallest fix, made in the
 * run's own worktree, judged by re-running the exact same argv. Only exit 0
 * counts, and the agent never chooses what to run.
 *
 * Bounded by construction. Attempts come from `FIXED_ENGINE_DEFAULTS`, and on
 * exhaustion the failure escalates through the existing `feedbackTo` path (or
 * fails the run) rather than looping. Writes are enforced the way an agent
 * phase's are: post-turn `git diff` against the boundary, so a protected path
 * is reverted and reported even though the turn itself was allowed to write.
 */

import type {
  AppSettings,
  BoundaryViolation,
  CommandResult,
  ProjectCommand,
  ReasoningEffort,
} from '@shared/types.js';
import { FIXED_ENGINE_DEFAULTS } from '@shared/types.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import {
  envelopeSummaryBlock,
  projectCommandBlock,
  repositoryContextBlock,
} from './agent-context.js';
import { enforce, restoreToPhaseStart, snapshot, type Snapshot } from './boundary.js';

/** The one method a healing turn needs; a one-shot session satisfies it. */
export interface HealingAgent {
  send(text: string): Promise<{ text: string }>;
  /** Ends the turn in flight, which is what a run-level cancel does. */
  abort(): void;
}

/** Facts appended beside HEALING_SYSTEM for a write-capable healer one-shot. */
export interface HealingPromptContext {
  repositoryContext?: string;
  envelopeSummaries?: { phase: string; summary: string }[];
  commands?: readonly ProjectCommand[];
}

/**
 * What the executor hands a code phase so it can heal. Absent means healing is
 * off for this run — a build with no model configured behaves exactly as it did
 * before healing existed.
 */
export interface HealingSupport {
  /** How many healing turns one failing command gets. */
  attempts: number;
  /** The model healing runs on, recorded for attribution. */
  model: string;
  reasoningEffort: ReasoningEffort;
  open(cwd: string, context?: HealingPromptContext): HealingAgent;
}

/** One healing turn and the verdict the re-run gave it. */
export interface HealAttempt {
  attempt: number;
  /** The healer's own account of what it changed. Never believed, only logged. */
  reply: string;
  /** The exact command, run again. */
  result: CommandResult;
  /** Writes outside the boundary, reverted before the re-run. */
  violations: BoundaryViolation[];
}

export interface HealOutcome {
  healed: boolean;
  attempts: HealAttempt[];
  /** The last command result, healed or not. Callers record this one. */
  result: CommandResult;
  /** Why healing stopped, in operator-facing words. */
  detail: string;
}

/**
 * The healer, write-capable inside the run's own worktree.
 *
 * Same shape as the rebase repair agent and for the same reason: a fix is
 * edits and commands, the policy keeps them inside `cwd`, and the run worktree
 * is the only place this run's work lives. `heal` re-derives the verdict from
 * the command's exit code afterwards, so nothing the agent claims is believed.
 */
export function healingAgent(
  oneShot: OneShotFactory,
  choice: { model: string; reasoningEffort: ReasoningEffort },
  cwd: string,
  context?: HealingPromptContext,
): HealingAgent {
  const systemPrompt = healingSystemRole(context);
  const session = oneShot({
    cwd,
    access: 'write',
    model: choice.model,
    reasoningEffort: choice.reasoningEffort,
    systemPrompt,
  });
  return {
    send: (text) => session.send(text),
    abort: () => session.abort(),
  };
}

/**
 * The model a healing turn runs on. `inherit` on the healing setting follows
 * the install default, exactly as the helper and Smith models do; a healing
 * effort is only meaningful once a concrete model is named, so an inherited
 * choice takes the default effort with it.
 */
export function resolveHealingModel(settings: AppSettings): {
  model: string;
  reasoningEffort: ReasoningEffort;
} {
  const chosen = settings.healingModel || 'inherit';
  if (chosen !== 'inherit') {
    return { model: chosen, reasoningEffort: settings.healingReasoningEffort };
  }
  const fallback = settings.defaultModel || 'inherit';
  return {
    model: fallback,
    reasoningEffort:
      fallback === 'inherit' ? settings.healingReasoningEffort : settings.defaultReasoningEffort,
  };
}

/**
 * What the executor is handed so a code phase can heal. Built here rather than
 * in the registry so the model resolution and the attempt budget have one home.
 */
export function healingSupport(
  oneShot: OneShotFactory,
  settings: AppSettings,
  attempts: number = FIXED_ENGINE_DEFAULTS.healingAttempts,
): HealingSupport {
  const choice = resolveHealingModel(settings);
  return {
    attempts,
    model: choice.model,
    reasoningEffort: choice.reasoningEffort,
    open: (cwd, context) => healingAgent(oneShot, choice, cwd, context),
  };
}

/** Standing healing rules plus the same repository card run agents receive. */
export function healingSystemRole(context?: HealingPromptContext): string {
  const sections = [HEALING_SYSTEM];
  const card = repositoryContextBlock(context?.repositoryContext);
  if (card) sections.push(card);
  const envelopes = envelopeSummaryBlock(context?.envelopeSummaries);
  if (envelopes) sections.push(envelopes);
  const commands = projectCommandBlock(context?.commands);
  if (commands) sections.push(commands);
  return sections.join('\n\n');
}

/** Standing healing rules. The user turn names the command and the failure. */
export const HEALING_SYSTEM = [
  'You are repairing a repository whose own verification command just failed.',
  'Make the smallest change that makes that exact command pass. Nothing else.',
  '',
  'Rules:',
  '- Work only inside this directory.',
  '- Fix the cause the output points at. Do not refactor, reformat, or tidy anything else.',
  '- Never weaken the check to pass it: do not delete, skip, or loosen a test,',
  '  a lint rule, or an assertion, and do not edit the command itself.',
  '- On the last attempt, if you cannot make the frozen command pass without weakening it,',
  '  revert every edit you made in this phase (do not revert earlier phases) and stop.',
  '  The engine reverts in-phase edits if this attempt still fails.',
  '- Do not commit, push, merge, or touch any branch.',
  '- You are not asked to run the command; it is re-run for you after your turn.',
].join('\n');

export function healPrompt(input: {
  phase: string;
  request: string;
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTail: string;
  protectedPaths: string[];
  attempt: number;
  attempts: number;
}): string {
  const exit = input.timedOut
    ? 'timed out'
    : `exited ${input.exitCode === null ? 'abnormally' : input.exitCode}`;
  const lines = [
    `The \`${input.phase}\` phase ran this command and it ${exit}:`,
    '',
    `    ${input.command}`,
    '',
    `This is attempt ${input.attempt} of ${input.attempts}. The same command runs again after your turn, unchanged.`,
  ];
  if (input.attempt === input.attempts) {
    lines.push(
      '',
      'This is the last attempt. If you cannot make the frozen command pass without weakening it, revert every in-phase edit (do not revert earlier phases) and leave the tree as it was when this phase started. The status will be fail.',
    );
  }
  lines.push(
    '',
    `What the run was asked to do, for context only — do not implement it here:`,
    input.request.trim() || '(no request recorded)',
    '',
    'Output tail:',
    '```',
    input.outputTail.trim() || '(no output)',
    '```',
  );
  if (input.protectedPaths.length) {
    lines.push(
      '',
      `These paths are protected and any change to them is reverted: ${input.protectedPaths.join(', ')}.`,
    );
  }
  lines.push('', 'Make the fix, then summarise what you changed and why in one short paragraph.');
  return lines.join('\n');
}

interface HealInput {
  phase: string;
  request: string;
  cwd: string;
  failure: CommandResult;
  attempts: number;
  protectedPaths: string[];
  agent: HealingAgent;
  /** Runs the exact same argv again. Only exit 0 counts as healed. */
  rerun: () => Promise<CommandResult>;
  cancelled: () => boolean;
  /** Reported per pass, so the caller can trace an attempt as it lands. */
  onAttempt?: (attempt: HealAttempt) => void;
  /**
   * Standing system role written beside the user turn in the prompt record.
   * Optional so unit tests that drive `heal` with a stub agent can omit it.
   */
  systemPrompt?: string;
  /** The prompt this attempt actually sent, recorded before the turn. */
  onPrompt?: (record: { system: string; user: string; attempt: number }) => void;
}

/**
 * One bounded heal-then-verify loop.
 *
 * Each pass is a turn, a boundary check, and the same command again. The
 * command is `rerun`'s business rather than this function's, so the caller
 * keeps its own tracing and this stays testable without a tracer. A cancelled
 * run stops at the next boundary: the turn in flight is aborted and no further
 * attempt starts.
 */
export async function heal(input: HealInput): Promise<HealOutcome> {
  // Every exit aborts the session, including the ones this function does not
  // model: a boundary check, a trace write, or the re-run itself can throw, and
  // an agent left un-aborted on the way out would outlive the phase.
  try {
    return await healLoop(input);
  } finally {
    input.agent.abort();
  }
}

async function checkHealBoundary(
  cwd: string,
  before: Snapshot,
  protectedPaths: string[],
): Promise<BoundaryViolation[]> {
  return (
    await enforce({
      cwd,
      before,
      writes: null,
      projectProtected: protectedPaths,
    })
  ).violations;
}

async function healLoop(input: HealInput): Promise<HealOutcome> {
  const attempts: HealAttempt[] = [];
  let last = input.failure;
  // Taken before any healer write so exhaustion can put this phase back without
  // touching earlier phases' work.
  const origin = await snapshot(input.cwd);

  const recordAttempt = (record: HealAttempt): void => {
    attempts.push(record);
    input.onAttempt?.(record);
  };

  const revertInPhase = async (detail: string): Promise<HealOutcome> => {
    await restoreToPhaseStart(input.cwd, origin);
    return {
      healed: false,
      attempts,
      result: last,
      detail: `${detail}; in-phase edits reverted`,
    };
  };

  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    if (input.cancelled()) {
      return { healed: false, attempts, result: last, detail: 'cancelled' };
    }

    const before = await snapshot(input.cwd);
    let reply = '';
    try {
      const user = healPrompt({
        phase: input.phase,
        request: input.request,
        command: last.command,
        exitCode: last.exitCode,
        timedOut: last.timedOut,
        outputTail: last.outputTail,
        protectedPaths: input.protectedPaths,
        attempt,
        attempts: input.attempts,
      });
      input.onPrompt?.({ system: input.systemPrompt ?? HEALING_SYSTEM, user, attempt });
      reply = (await input.agent.send(user)).text;
    } catch (e) {
      // A turn that never answered still may have written; the boundary is
      // enforced either way so a protected path cannot survive on a failure.
      recordAttempt({
        attempt,
        reply: '',
        result: last,
        violations: await checkHealBoundary(input.cwd, before, input.protectedPaths),
      });
      return revertInPhase(`the healing agent failed: ${(e as Error).message}`);
    }

    const violations = await checkHealBoundary(input.cwd, before, input.protectedPaths);

    if (input.cancelled()) {
      recordAttempt({ attempt, reply, result: last, violations });
      return { healed: false, attempts, result: last, detail: 'cancelled' };
    }

    last = await input.rerun();
    recordAttempt({ attempt, reply, result: last, violations });

    if (last.passed) {
      return {
        healed: true,
        attempts,
        result: last,
        detail: `healed on attempt ${attempt} of ${input.attempts}`,
      };
    }
  }

  return revertInPhase(`still failing after ${input.attempts} healing attempt(s)`);
}
