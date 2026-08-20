/**
 * One agent phase: envelope retries, gate retries, boundary enforcement, and
 * the handoff file. Every correction re-prompts the same live session.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDef, EnvelopeDef, PhaseDef } from '@shared/types.js';
import type { PhaseRunner, RunContext, PhaseJump } from '../phase-context.js';
import { KILLED_DETAIL, type AgentSession } from '../../pi/session.js';
import * as boundary from '../boundary.js';
import { PhaseRewinder, type RewindTrace } from '../rewinder.js';
import {
  correctionMessage,
  jsonSchemaFor,
  parseEnvelope,
  validateEnvelope,
  type Envelope,
  type ParseOutcome,
} from '../envelopes.js';
import { gateCorrection, runGates, violationsOf, type GateReport } from '../gates.js';
import { formatPromptRecord, renderPrompt, type RenderContext } from '../prompts.js';
import { agentSystemRole, type SetupExecution } from '../agent-context.js';

export interface AgentRunnerDeps {
  agents: AgentDef[];
  envelopeDefs: EnvelopeDef[];
  envelopeRetries: number;
  /**
   * After this many failed corrections in a phase, rewind the SDK session
   * instead of appending another correction. `0` disables.
   */
  rewindAfterCorrections: number;
  /** Session lookup stays with the executor, which also applies phase model overrides. */
  sessionFor: (agent: AgentDef, modelOverride?: string) => Promise<AgentSession>;
  setupExecution: () => SetupExecution | null;
  onLiveText?: (phaseId: string, text: string) => void;
  /** Reports the transport mode when a session falls back mid-turn. */
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

    const session = await this.deps.sessionFor(agent, phase.model);
    const envelopeKind = phase.envelope ?? agent.envelope;
    const rewinder = await PhaseRewinder.create(ctx.cwd, session, this.deps.rewindAfterCorrections);
    const maxGateAttempts = (phase.retries ?? 0) + 1;
    // One running count across envelope/boundary/gate so a trace can answer
    // "which correction attempt index succeeded" without kind-local indexes.
    let correctionIndex = 0;

    tracer.event({
      runId,
      phaseId,
      type: 'agent_start',
      name: agent.name,
      payload: {
        // The session's values, not the roster's: `inherit` has already been
        // resolved against the run default, so the event stream names the
        // model that actually serves the turn.
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        writes: boundary.describeBoundary(agent.writes),
        mode: session.currentMode,
      },
    });

    const rendered = renderPrompt(agent, phase, this.renderContext(phase, ctx));
    let prompt = rendered.user;
    const systemPrompt = agentSystemRole({
      rosterRole: rendered.system,
      repositoryContext: ctx.project.contextSummary,
      writes: agent.writes,
      cwd: ctx.cwd,
      projectPath: ctx.project.path,
      setup: this.deps.setupExecution(),
    });
    tracer.writeRunFile(
      runId,
      `${agent.name}/prompts/${phase.name}-1.md`,
      formatPromptRecord({ ...rendered, system: systemPrompt }),
    );

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
        systemPrompt,
        envelopeKind,
        gateAttempt,
        ctx,
        rewinder,
        () => {
          correctionIndex += 1;
          return correctionIndex;
        },
      );
      if (!parsed.ok) {
        lastError = parsed.detail;
        tracer.closePhase(phaseId, 'fail', lastError);
        return { kind: 'abort', detail: lastError };
      }
      envelope = parsed.envelope;

      const enforcement = await boundary.enforce({
        cwd: ctx.cwd,
        before: rewinder.baseline(),
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
          correctionIndex += 1;
          const rewind = await rewinder.rewindIfDue(correctionIndex);
          tracer.event({
            runId,
            phaseId,
            type: 'correction',
            name: 'boundary violation',
            payload: {
              attempt: gateAttempt,
              correctionIndex,
              violations: enforcement.violations.map((v) => v.path),
              ...rewindPayload(rewind),
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
        const opened = await this.recordPrIfNeeded(phase, envelopeKind, envelope, phaseId, ctx);
        if (!opened.ok) {
          lastError = opened.detail;
          tracer.closePhase(phaseId, 'fail', lastError);
          return { kind: 'abort', detail: lastError };
        }
        tracer.closePhase(phaseId, 'success');
        return { kind: 'next' };
      }

      lastError = `gates rejected the phase: ${violations[0]}`;
      if (gateAttempt < maxGateAttempts) {
        prompt = gateCorrection(violations);
        correctionIndex += 1;
        const rewind = await rewinder.rewindIfDue(correctionIndex);
        tracer.event({
          runId,
          phaseId,
          type: 'correction',
          name: 'gate violations',
          payload: {
            attempt: gateAttempt,
            correctionIndex,
            violations,
            ...rewindPayload(rewind),
          },
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
    systemPrompt: string,
    envelopeKind: PhaseDef['envelope'] & string,
    gateAttempt: number,
    ctx: RunContext,
    rewinder: PhaseRewinder,
    nextCorrectionIndex: () => number,
  ): Promise<{ ok: true; envelope: Envelope } | { ok: false; detail: string }> {
    let prompt = firstPrompt;
    // The wire constraint and the parse come off the same zod schema, so a
    // reply that satisfies the constraint always satisfies the parse.
    const outputFormat = {
      type: 'json_schema' as const,
      schema: jsonSchemaFor(envelopeKind, agent.customFields, this.deps.envelopeDefs),
    };

    for (let attempt = 1; attempt <= this.deps.envelopeRetries + 1; attempt++) {
      if (ctx.cancelled()) return { ok: false, detail: KILLED_DETAIL };

      let outcome;
      try {
        outcome = await session.send(prompt, {
          phaseId,
          outputFormat,
          systemPrompt,
          onText: (text) => this.deps.onLiveText?.(phaseId, text),
        });
        if (outcome.interrupted) {
          if (ctx.cancelled()) return { ok: false, detail: KILLED_DETAIL };
          return { ok: false, detail: 'the agent turn was interrupted' };
        }
      } catch (e) {
        // A turn the operator ended is not an agent failure, and filing it as
        // one puts a red error on a timeline that only shows what was asked for.
        if (ctx.cancelled()) return { ok: false, detail: KILLED_DETAIL };
        ctx.tracer.event({
          runId: ctx.runId,
          phaseId,
          type: 'error',
          name: `${agent.name}: turn failed`,
          payload: { message: (e as Error).message, attempt },
        });
        return { ok: false, detail: `the agent turn failed: ${(e as Error).message}` };
      }

      rewinder.noteAnchor();

      const usageEventId = ctx.tracer.recordUsage(ctx.runId, phaseId, agent.name, outcome.usage);
      ctx.tracer.appendRunFile(
        ctx.runId,
        `${agent.name}/raw.jsonl`,
        `${JSON.stringify({ phase: phase.name, gateAttempt, attempt, reason: outcome.reason, text: outcome.text })}\n`,
      );

      const parsed = this.envelopeFrom(outcome, envelopeKind, agent);
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
      const correctionIndex = nextCorrectionIndex();
      // The final failed attempt still records a correction for the trace, but
      // there is no retry turn to send — rewind only runs when a retry follows.
      const willRetry = attempt <= this.deps.envelopeRetries;
      const rewind = willRetry ? await rewinder.rewindIfDue(correctionIndex) : null;
      ctx.tracer.event({
        runId: ctx.runId,
        phaseId,
        type: 'correction',
        name: 'envelope did not parse',
        payload: { attempt, correctionIndex, problem, ...rewindPayload(rewind) },
      });
      if (!willRetry) break;
      prompt = correctionMessage(problem);
    }

    return {
      ok: false,
      detail: `the agent did not produce a valid ${envelopeKind} envelope in ${this.deps.envelopeRetries + 1} attempts`,
    };
  }

  /**
   * Where the envelope comes from, in order of trust. A structured reply is
   * the primary path — but "the transport shaped it" is a claim, not a
   * verdict, so it is validated against the same zod schema the text path uses
   * and a rejection falls back to reading the text, on the same retry budget.
   * A reply the transport could not shape at all arrives with nothing here,
   * which is the same fallback by a different route.
   */
  private envelopeFrom(
    outcome: { text: string; structuredOutput: Record<string, unknown> | null },
    envelopeKind: string,
    agent: AgentDef,
  ): ParseOutcome {
    const fromText = (): ParseOutcome =>
      parseEnvelope(outcome.text, envelopeKind, agent.customFields, this.deps.envelopeDefs);
    if (!outcome.structuredOutput) return fromText();

    const structured = validateEnvelope(
      outcome.structuredOutput,
      envelopeKind,
      agent.customFields,
      this.deps.envelopeDefs,
    );
    if (structured.ok) return structured;
    const text = fromText();
    // The structured rejection is the more specific complaint when neither
    // source parses: it names the field the model actually got wrong.
    return text.ok ? text : structured;
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

  /**
   * After a valid `pr` envelope, the engine — not the agent — pushes the run
   * branch and creates or discovers the PR. After a valid `issue` envelope it
   * files the GitHub issue the same way. Envelope success is not enough:
   * FOU-15 requires the artifact's number/URL or the exact failure.
   */
  private async recordPrIfNeeded(
    phase: PhaseDef,
    envelopeKind: string,
    envelope: Envelope,
    phaseId: string,
    ctx: RunContext,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    if (envelopeKind !== 'pr' && envelopeKind !== 'issue') return { ok: true };
    const title = typeof envelope.title === 'string' ? envelope.title : '';
    const body = typeof envelope.body === 'string' ? envelope.body : '';

    if (envelopeKind === 'issue') {
      const labels = Array.isArray(envelope.labels)
        ? envelope.labels.filter((l): l is string => typeof l === 'string')
        : [];
      const result = await ctx.recordIssue({ title, body, labels });
      ctx.tracer.event({
        runId: ctx.runId,
        phaseId,
        type: 'log',
        name: 'issue create',
        payload: {
          phase: phase.name,
          detail: result.detail,
          number: result.number ?? null,
          url: result.url ?? null,
        },
      });
      if (!result.ok || result.number == null || !result.url) {
        return {
          ok: false,
          detail: result.detail || 'gh issue create did not return an issue number and URL',
        };
      }
      ctx.tracer.setIssue(ctx.runId, result.number, result.url);
      return { ok: true };
    }

    const result = await ctx.recordPr({ title, body });
    ctx.tracer.event({
      runId: ctx.runId,
      phaseId,
      type: 'log',
      name: 'pr create',
      payload: {
        phase: phase.name,
        detail: result.detail,
        number: result.number ?? null,
        url: result.url ?? null,
      },
    });
    if (!result.ok || result.number == null || !result.url) {
      return {
        ok: false,
        detail: result.detail || 'gh pr create did not return a pull request number and URL',
      };
    }
    ctx.tracer.setPr(ctx.runId, result.number, result.url);
    return { ok: true };
  }

  private renderContext(phase: PhaseDef, ctx: RunContext): RenderContext {
    return {
      request: ctx.request,
      runId: ctx.runId,
      worktree: ctx.cwd,
      handoffDir: ctx.handoffDir,
      handoffFiles: this.handoffFiles(ctx),
      branch: ctx.branch,
      baseRef: ctx.baseRef,
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

/** Additive correction-payload fields when a rewind actually ran. */
function rewindPayload(rewind: RewindTrace | null): Record<string, unknown> {
  if (!rewind) return {};
  return {
    rewind: true,
    restoredCount: rewind.restoredCount,
    deletedCount: rewind.deletedCount,
    ...(rewind.failedRestoreCount ? { failedRestoreCount: rewind.failedRestoreCount } : {}),
    ...(rewind.failedDeleteCount ? { failedDeleteCount: rewind.failedDeleteCount } : {}),
    ...(rewind.worktreeRestoredCount
      ? { worktreeRestoredCount: rewind.worktreeRestoredCount }
      : {}),
    ...(rewind.worktreeCleanedCount ? { worktreeCleanedCount: rewind.worktreeCleanedCount } : {}),
  };
}
