/**
 * One agent phase: envelope retries, gate retries, boundary enforcement, and
 * the handoff file. Every correction re-prompts the same live session.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDef, EnvelopeDef, PhaseDef } from '@shared/types.js';
import type { PhaseRunner, RunContext, PhaseJump } from '../phase-context.js';
import type { Mode } from '../../droid/agent.js';
import type { AgentSession } from '../../droid/agent.js';
import * as boundary from '../boundary.js';
import { correctionMessage, parseEnvelope, type Envelope } from '../envelopes.js';
import { gateCorrection, runGates, violationsOf, type GateReport } from '../gates.js';
import { changedPaths } from '../git.js';
import { combineForTurn, renderPrompt, type RenderContext } from '../prompts.js';

export interface AgentRunnerDeps {
  agents: AgentDef[];
  envelopeDefs: EnvelopeDef[];
  envelopeRetries: number;
  /** Session lookup stays with the executor: a session lives for the run, not the phase. */
  sessionFor: (agent: AgentDef) => AgentSession;
  onLiveText?: (phaseId: string, text: string) => void;
  /** Reports the transport mode when a session falls back mid-turn. */
  onModeObserved: (mode: Mode) => void;
}

export class AgentPhaseRunner implements PhaseRunner {
  readonly kind = 'agent' as const;

  constructor(private readonly deps: AgentRunnerDeps) {}

  async run(phase: PhaseDef, ctx: RunContext): Promise<PhaseJump> {
    const { tracer, runId } = ctx;
    const phaseId = ctx.phaseId(phase.name);
    tracer.beginQueuedPhase(phaseId);

    const agent = this.deps.agents.find((a) => a.name === phase.agent);
    if (!agent) {
      const detail = `no agent named "${phase.agent}" in the roster`;
      tracer.closePhase(phaseId, 'fail', detail);
      return { kind: 'abort', detail };
    }

    const session = this.deps.sessionFor(agent);
    const envelopeKind = phase.envelope ?? agent.envelope;
    const before = await boundary.snapshot(ctx.cwd);
    const maxGateAttempts = (phase.retries ?? 0) + 1;

    tracer.event({
      runId,
      phaseId,
      type: 'agent_start',
      name: agent.name,
      payload: {
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
        writes: boundary.describeBoundary(agent.writes),
        mode: session.currentMode,
      },
    });

    let prompt = combineForTurn(renderPrompt(agent, phase, this.renderContext(phase, ctx)));
    tracer.writeRunFile(runId, `${agent.name}/prompts/${phase.name}-1.md`, prompt);

    let envelope: Envelope | null = null;
    let lastError = 'the agent phase never produced a usable envelope';

    for (let gateAttempt = 1; gateAttempt <= maxGateAttempts; gateAttempt++) {
      tracer.setPhaseAttempt(phaseId, gateAttempt);

      const parsed = await this.turnUntilParsed(
        session,
        agent,
        phase,
        phaseId,
        prompt,
        envelopeKind,
        gateAttempt,
        ctx,
      );
      if (!parsed.ok) {
        lastError = parsed.detail;
        tracer.closePhase(phaseId, 'fail', lastError);
        return { kind: 'abort', detail: lastError };
      }
      envelope = parsed.envelope;

      const enforcement = await boundary.enforce({
        cwd: ctx.cwd,
        before,
        writes: agent.writes,
        projectProtected: ctx.project.protectedPaths,
      });
      if (enforcement.violations.length) {
        tracer.event({
          runId,
          phaseId,
          type: 'error',
          name: 'write boundary',
          payload: {
            violations: enforcement.violations,
            boundary: boundary.describeBoundary(agent.writes),
          },
        });
        if (gateAttempt < maxGateAttempts) {
          prompt = boundary.boundaryCorrection(enforcement.violations);
          tracer.event({
            runId,
            phaseId,
            type: 'correction',
            name: 'boundary violation',
            payload: {
              attempt: gateAttempt,
              violations: enforcement.violations.map((v) => v.path),
            },
          });
          continue;
        }
        lastError = `wrote outside its boundary: ${enforcement.violations.map((v) => v.path).join(', ')}`;
        tracer.closePhase(phaseId, 'fail', lastError);
        return { kind: 'abort', detail: lastError };
      }

      const reports = await this.runGatesFor(phase, envelope, phaseId, gateAttempt, ctx);
      const violations = violationsOf(reports);
      if (!violations.length) {
        ctx.envelopes.set(phase.name, envelope);
        if (envelope.status === 'fail') {
          lastError = `the agent reported failure: ${envelope.summary}`;
          tracer.closePhase(phaseId, 'fail', lastError);
          return { kind: 'abort', detail: lastError };
        }
        this.writeHandoff(ctx, phaseId, phase.name, envelope);
        tracer.closePhase(phaseId, 'success');
        return { kind: 'next' };
      }

      lastError = `gates rejected the phase: ${violations[0]}`;
      if (gateAttempt < maxGateAttempts) {
        prompt = gateCorrection(violations);
        tracer.event({
          runId,
          phaseId,
          type: 'correction',
          name: 'gate violations',
          payload: { attempt: gateAttempt, violations },
        });
      }
    }

    tracer.closePhase(phaseId, 'fail', lastError);
    return { kind: 'abort', detail: lastError };
  }

  /**
   * Envelope parsing owns its own retry budget, separate from gate retries: a
   * malformed reply is a different failure from work that did not pass, and
   * both corrections go into the same live session.
   */
  private async turnUntilParsed(
    session: AgentSession,
    agent: AgentDef,
    phase: PhaseDef,
    phaseId: string,
    firstPrompt: string,
    envelopeKind: PhaseDef['envelope'] & string,
    gateAttempt: number,
    ctx: RunContext,
  ): Promise<{ ok: true; envelope: Envelope } | { ok: false; detail: string }> {
    let prompt = firstPrompt;

    for (let attempt = 1; attempt <= this.deps.envelopeRetries + 1; attempt++) {
      if (ctx.cancelled()) return { ok: false, detail: 'the run was killed' };

      let outcome;
      try {
        outcome = await session.send(prompt, {
          phaseId,
          onText: (text) => this.deps.onLiveText?.(phaseId, text),
        });
      } catch (e) {
        ctx.tracer.event({
          runId: ctx.runId,
          phaseId,
          type: 'error',
          name: `${agent.name}: turn failed`,
          payload: { message: (e as Error).message, attempt },
        });
        return { ok: false, detail: `the agent turn failed: ${(e as Error).message}` };
      }

      this.deps.onModeObserved(session.currentMode);

      const usageEventId = ctx.tracer.recordUsage(ctx.runId, phaseId, agent.name, outcome.usage);
      ctx.tracer.appendRunFile(
        ctx.runId,
        `${agent.name}/raw.jsonl`,
        `${JSON.stringify({ phase: phase.name, gateAttempt, attempt, reason: outcome.reason, text: outcome.text })}\n`,
      );

      const parsed = parseEnvelope(
        outcome.text,
        envelopeKind,
        agent.customFields,
        this.deps.envelopeDefs,
      );
      ctx.tracer.recordEnvelope({
        runId: ctx.runId,
        phaseId,
        agent: agent.name,
        schemaKind: envelopeKind,
        payload: parsed.envelope ?? { raw: outcome.text.slice(0, 4000) },
        valid: parsed.ok,
        attempt,
      });
      ctx.tracer.writeRunFile(
        ctx.runId,
        `envelope-${phase.name}-${gateAttempt}-${attempt}.json`,
        JSON.stringify(parsed.envelope ?? { raw: outcome.text }, null, 2),
      );

      if (parsed.ok && parsed.envelope) {
        ctx.tracer.endEvent(usageEventId, {
          status: parsed.envelope.status,
          summary: parsed.envelope.summary,
        });
        return { ok: true, envelope: parsed.envelope };
      }

      const problem = parsed.problem ?? 'the envelope did not validate';
      ctx.tracer.event({
        runId: ctx.runId,
        phaseId,
        type: 'correction',
        name: 'envelope did not parse',
        payload: { attempt, problem },
      });
      prompt = correctionMessage(problem, envelopeKind, agent.customFields, this.deps.envelopeDefs);
    }

    return {
      ok: false,
      detail: `the agent did not produce a valid ${envelopeKind} envelope in ${this.deps.envelopeRetries + 1} attempts`,
    };
  }

  private async runGatesFor(
    phase: PhaseDef,
    envelope: Envelope,
    phaseId: string,
    attempt: number,
    ctx: RunContext,
  ): Promise<GateReport[]> {
    const specs = phase.gates ?? [];
    if (!specs.length) return [];

    const reports = await runGates(specs, envelope, {
      cwd: ctx.cwd,
      changedPaths: await changedPaths(ctx.cwd),
    });
    for (const report of reports) {
      ctx.tracer.recordGate({
        runId: ctx.runId,
        phaseId,
        attempt,
        gate: report.gate,
        passed: report.passed,
        checks: report.checks,
      });
    }
    return reports;
  }

  private renderContext(phase: PhaseDef, ctx: RunContext): RenderContext {
    return {
      request: ctx.request,
      runId: ctx.runId,
      worktree: ctx.cwd,
      handoffDir: ctx.handoffDir,
      handoffFiles: this.handoffFiles(ctx),
      envelopes: ctx.envelopes,
      feedback: ctx.feedback.get(phase.name),
      envelopeDefs: this.deps.envelopeDefs,
    };
  }

  private handoffFiles(ctx: RunContext): string[] {
    try {
      return readdirSync(join(ctx.cwd, ctx.handoffDir)).map((f) => join(ctx.handoffDir, f));
    } catch {
      return [];
    }
  }

  private writeHandoff(
    ctx: RunContext,
    phaseId: string,
    phaseName: string,
    envelope: Envelope,
  ): void {
    ctx.tracer.writeRunFile(
      ctx.runId,
      `handoff/${phaseName}.json`,
      JSON.stringify(envelope, null, 2),
    );
    ctx.tracer.event({
      runId: ctx.runId,
      phaseId,
      type: 'handoff',
      name: phaseName,
      payload: { artifacts: envelope.artifacts, summary: envelope.summary },
    });
  }
}
