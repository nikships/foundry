/**
 * A code phase runs one known command. A failure gets, in order: no-edit
 * flake reruns for `{ref}` proof phases, a healing agent that may make the
 * smallest fix in the worktree, then a route back to an earlier agent phase
 * as an envelope, then the run. Each of those is bounded, and only the
 * command's own exit code decides whether a fix worked.
 */

import {
  flakeRerunCount,
  healingEligible,
  type CommandResult,
  type HealClass,
  type PhaseDef,
} from '@shared/types.js';
import type { PhaseRunner, RunContext, PhaseJump } from '../phase-context.js';
import { snapshot } from '../boundary.js';
import { BUILTIN_ARGV, runCommand } from '../commands.js';
import { resolveRefCommand, sniffCommands } from '../detect.js';
import { feedbackEnvelope } from '../envelopes.js';
import { changedPaths } from '../git.js';
import {
  heal,
  healingSystemRole,
  type HealAttempt,
  type HealingPromptContext,
} from '../healing.js';
import { formatPromptRecord, resolveEnvelopeRef } from '../prompts.js';

type CommandResolution =
  | { ok: true; argv: string[]; skip?: false }
  | { ok: true; skip: true; argv: string[]; detail: string }
  | { ok: false; detail: string };

function healingPromptContext(ctx: RunContext): HealingPromptContext {
  return {
    repositoryContext: ctx.project.contextSummary,
    envelopeSummaries: [...ctx.envelopes].map(([name, envelope]) => ({
      phase: name,
      summary: typeof envelope.summary === 'string' ? envelope.summary : '',
    })),
    commands: ctx.project.commands,
  };
}

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

    // A flaky `{ref}` proof is cheaper than a healer: re-run without edits
    // first, and only write if the command stays red.
    const flaked = await this.tryFlakeRerun(phase, ctx, resolved.argv);
    if (flaked?.passed) {
      this.traceHealClass(phase, ctx, 'flake', { reruns: flaked.reruns });
      tracer.closePhase(phaseId, 'success');
      return { kind: 'next' };
    }
    if (flaked) result = flaked.result;

    // A healer runs before the failure escalates: the command is frozen, so a
    // small repair in the worktree is cheaper than re-entering a whole phase.
    const healed = await this.tryHeal(phase, ctx, resolved, result);
    if (healed) {
      result = healed;
      this.record(phase, ctx, result);
      this.traceHealClass(phase, ctx, result.passed ? 'healed' : 'failed', {
        attempts: this.healSpent.get(phase.name) ?? 0,
      });
      if (result.passed) {
        tracer.closePhase(phaseId, 'success');
        return { kind: 'next' };
      }
    } else if (flakeRerunCount(phase) > 0) {
      this.traceHealClass(phase, ctx, 'failed', { reruns: flakeRerunCount(phase) });
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
   * Re-run a failed `{ref}` command without writing, so a flake is not
   * rewritten. Returns the first passing rerun, or the last failure when
   * every rerun stayed red. `null` means flake rerun is off for this phase.
   */
  private async tryFlakeRerun(
    phase: PhaseDef,
    ctx: RunContext,
    argv: string[],
  ): Promise<{ passed: true; reruns: number } | { passed: false; result: CommandResult } | null> {
    const budget = flakeRerunCount(phase);
    if (budget < 1) return null;
    if (ctx.cancelled()) return null;

    const { tracer, runId } = ctx;
    const phaseId = ctx.phaseId(phase.name);
    const before = await snapshot(ctx.cwd);
    tracer.event({
      runId,
      phaseId,
      type: 'log',
      name: `flake rerun ${phase.name}`,
      payload: { attempts: budget, command: argv.join(' ') },
    });

    let last: CommandResult | null = null;
    for (let attempt = 1; attempt <= budget; attempt += 1) {
      if (ctx.cancelled()) return last ? { passed: false, result: last } : null;
      last = await this.execute(phase, ctx, argv);
      this.record(phase, ctx, last);
      if (!last.passed) continue;
      const after = await changedPaths(ctx.cwd);
      const wrote = after.filter((path) => !before.paths.has(path));
      tracer.event({
        runId,
        phaseId,
        type: 'log',
        name: `flake rerun ${phase.name} passed`,
        payload: { attempt, budget, wrote },
      });
      return { passed: true, reruns: attempt };
    }
    return last ? { passed: false, result: last } : null;
  }

  private traceHealClass(
    phase: PhaseDef,
    ctx: RunContext,
    healClass: HealClass,
    extra: Record<string, unknown>,
  ): void {
    ctx.tracer.event({
      runId: ctx.runId,
      phaseId: ctx.phaseId(phase.name),
      type: 'log',
      name: 'heal_class',
      payload: { class: healClass, detail: healClass, ...extra },
    });
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
    const promptContext = healingPromptContext(ctx);
    const systemPrompt = healingSystemRole(promptContext);
    const agent = support.open(ctx.cwd, promptContext);
    // A healing turn blocks the phase on a model until it finishes or the
    // operator cancels, and it can write. Cancellation has to reach it directly, or Stop
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
        systemPrompt,
        onPrompt: ({ system, user, attempt }) => {
          const visit = this.healVisits.get(phase.name) ?? 1;
          const suffix = visit > 1 ? `${visit}-${attempt}` : `${attempt}`;
          tracer.writeRunFile(
            runId,
            `healer/prompts/${phase.name}-${suffix}.md`,
            formatPromptRecord({ system, user }),
          );
        },
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
