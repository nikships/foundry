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
import {
  feedbackDelta,
  formatPromptRecord,
  renderPrompt,
  type RenderContext,
  type RenderedPrompt,
} from '../prompts.js';
import { promptFingerprint, type PromptLedger } from '../prompt-ledger.js';
import { agentSystemRole, type SetupExecution } from '../agent-context.js';
import { diffStat } from '../git.js';

const DIFF_CONTEXT_AGENTS = new Set(['reviewer', 'finisher', 'pr_writer', 'documenter']);
const DIFF_STAT_MAX_CHARS = 4000;

export interface AgentRunnerDeps {
  agents: AgentDef[];
  envelopeDefs: EnvelopeDef[];
  envelopeRetries: number;
  /**
   * After this many failed corrections in a phase, rewind the SDK session
   * instead of appending another correction. `0` disables.
   */
  rewindAfterCorrections: number;
  /** Session lookup stays with the executor, which also applies phase execution overrides. */
  sessionFor: (
    agent: AgentDef,
    modelOverride?: string,
    reasoningEffortOverride?: AgentDef['reasoningEffort'],
  ) => Promise<AgentSession>;
  setupExecution: () => SetupExecution | null;
  /**
   * Which phase prompts each live session still holds. Owned by the executor
   * because only it sees session replacement and compaction.
   */
  prompts: PromptLedger;
  onLiveText?: (phaseId: string, text: string) => void;
}

export class AgentPhaseRunner implements PhaseRunner {
  readonly kind = 'agent' as const;

  /** How many times each phase has been prompted, so no record overwrites another. */
  private readonly entries = new Map<string, number>();

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

    const session = await this.deps.sessionFor(agent, phase.model, phase.reasoningEffort);
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

    const composed = await this.compose(agent, phase, ctx, session);
    let prompt = composed.rendered.user;
    const systemPrompt = composed.systemPrompt;
    const entry = (this.entries.get(phase.name) ?? 0) + 1;
    this.entries.set(phase.name, entry);
    tracer.writeRunFile(
      runId,
      `${agent.name}/prompts/${phase.name}-${entry}.md`,
      formatPromptRecord({ ...composed.rendered, system: systemPrompt }),
    );
    tracer.event({
      runId,
      phaseId,
      type: 'log',
      name: 'prompt',
      payload: { phase: phase.name, entry, kind: composed.delta ? 'delta' : 'full' },
    });

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
          const rewind = await this.rewindIfDue(rewinder, session, correctionIndex);
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
        const rewind = await this.rewindIfDue(rewinder, session, correctionIndex);
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
   * Rewind, and forget every prompt the session was holding when it ran.
   *
   * A rewind branches the conversation *before* the anchor — which is the
   * phase's own prompt — so the successor conversation no longer contains it.
   * A later feedback re-entry must render the whole thing again.
   */
  private async rewindIfDue(
    rewinder: PhaseRewinder,
    session: AgentSession,
    correctionIndex: number,
  ): Promise<RewindTrace | null> {
    const rewind = await rewinder.rewindIfDue(correctionIndex);
    if (rewind) this.deps.prompts.forget(session);
    return rewind;
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
    envelopeKind: string,
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
      const rewind = willRetry ? await this.rewindIfDue(rewinder, session, correctionIndex) : null;
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
    const isIssue = envelopeKind === 'issue';
    const result = isIssue
      ? await ctx.recordIssue({
          title,
          body,
          labels: Array.isArray(envelope.labels)
            ? envelope.labels.filter((label): label is string => typeof label === 'string')
            : [],
        })
      : await ctx.recordPr({ title, body });
    ctx.tracer.event({
      runId: ctx.runId,
      phaseId,
      type: 'log',
      name: isIssue ? 'issue create' : 'pr create',
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
        detail:
          result.detail ||
          (isIssue
            ? 'gh issue create did not return an issue number and URL'
            : 'gh pr create did not return a pull request number and URL'),
      };
    }
    if (isIssue) ctx.tracer.setIssue(ctx.runId, result.number, result.url);
    else ctx.tracer.setPr(ctx.runId, result.number, result.url);
    return { ok: true };
  }

  /**
   * The prompt this entry into the phase actually sends.
   *
   * A `feedbackTo` jump re-enters a phase whose live session usually still
   * holds that phase's rendered prompt, and re-sending it duplicates the
   * largest block in the run. So the prompt is rendered twice: once as it would
   * read with no feedback (the fingerprint of what the session may already
   * hold) and once for real. When the fingerprints agree, only the feedback
   * evidence goes on the wire — but the system role always comes off the real
   * render, because a turn's standing rules are re-sent in full every time.
   *
   * Everything that could have dropped that prompt from context — compaction,
   * rewind, a closed or replaced session — has already cleared the ledger, and
   * a stale render simply misses the fingerprint. A miss costs tokens; a wrong
   * hit would cost correctness, which is why the comparison is exact.
   */
  private async compose(
    agent: AgentDef,
    phase: PhaseDef,
    ctx: RunContext,
    session: AgentSession,
  ): Promise<{ rendered: RenderedPrompt; systemPrompt: string; delta: boolean }> {
    const context = await this.renderContext(agent, phase, ctx);
    // Empty evidence is not evidence. Normalising it here keeps the
    // fingerprint, the wire, and the delta decision from disagreeing about
    // what "no feedback" renders as.
    const feedback = context.feedback?.trim() ? context.feedback : undefined;

    // The fingerprint describes the prompt as first entry sent it, which
    // carried no feedback — that is what a later re-entry may skip re-sending.
    const baseline =
      feedback === undefined
        ? renderPrompt(agent, phase, context)
        : renderPrompt(agent, phase, { ...context, feedback: undefined });
    const fingerprint = promptFingerprint(baseline);

    // `{{feedback}}` is a documented token in both templates, so an agent whose
    // roster *system* prompt names it must still receive the real evidence —
    // including on the delta path, where the user message no longer carries it.
    const rendered = feedback === undefined ? baseline : renderPrompt(agent, phase, context);
    // One role for both paths below: the delta trims the user message, never
    // the standing rules, so a read-only agent is told it has no shell on a
    // feedback re-entry exactly as it was on first entry.
    const systemPrompt = agentSystemRole({
      rosterRole: rendered.system,
      repositoryContext: ctx.project.contextSummary,
      writes: agent.writes,
      ...(agent.toolProfile ? { toolProfile: agent.toolProfile } : {}),
      cwd: ctx.cwd,
      projectPath: ctx.project.path,
      setup: this.deps.setupExecution(),
    });

    if (feedback !== undefined && this.deps.prompts.matches(session, phase.name, fingerprint)) {
      return {
        rendered: { system: rendered.system, user: feedbackDelta({ phase: phase.name, feedback }) },
        systemPrompt,
        delta: true,
      };
    }

    this.deps.prompts.note(session, phase.name, fingerprint);
    return { rendered, systemPrompt, delta: false };
  }

  private async renderContext(
    agent: AgentDef,
    phase: PhaseDef,
    ctx: RunContext,
  ): Promise<RenderContext> {
    const stat = DIFF_CONTEXT_AGENTS.has(agent.name)
      ? (await diffStat(ctx.cwd, ctx.branchPointSha)).trim().slice(0, DIFF_STAT_MAX_CHARS)
      : null;
    return {
      request: ctx.request,
      runId: ctx.runId,
      worktree: ctx.cwd,
      handoffDir: ctx.handoffDir,
      handoffFiles: this.handoffFiles(ctx),
      branch: ctx.branch,
      baseRef: ctx.baseRef,
      gitContext:
        stat === null ? undefined : { branchPointSha: ctx.branchPointSha, diffStat: stat },
      envelopes: ctx.envelopes,
      feedback: ctx.feedback.get(phase.name),
      recoveryNote: ctx.recoveryNotes.get(phase.name),
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
