/**
 * A code phase runs one known command and optionally routes the failure back
 * to an earlier agent phase as an envelope, so the builder sees the log tail
 * without opening a file.
 */

import type { PhaseDef } from '@shared/types.js';
import type { PhaseRunner, RunContext, PhaseJump } from '../phase-context.js';
import { BUILTIN_ARGV, runCommand } from '../commands.js';
import { resolveRefCommand, sniffCommands } from '../detect.js';
import { feedbackEnvelope } from '../envelopes.js';
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

    const eventId = tracer.event({
      runId,
      phaseId,
      type: 'tool_call',
      name: `${phase.name}: ${resolved.argv.join(' ')}`,
      payload: { argv: resolved.argv, cwd: ctx.cwd },
    });
    const result = await runCommand({
      argv: resolved.argv,
      cwd: ctx.cwd,
      timeoutMs: phase.timeoutMs ?? 900_000,
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
    ctx.commandResults.set(phase.name, result);
    tracer.writeRunFile(runId, `commands/${phase.name}.log`, result.outputTail);

    if (result.passed) {
      tracer.closePhase(phaseId, 'success');
      return { kind: 'next' };
    }

    if (phase.optional) {
      tracer.closePhase(phaseId, 'skipped', `exit ${result.exitCode}, phase is optional`);
      return { kind: 'next' };
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
