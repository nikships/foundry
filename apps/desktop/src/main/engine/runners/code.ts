/**
 * A code phase runs one known command. A failure gets, in order: a healing
 * agent that may make the smallest fix in the worktree, then a route back to
 * an earlier agent phase as an envelope, then the run. Each of those is
 * bounded, and only the command's own exit code decides whether a fix worked.
 */

import type { CommandResult, PhaseDef } from '@shared/types.js';
import { healingEligible } from '@shared/types.js';
import type { PhaseRunner, RunContext, PhaseJump } from '../phase-context.js';
import { BUILTIN_ARGV, runCommand } from '../commands.js';
import { resolveRefCommand, sniffCommands } from '../detect.js';
import { feedbackEnvelope } from '../envelopes.js';
import { heal, type HealAttempt } from '../healing.js';
import { resolveEnvelopeRef } from '../prompts.js';

type CommandResolution =
  | { ok: true; argv: string[]; skip?: false }
  | { ok: true; skip: true; argv: string[]; detail: string }
  | { ok: false; detail: string };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function gitCommitArgv(message: string): string[] {
  const subject = message.split('\n')[0]?.trim() || 'foundry: run changes';
  return [
    'sh',
    '-c',
    `git add -A && git diff --cached --quiet || git commit -m ${shellQuote(subject)}`,
  ];
}

export class CodePhaseRunner implements PhaseRunner {
  readonly kind = 'code' as const;

  private readonly feedbackUsed = new Map<string, number>();
  /** How many times each phase has healed, so re-entry cannot clobber a log. */
  private readonly healVisits = new Map<string, number>();
  /** Healing turns each phase has already spent, budgeted across the run. */
  private readonly healSpent = new Map<string, number>();

  async run(phase: PhaseDef, ctx: RunContext): Promise<PhaseJump> {
    const { tracer, runId } = ctx;
    const phaseId = ctx.phaseId(phase.name);
    tracer.beginQueuedPhase(phaseId);

    const resolved = await this.resolveCommand(phase, ctx);
    if (!resolved.ok) {
      tracer.closePhase(phaseId, 'fail', resolved.detail);
      return { kind: 'abort', detail: resolved.detail };
    }
    if (resolved.skip) {
      tracer.event({
        runId,
        phaseId,
        type: 'log',
        name: phase.name,
        payload: { skipped: resolved.detail },
      });
      tracer.closePhase(phaseId, 'skipped', resolved.detail);
      return { kind: 'next' };
    }

    let result = await this.execute(phase, ctx, resolved.argv);
    this.record(phase, ctx, result);

    if (result.passed) {
      tracer.closePhase(phaseId, 'success');
      return { kind: 'next' };
    }

    if (phase.optional) {
      tracer.closePhase(phaseId, 'skipped', `exit ${result.exitCode}, phase is optional`);
      return { kind: 'next' };
    }

    // A healer runs before the failure escalates: the command is frozen, so a
    // small repair in the worktree is cheaper than re-entering a whole phase.
    const healed = await this.tryHeal(phase, ctx, resolved, result);
    if (healed) {
      result = healed;
      this.record(phase, ctx, result);
      if (result.passed) {
        tracer.closePhase(phaseId, 'success');
        return { kind: 'next' };
      }
    }

    if (ctx.cancelled()) {
      tracer.closePhase(phaseId, 'fail', 'the run was cancelled');
      return { kind: 'abort', detail: 'the run was cancelled' };
    }

    // Build-test repair loop: wrap the failure as an envelope and hand it back
    // to the phase that owns the fix.
    if (phase.feedbackTo) {
      const budget = phase.feedbackRetries ?? 1;
      const used = this.feedbackUsed.get(phase.name) ?? 0;
      if (used < budget) {
        this.feedbackUsed.set(phase.name, used + 1);
        const fb = feedbackEnvelope({
          phase: phase.name,
          command: result.command,
          exitCode: result.exitCode,
          outputTail: result.outputTail,
        });
        ctx.feedback.set(phase.feedbackTo, `${fb.summary}\n\n${fb.notes_for_next_agent}`);
        tracer.event({
          runId,
          phaseId,
          type: 'correction',
          name: `feedback to ${phase.feedbackTo}`,
          payload: { attempt: used + 1, budget, exitCode: result.exitCode },
        });
        tracer.closePhase(
          phaseId,
          'fail',
          `exit ${result.exitCode}: sent back to ${phase.feedbackTo}`,
        );
        return { kind: 'goto', phase: phase.feedbackTo };
      }
      tracer.closePhase(
        phaseId,
        'fail',
        `exit ${result.exitCode} after ${budget} repair attempt(s)`,
      );
      return {
        kind: 'abort',
        detail: `${phase.name} still fails after ${budget} repair attempt(s)`,
      };
    }

    tracer.closePhase(phaseId, 'fail', `exit ${result.exitCode}`);
    return { kind: 'abort', detail: `${phase.name} exited ${result.exitCode}` };
  }

  /** One run of the phase's frozen argv, traced as its own tool call. */
  private async execute(phase: PhaseDef, ctx: RunContext, argv: string[]): Promise<CommandResult> {
    const { tracer, runId } = ctx;
    const phaseId = ctx.phaseId(phase.name);
    const eventId = tracer.event({
      runId,
      phaseId,
      type: 'tool_call',
      name: `${phase.name}: ${argv.join(' ')}`,
      payload: { argv, cwd: ctx.cwd },
    });
    const result = await runCommand({
      argv,
      cwd: ctx.cwd,
      name: phase.name,
      runId,
      onPid: (pid, command) =>
        tracer.recordProcess({ runId, kind: 'code', name: phase.name, pid, command }),
    });
    tracer.endEvent(eventId, {
      exitCode: result.exitCode,
      passed: result.passed,
      result: result.outputTail.slice(-2000),
    });
    return result;
  }

  /** The latest verdict is the one acceptance and the log file report. */
  private record(phase: PhaseDef, ctx: RunContext, result: CommandResult): void {
    ctx.commandResults.set(phase.name, result);
    ctx.tracer.writeRunFile(ctx.runId, `commands/${phase.name}.log`, result.outputTail);
  }

  /**
   * The bounded healing loop, or `null` when this failure gets no healer:
   * healing is off for the run, the phase is not one healing applies to, or
   * the phase has already spent its healing budget on an earlier visit. A
   * missing command, a scaffold skip, and an optional failure never reach
   * here — they are answered before the command ever ran, or above.
   *
   * The budget is per phase per run, not per visit. A `feedbackTo` route can
   * come back to the same phase several times, and a per-visit budget would
   * quietly multiply healing turns by the feedback retries — the phase would
   * be entitled to more model time the more the run struggled, which is
   * exactly backwards.
   */
  private async tryHeal(
    phase: PhaseDef,
    ctx: RunContext,
    resolved: { argv: string[] },
    failure: CommandResult,
  ): Promise<CommandResult | null> {
    const support = ctx.healing;
    if (!support || support.attempts < 1) return null;
    if (!healingEligible(phase)) return null;
    if (ctx.cancelled()) return null;

    const spent = this.healSpent.get(phase.name) ?? 0;
    const budget = support.attempts - spent;
    if (budget < 1) return null;

    const { tracer, runId } = ctx;
    const phaseId = ctx.phaseId(phase.name);
    this.healVisits.set(phase.name, (this.healVisits.get(phase.name) ?? 0) + 1);
    const agent = support.open(ctx.cwd);
    // A healing turn blocks the phase on a model for as long as its timeout
    // allows, and it can write. Cancelling has to reach it directly, or Stop
    // would leave an agent editing the worktree of a run the operator ended.
    const release = ctx.onCancel(() => agent.abort());
    tracer.event({
      runId,
      phaseId,
      type: 'log',
      name: `healing ${phase.name}`,
      payload: {
        model: support.model,
        reasoningEffort: support.reasoningEffort,
        attempts: budget,
        command: failure.command,
        exitCode: failure.exitCode,
      },
    });

    let outcome;
    try {
      outcome = await heal({
        phase: phase.name,
        request: ctx.request,
        cwd: ctx.cwd,
        failure,
        attempts: budget,
        protectedPaths: ctx.project.protectedPaths,
        agent,
        rerun: () => this.execute(phase, ctx, resolved.argv),
        cancelled: () => ctx.cancelled(),
        onAttempt: (attempt) => this.traceAttempt(phase, ctx, support.model, attempt),
      });
    } finally {
      release();
      this.healSpent.set(phase.name, spent + (outcome?.attempts.length ?? 0));
    }

    tracer.event({
      runId,
      phaseId,
      type: 'log',
      name: `healing ${phase.name} ${outcome.healed ? 'succeeded' : 'gave up'}`,
      payload: {
        model: support.model,
        attempts: outcome.attempts.length,
        budget,
        detail: outcome.detail,
        // Named here rather than inferred by a reader: this is the reason the
        // failure escalates (or does not) once healing is out of attempts.
        escalation: outcome.healed
          ? 'none'
          : (phase.feedbackTo ?? 'no feedback owner: the run fails'),
      },
    });
    return outcome.result;
  }

  private traceAttempt(
    phase: PhaseDef,
    ctx: RunContext,
    model: string,
    attempt: HealAttempt,
  ): void {
    const { tracer, runId } = ctx;
    const phaseId = ctx.phaseId(phase.name);
    // The attempt number restarts at 1 every time the phase is entered, and a
    // `feedbackTo` route can enter it again — so the visit has to be in the
    // name or the second visit's first attempt would overwrite the first
    // visit's evidence.
    const visit = this.healVisits.get(phase.name) ?? 1;
    const suffix = visit > 1 ? `${visit}-${attempt.attempt}` : `${attempt.attempt}`;
    tracer.writeRunFile(
      runId,
      `commands/${phase.name}.heal-${suffix}.log`,
      attempt.result.outputTail,
    );
    tracer.event({
      runId,
      phaseId,
      type: 'correction',
      name: `healing attempt ${attempt.attempt} on ${phase.name}`,
      payload: {
        model,
        exitCode: attempt.result.exitCode,
        passed: attempt.result.passed,
        summary: attempt.reply.trim().slice(-1000),
        ...(attempt.violations.length
          ? { violations: attempt.violations.map((v) => `${v.path} (${v.change})`) }
          : {}),
      },
    });
  }

  private async resolveCommand(phase: PhaseDef, ctx: RunContext): Promise<CommandResolution> {
    const spec = phase.command;
    if (!spec) return { ok: false, detail: `code phase "${phase.name}" has no command` };
    if ('argv' in spec) return { ok: true, argv: spec.argv };

    if ('ref' in spec) {
      return this.resolveRef(spec.ref, phase.name, ctx);
    }

    const builder = BUILTIN_ARGV[spec.builtin];
    if (!builder) return { ok: false, detail: `unknown builtin "${spec.builtin}"` };

    if (spec.builtin === 'git_commit') {
      const message = spec.messageFrom
        ? (resolveEnvelopeRef(spec.messageFrom, ctx.envelopes) ?? '')
        : '';
      return { ok: true, argv: gitCommitArgv(message) };
    }
    return { ok: true, argv: builder({}) };
  }

  private async resolveRef(
    name: string,
    phaseName: string,
    ctx: RunContext,
  ): Promise<CommandResolution> {
    const sniffed = await sniffCommands(ctx.cwd);
    const resolved = resolveRefCommand(name, ctx.project.commands, sniffed);
    if (!resolved.ok) {
      if (ctx.project.scaffold) {
        return {
          ok: true,
          skip: true,
          argv: [],
          detail: `no "${name}" command in this project yet — nothing to run`,
        };
      }
      return {
        ok: false,
        detail: `project command "${name}" is not configured — set it in Settings → Project`,
      };
    }
    if (resolved.drifted) {
      ctx.commandDrift.set(name, resolved.drift);
      ctx.tracer.writeRunFile(
        ctx.runId,
        'command-drift.json',
        `${JSON.stringify([...ctx.commandDrift.values()], null, 2)}\n`,
      );
      ctx.tracer.event({
        runId: ctx.runId,
        phaseId: ctx.phaseId(phaseName),
        type: 'log',
        name: 'command_drift',
        payload: {
          name,
          from: resolved.drift.from,
          to: resolved.drift.to,
          source: resolved.drift.source,
        },
      });
    }
    return { ok: true, argv: resolved.argv };
  }
}
