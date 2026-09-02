/**
 * The run loop. Code owns sequencing, retries, and acceptance; agents work
 * inside one bounded phase each and never decide whether they succeeded.
 *
 * Three invariants hold here and nowhere else:
 *   - A phase is born `fail` and flips only on a clean finish (plus a parsed
 *     envelope and green gates, for agent phases).
 *   - Corrections re-prompt the SAME session, so a retry costs one message.
 *   - `finish` settles status, notification, and banner in one call, so they
 *     cannot disagree.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentDef,
  CommandResult,
  ContextBreakdown,
  EnvelopeDef,
  GeneratedRunPlan,
  PipelineAmendment,
  PhaseDef,
  PhaseKind,
  PhaseRow,
  PipelineDef,
  ProjectDef,
  ReasoningEffort,
  RunSource,
  RunStatus,
  ValidationIssue,
} from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import { AgentSession, KILLED_DETAIL, type Mode, type TransportRequest } from '../pi/session.js';
import { lazyTransport } from '../pi/lazy-transport.js';
import type { AgentTransport } from '../pi/transport.js';
import { decideAcceptance } from './acceptance.js';
import { capturePhaseStart } from './checkpoint.js';
import type { PhaseRunner, RunContext, PhaseJump } from './phase-context.js';
import { AgentPhaseRunner } from './runners/agent.js';
import { CodePhaseRunner } from './runners/code.js';
import * as worktreeLib from './worktree.js';
import { recordLanding } from './settle.js';
import type { Envelope } from './envelopes.js';
import type { CommandDriftRecord } from './detect.js';
import type { HealingSupport } from './healing.js';
import { runCommand } from './commands.js';
import { killedRecoveryNote } from './prompts.js';
import { PromptLedger } from './prompt-ledger.js';
import { createIssue, openPr, type GhOptions } from '../system/gh.js';
import type { IssueAction, PrAction } from '@shared/ipc-contract.js';
import {
  CONTINUE_STATUS_REFUSAL,
  continuableStatus,
  continueStrategyFor,
  effectivePhaseEnvelope,
  resolveAgentExecution,
} from '@shared/types.js';
import type { SetupExecution } from './agent-context.js';
import type { Replanner } from '../orchestrator/replan.js';
import { generatedCompositionIssues, phaseModelIssues } from '../orchestrator/plan.js';
import { validate as validatePipeline } from '../store/pipelines.js';
import { validate as validateAgent } from '../store/roster.js';
import { preflightForRun } from './preflight.js';
import { FIXED_ENGINE_DEFAULTS } from '@shared/types.js';
import { activeRowsForPipeline } from './phase-history.js';
import type { RunSourceLifecycle, RunSourceStage } from './source-lifecycle.js';

export interface ExecutorDeps {
  tracer: Tracer;
  defaultModel?: string;
  defaultReasoningEffort?: ReasoningEffort;
  envelopeRetries: number;
  gateRetries: number;
  /** Context occupancy at which a session is compacted between phases. */
  compactionThreshold: number;
  /**
   * After this many failed corrections in a phase, rewind the SDK session
   * instead of appending another correction. `0` disables.
   */
  rewindAfterCorrections: number;
  /**
   * How a failing code phase opens a healing turn. Omitted (or null) means no
   * healing: a red command escalates through `feedbackTo` or fails the run.
   */
  healing?: HealingSupport | null;
  /** Present only for an orchestrated run. Manual runs never amend themselves. */
  replanner?: Replanner | null;
  /** Foundry's Application Support directory; the agent runtime's state lives under it. */
  supportDir: string;
  /**
   * Models the operator hid in Settings. Failover skips them. Read live so a
   * hide mid-run applies to the next exhausted retry, not only to a new run.
   */
  hiddenModelIds?: () => readonly string[];
  agents: AgentDef[];
  /** Shared custom envelope library snapshotted at run start. */
  envelopeDefs: EnvelopeDef[];
  project: ProjectDef;
  pipeline: PipelineDef;
  request: string;
  /** The active Orchestrator plan; absent for a manual run. */
  plan?: GeneratedRunPlan | null;
  /** Immutable external issue snapshot, absent for an ordinary prompt run. */
  source?: RunSource | null;
  /** External status adapter; failures are evidence and never change the run verdict. */
  sourceLifecycle?: RunSourceLifecycle | null;
  runId: string;
  engineer: string;
  onLiveText?: (phaseId: string, text: string) => void;
  onRunFinished?: (status: RunStatus) => void;
  /**
   * How auto-merge records a landing. Production threads the project store
   * through here so command drift writes back; tests that omit it still get
   * `setMerged` + a cleared worktree path.
   */
  landing?: {
    currentProject(): ProjectDef;
    saveProject(next: ProjectDef): { ok: boolean };
    notifySettings(): void;
    notifyRuns(): void;
  };
  /** Test seam: the fake gh script stands in for the real binary. */
  gh?: GhOptions;
  /**
   * Test seam: supply the transport each agent session drives. Production
   * leaves this unset and loads `PiTransport` on the first turn — a real run
   * has no other transport, so there is nothing here to fall back to.
   */
  transport?: (input: TransportRequest) => AgentTransport;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  worktreePath: string | null;
  branch: string | null;
  merged: boolean;
  detail: string;
}

/** Vestigial: builtins write specs/, but custom prompts may still use {{handoff_dir}}. */
const HANDOFF_DIR = '.foundry-handoff';

export class Executor {
  private readonly sessions = new Map<string, AgentSession>();
  /** Interrupts for in-flight work a cancel cannot reach through `sessions`. */
  private readonly aborts = new Set<() => void>();
  private readonly envelopes = new Map<string, Envelope>();
  private readonly commandResults = new Map<string, CommandResult>();
  private readonly phaseIds = new Map<string, string>();
  private readonly feedback = new Map<string, string>();
  private readonly commandDrift = new Map<string, CommandDriftRecord>();
  /** Recovery notes for a phase this run is restarting rather than entering. */
  private readonly recoveryNotes = new Map<string, string>();
  /**
   * Agents whose persisted session must NOT be reopened by the next
   * `sessionFor`, so they start a new conversation instead.
   *
   * Continuing a rejected or failed run is a correction: the agent's own
   * session still describes the phase, and reopening it is what makes a retry
   * cost one message. A kill is not a correction — the operator stopped a turn
   * mid-flight, so that conversation ends on a truncated exchange the retry
   * would otherwise reason from. The name is consumed on use rather than left
   * standing, because only the interrupted phase's entry is affected: a later
   * phase on the same agent goes back to the session this resume opened.
   *
   * Deliberately executor state rather than a delete of the `agent_sessions`
   * row. That row is keyed on (run, agent) and the successor overwrites it, so
   * what survives a delete-vs-skip choice is the transcript the killed attempt
   * wrote and the recovery event naming the id it left — deleting the row
   * would take the agent's roster entry out of the run for no gain.
   */
  private readonly freshSessionAgents = new Set<string>();
  /**
   * The recovery event still waiting for the id of the session it caused.
   *
   * A session opens lazily on its first turn, so the new id does not exist at
   * resume time; the event is written with the abandoned id immediately and
   * patched once the successor has one.
   */
  private recovery: { eventId: string; agent: string; previousSessionId: string | null } | null =
    null;
  /**
   * Which phase prompts each live session still holds, so a feedback re-entry
   * can send a delta. Lives here rather than in the runner because only the
   * executor sees the events that drop a prompt from a session's context:
   * compaction, close, and replacement in `sessionFor`.
   */
  private readonly prompts = new PromptLedger();
  private readonly agents: AgentDef[];
  private pipeline: PipelineDef;
  private plan: GeneratedRunPlan | null;
  private replanAttempts = 0;
  private setupExecution: SetupExecution | null = null;
  private cancelled = false;
  private handle: worktreeLib.WorktreeHandle | null = null;
  private cwd: string;
  private readonly mode: Mode = 'pi';
  private readonly runners: Record<PhaseKind, PhaseRunner>;

  constructor(private readonly deps: ExecutorDeps) {
    this.cwd = deps.project.path;
    this.agents = [...deps.agents];
    this.pipeline = deps.pipeline;
    this.plan = deps.plan ?? null;
    this.runners = {
      agent: new AgentPhaseRunner({
        agents: this.agents,
        envelopeDefs: deps.envelopeDefs,
        envelopeRetries: deps.envelopeRetries,
        rewindAfterCorrections: deps.rewindAfterCorrections,
        sessionFor: (agent, modelOverride, reasoningEffortOverride) =>
          this.sessionFor(agent, modelOverride, reasoningEffortOverride),
        setupExecution: () => this.currentSetupExecution(),
        prompts: this.prompts,
        onLiveText: deps.onLiveText,
      }),
      code: new CodePhaseRunner(),
    };
  }

  get runId(): string {
    return this.deps.runId;
  }

  cancel(): void {
    this.cancelled = true;
    for (const session of this.sessions.values()) session.kill();
    // A turn that is not an agent session has no entry in `sessions` to kill,
    // so explicit cancellation has to reach it through its registered abort.
    for (const abort of this.aborts) {
      try {
        abort();
      } catch {
        // One uncooperative abort must not keep the rest from being called.
      }
    }
  }

  /**
   * Registers an interrupt for work that is blocking a phase on something
   * other than an agent session, and returns its own removal.
   *
   * Cancelling already-finished work is harmless but pointless, so a caller
   * that completes normally is expected to unregister rather than leave a
   * stale abort behind for the rest of the run.
   */
  private onCancel(abort: () => void): () => void {
    this.aborts.add(abort);
    // A cancel that arrived first still has to reach this caller: it missed the
    // sweep above, and `cancelled()` alone would not stop the turn.
    if (this.cancelled) abort();
    return () => this.aborts.delete(abort);
  }

  /**
   * What is occupying one agent's context right now, plus the transport that
   * answered.
   *
   * `null` when this run never started a session for that agent: a disclosure
   * must not spawn a child to have something to show.
   */
  async contextBreakdown(
    agent: string,
  ): Promise<{ breakdown: ContextBreakdown | null; mode: Mode } | null> {
    const session = this.sessions.get(agent);
    if (!session) return null;
    return { breakdown: await session.contextBreakdown(), mode: session.currentMode };
  }

  async run(): Promise<RunOutcome> {
    const { tracer, project, runId } = this.deps;
    const pipeline = this.pipeline;
    const isolate = pipeline.isolation !== false && project.isolation;

    if (isolate) {
      try {
        this.handle = await worktreeLib.create({
          repo: project.path,
          runId,
          baseRef: project.baseRef,
        });
        this.cwd = this.handle.path;
      } catch (e) {
        tracer.startRun({
          runId,
          projectId: project.id,
          pipeline,
          request: this.deps.request,
          engineer: this.deps.engineer,
          worktreePath: null,
          branch: null,
          baseRef: project.baseRef,
          mode: this.mode,
          plan: this.plan,
          source: this.deps.source ?? null,
        });
        await this.advanceSource('started');
        tracer.event({
          runId,
          type: 'error',
          name: 'worktree',
          payload: { message: (e as Error).message },
        });
        return this.finish('failed', `could not isolate the run: ${(e as Error).message}`);
      }
    }

    tracer.startRun({
      runId,
      projectId: project.id,
      pipeline,
      request: this.deps.request,
      engineer: this.deps.engineer,
      worktreePath: this.handle?.path ?? null,
      branch: this.handle?.branch ?? null,
      baseRef: project.baseRef,
      branchPointSha: this.handle?.branchPointSha ?? null,
      mode: this.mode,
      plan: this.plan,
      source: this.deps.source ?? null,
    });
    await this.advanceSource('started');

    // Per-project bootstrap: install deps in a fresh worktree so agents
    // find their binaries. Fail-fast with evidence; the worktree is kept
    // for inspection (settle() still decides, but the status is already failed).
    if (isolate && this.handle && project.setupScript?.trim()) {
      const script = project.setupScript.trim();
      tracer.event({ runId, type: 'log', name: 'worktree setup', payload: { script } });
      const setupEvent = tracer.event({
        runId,
        type: 'tool_call',
        name: 'setup',
        payload: { script, cwd: this.handle.path },
      });
      const result = await runCommand({
        argv: ['sh', '-c', script],
        cwd: this.handle.path,
        name: 'setup',
        runId,
        onPid: (pid, command) =>
          tracer.recordProcess({ runId, kind: 'code', name: 'setup', pid, command }),
      });
      tracer.writeRunFile(runId, 'setup.log', result.outputTail);
      tracer.endEvent(setupEvent, {
        exitCode: result.exitCode,
        passed: result.passed,
        result: result.outputTail.slice(-2000),
      });
      this.setupExecution = { command: script, exitCode: result.exitCode };
      if (!result.passed) {
        tracer.event({
          runId,
          type: 'error',
          name: 'setup',
          payload: {
            message: `worktree setup failed (exit ${result.exitCode ?? '—'}): ${result.outputTail.slice(-1500)}`,
          },
        });
        return this.finish(
          'failed',
          `worktree setup failed (exit ${result.exitCode ?? '—'}): ${result.outputTail.slice(-800).trim() || 'see setup.log'}`,
        );
      }
    }

    mkdirSync(join(this.cwd, HANDOFF_DIR), { recursive: true });

    // Queued phases exist up front so the waterfall can draw what has not run
    // yet as dashed blocks instead of appearing one at a time.
    pipeline.phases.forEach((phase, index) => {
      const owner =
        phase.kind === 'agent'
          ? (phase.agent ?? 'agent')
          : phase.kind === 'code'
            ? 'code'
            : this.deps.engineer;
      this.phaseIds.set(
        phase.name,
        tracer.queuePhase({
          runId,
          seq: index,
          name: phase.name,
          kind: phase.kind,
          owner,
          description: phase.description,
        }),
      );
    });

    return this.runFrom(0);
  }

  /**
   * Continue a terminal run from its first failed phase in the existing
   * worktree.
   *
   * How the interrupted phase's agent re-enters depends on how the run
   * stopped: a rejected or failed run reopens the persisted conversation (the
   * correction workflow), a killed agent phase starts a fresh session because
   * the conversation it would reopen ends on the turn the operator cut off. A
   * killed `code` or `engineer` phase has no conversation at all, so it is
   * continued the ordinary way.
   */
  async resume(): Promise<RunOutcome> {
    const { tracer, project, runId } = this.deps;
    const pipeline = this.pipeline;
    const run = tracer.run(runId);
    if (!run || !continuableStatus(run.status)) throw new Error(CONTINUE_STATUS_REFUSAL);
    if (run.merged) throw new Error('a merged run cannot be continued');

    const active = activeRowsForPipeline(pipeline, tracer.phases(runId));
    if (!active) {
      throw new Error('the saved pipeline no longer matches this run’s phase history');
    }
    const startIndex = active.findIndex((phase) => phase.status === 'fail');
    if (startIndex < 0) throw new Error('this run has no failed phase to continue');

    const isolate = pipeline.isolation !== false && project.isolation;
    if (isolate) {
      if (!run.worktreePath || !run.branch || !existsSync(run.worktreePath)) {
        throw new Error('this run’s worktree is no longer available');
      }
      this.handle = {
        path: run.worktreePath,
        branch: run.branch,
        baseRef: run.baseRef ?? project.baseRef,
        branchPointSha: run.branchPointSha ?? '',
      };
      this.cwd = run.worktreePath;
    }

    for (const phase of active) this.phaseIds.set(phase.name, phase.phaseId);
    const phaseNames = new Map(active.map((phase) => [phase.phaseId, phase]));
    for (const envelope of tracer.envelopes(runId)) {
      const phase = phaseNames.get(envelope.phaseId);
      if (phase?.status === 'success' && envelope.valid) {
        this.envelopes.set(phase.name, envelope.payload as Envelope);
      }
    }
    this.replanAttempts = tracer.replanAttempts(runId);

    const interrupted = pipeline.phases[startIndex]!;
    // The interrupted phase is half the answer: a killed shell command has no
    // conversation to abandon, so it is continued rather than restarted.
    const strategy = continueStrategyFor(run.status, interrupted.kind);
    if (!strategy) throw new Error(CONTINUE_STATUS_REFUSAL);
    mkdirSync(join(this.cwd, HANDOFF_DIR), { recursive: true });
    // `reopenRun` overwrites the terminal status in place, so by the time the
    // next verdict lands nothing in `runs` says how this run had stopped. The
    // recovery event is what keeps that on the record.
    tracer.reopenRun(runId);
    tracer.event({
      runId,
      type: 'log',
      name: 'run continued',
      payload: { phase: interrupted.name, fromStatus: run.status, strategy },
    });
    await this.advanceSource('started');
    if (strategy === 'fresh_session') this.startFreshSession(interrupted, run.status);
    return this.runFrom(startIndex);
  }

  /**
   * Arms the fresh-session path for the phase a kill interrupted, and records
   * the recovery.
   *
   * Only that phase's agent is affected: another agent's session was not the
   * one cut off mid-turn, so its conversation is still an honest record of
   * what it did and is reopened normally.
   *
   * Nothing is recorded unless a named agent is actually being moved off a
   * conversation. `strategy` already excludes a non-agent phase, so a phase
   * that reaches here without an agent name is a malformed definition rather
   * than a recovery, and an event claiming one would be a permanent false
   * entry in the trace: it could never be patched, because there is no session
   * whose open would complete it.
   */
  private startFreshSession(phase: PhaseDef, fromStatus: RunStatus): void {
    const { tracer, runId } = this.deps;
    const agent = phase.kind === 'agent' ? phase.agent : undefined;
    if (!agent) return;
    const previousSessionId =
      tracer.agentSessions(runId).find((row) => row.agent === agent)?.agentSessionId ?? null;
    const eventId = tracer.event({
      runId,
      phaseId: this.phaseIds.get(phase.name) ?? null,
      type: 'log',
      name: 'run recovered',
      payload: {
        fromStatus,
        strategy: 'fresh_session',
        phase: phase.name,
        agent,
        previousSessionId,
        // Filled in once the successor session actually opens; a phase that
        // never gets that far leaves the null, which is the honest answer.
        newSessionId: null,
      },
    });
    this.freshSessionAgents.add(agent);
    this.recoveryNotes.set(phase.name, killedRecoveryNote(phase.name));
    this.recovery = { eventId, agent, previousSessionId };
  }

  private async runFrom(startIndex: number): Promise<RunOutcome> {
    const { tracer, runId } = this.deps;

    let index = startIndex;
    let guard = 0;
    let detail = '';

    while (index < this.pipeline.phases.length) {
      if (this.cancelled) return this.settleKilled();
      if (guard++ > this.pipeline.phases.length + 32 + this.replanAttempts * 32) {
        detail = 'the pipeline exceeded its step budget: a feedback loop is not converging';
        tracer.event({ runId, type: 'error', name: 'loop guard', payload: { detail } });
        break;
      }

      // Between phases is the only window a session may be compacted in: no
      // stream is open, and the next phase's turn has not been composed yet.
      // Before the phase rather than after, so the last phase of a run is never
      // followed by a compaction nothing will use; the first pass has no
      // sessions yet, which is what makes this the space *between* phases.
      await this.compactFullSessions();

      const phase = this.pipeline.phases[index]!;
      // Before the phase's work begins, and on every entry into it: a
      // `feedbackTo` re-entry is a new attempt, so it earns its own generation
      // rather than reusing where the first attempt started.
      await this.checkpointPhaseStart(phase);
      const jump = await this.runPhase(phase);
      if (jump.kind === 'abort') {
        if (await this.tryReplan(index, phase, jump.detail)) {
          // The failed definition was removed from the active pipeline. The
          // first replacement occupies the same logical index.
          continue;
        }
        if (this.cancelled) return this.settleKilled();
        // FOU-15: a PR (or issue) phase that could not create its artifact is
        // a hard fail with the exact error. Do not let a prior acceptance flag
        // (e.g. production_check.approved) mark the run accepted.
        const envelope = this.phaseEnvelope(phase);
        if (envelope === 'pr' || envelope === 'issue') {
          await this.closeSessions();
          return this.finish('rejected', jump.detail);
        }
        detail = jump.detail;
        break;
      }
      if (jump.kind === 'goto') {
        index = this.pipeline.phases.findIndex((p) => p.name === jump.phase);
        if (index < 0) {
          detail = `feedback target "${jump.phase}" vanished`;
          break;
        }
        continue;
      }
      index++;
    }

    // A kill is an operator verdict, not a phase outcome: whatever the pipeline
    // managed to finish first must not be run through acceptance, or a phase
    // that completed before the kill landed settles the run as accepted.
    if (this.cancelled) return this.settleKilled();

    await this.closeSessions();
    const verdict = decideAcceptance({
      acceptance: this.pipeline.acceptance,
      phases: this.activePhaseRows(),
      envelopes: this.envelopes,
      commandResults: this.commandResults,
    });
    // An abort detail explains why the pipeline stopped early; otherwise the
    // acceptance criterion explains itself.
    return this.finish(
      verdict.accepted ? 'accepted' : 'rejected',
      detail ? `${detail} (${verdict.reason})` : verdict.reason,
    );
  }

  /** The current logical pipeline rows, excluding superseded amendment history. */
  private activePhaseRows(): PhaseRow[] {
    const active = activeRowsForPipeline(
      this.pipeline,
      this.pipeline.phases.map((phase) => {
        const row = this.deps.tracer.phase(this.phaseId(phase.name));
        if (!row) throw new Error(`active phase "${phase.name}" has no trace row`);
        return row;
      }),
    );
    if (!active) throw new Error('the active pipeline no longer matches its phase rows');
    return active;
  }

  /**
   * The final recovery layer. Invalid and empty proposals spend the fixed
   * budget but do not mutate the active pipeline; only a proposal that passes
   * both ordinary rails reaches the Tracer's atomic queue replacement.
   */
  private async tryReplan(
    failedIndex: number,
    failedPhase: PhaseDef,
    detail: string,
  ): Promise<boolean> {
    const replanner = this.deps.replanner;
    if (!replanner || !this.plan) return false;

    const completed = this.pipeline.phases.slice(0, failedIndex).map((phase) => {
      const envelope = this.envelopes.get(phase.name);
      return envelope ? { phase, envelope } : { phase };
    });
    const remaining = this.pipeline.phases.slice(failedIndex + 1);
    const evidence = this.replanEvidence(failedPhase, detail);

    while (!this.cancelled && this.replanAttempts < FIXED_ENGINE_DEFAULTS.replanAttempts) {
      const attempt = ++this.replanAttempts;
      let amendment: PipelineAmendment | null = null;
      const release = this.onCancel(() => replanner.abort?.());
      try {
        amendment = await replanner.propose({
          plan: this.plan,
          roster: this.agents,
          commands: this.deps.project.commands,
          failedPhase,
          completed,
          remaining,
          evidence,
          attempt,
        });
      } catch (error) {
        this.deps.tracer.event({
          runId: this.deps.runId,
          phaseId: this.phaseId(failedPhase.name),
          type: 'error',
          name: 'replan proposal failed',
          payload: { attempt, message: (error as Error).message },
        });
      } finally {
        release();
      }
      if (this.cancelled) return false;
      if (!amendment) {
        this.traceRejectedAmendment(failedPhase, attempt, ['no valid amendment was proposed']);
        continue;
      }

      const checked = this.checkAmendment(failedIndex, amendment);
      if (!checked.ok) {
        this.traceRejectedAmendment(
          failedPhase,
          attempt,
          checked.issues.map((issue) => `${issue.where}: ${issue.message}`),
        );
        continue;
      }

      this.applyAmendment(
        failedIndex,
        failedPhase,
        amendment,
        attempt,
        checked.pipeline,
        checked.warnings,
        evidence,
      );
      return true;
    }
    return false;
  }

  private replanEvidence(failedPhase: PhaseDef, detail: string): string {
    const parts = [detail];
    const command = this.commandResults.get(failedPhase.name);
    if (command) {
      parts.push(
        `Command: ${command.command}\nExit: ${String(command.exitCode)}\n${command.outputTail}`,
      );
    }
    const envelope = this.envelopes.get(failedPhase.name);
    if (envelope) parts.push(`Envelope: ${JSON.stringify(envelope)}`);
    const phaseId = this.phaseId(failedPhase.name);
    const gates = this.deps.tracer
      .gateResults(this.deps.runId)
      .filter((gate) => gate.phaseId === phaseId);
    if (gates.length) parts.push(`Gates: ${JSON.stringify(gates)}`);
    return parts.filter(Boolean).join('\n\n').slice(-6000);
  }

  private checkAmendment(
    failedIndex: number,
    amendment: PipelineAmendment,
  ):
    | { ok: true; pipeline: PipelineDef; warnings: ValidationIssue[] }
    | { ok: false; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    const agentNames = new Set(this.agents.map((agent) => agent.name));
    const knownEnvelopes = this.deps.envelopeDefs.map((envelope) => envelope.name);
    for (const agent of amendment.agents) {
      if (agentNames.has(agent.name)) {
        issues.push({
          level: 'error',
          where: `agents.${agent.name}`,
          message: `an active agent is already named "${agent.name}"`,
        });
      }
      agentNames.add(agent.name);
      issues.push(
        ...validateAgent(agent, knownEnvelopes).map((issue) => ({
          ...issue,
          where: `agents.${agent.name}.${issue.where}`,
        })),
      );
    }

    const prefix = this.pipeline.phases.slice(0, failedIndex);
    const immutableNames = new Set(prefix.map((phase) => phase.name));
    for (const phase of amendment.phases) {
      if (phase.feedbackTo && immutableNames.has(phase.feedbackTo)) {
        issues.push({
          level: 'error',
          where: phase.name,
          message: `feedbackTo cannot re-enter completed phase "${phase.feedbackTo}"`,
        });
      }
    }

    const pipeline = { ...this.pipeline, phases: [...prefix, ...amendment.phases] };
    const agents = [...this.agents, ...amendment.agents];
    const commandNames = this.deps.project.commands.map((command) => command.name);
    issues.push(
      ...validatePipeline(pipeline, agents, commandNames, knownEnvelopes),
      ...preflightForRun(pipeline, agents, commandNames, knownEnvelopes, {
        scaffold: this.deps.project.scaffold === true,
      }),
      // An amendment inherits the confirmed plan's explicit appointments: it
      // may re-cast a phase onto any model that plan already reaches, but the
      // engine has no catalog here, so anything else is refused rather than
      // silently falling back to the install default.
      ...phaseModelIssues(amendment.phases, this.confirmedModelIds(), failedIndex),
      ...generatedCompositionIssues(
        { phases: amendment.phases },
        amendment.agents,
        agents,
        commandNames,
        {
          indexOffset: failedIndex,
          scaffold: this.deps.project.scaffold === true,
        },
      ),
    );
    const errors = issues.filter((issue) => issue.level === 'error');
    if (errors.length) return { ok: false, issues: errors };
    return { ok: true, pipeline, warnings: uniqueIssues(issues) };
  }

  /** The models the operator confirmed on the plan card, in plan order. */
  private confirmedModelIds(): string[] {
    const ids = new Set<string>();
    for (const phase of this.plan?.pipeline.phases ?? []) {
      if (phase.kind === 'agent' && phase.model && phase.model !== 'inherit') ids.add(phase.model);
    }
    return [...ids];
  }

  private applyAmendment(
    failedIndex: number,
    failedPhase: PhaseDef,
    amendment: PipelineAmendment,
    attempt: number,
    pipeline: PipelineDef,
    warnings: ValidationIssue[],
    evidence: string,
  ): void {
    const previousTail = this.pipeline.phases.slice(failedIndex);
    const queuedIds = previousTail.slice(1).map((phase) => this.phaseId(phase.name));
    const plan: GeneratedRunPlan = {
      ...this.plan!,
      pipeline,
      agents: [...this.plan!.agents, ...amendment.agents],
      warnings: uniqueIssues([...this.plan!.warnings, ...warnings]),
    };
    const ids = this.deps.tracer.amendRun({
      runId: this.deps.runId,
      failedPhaseId: this.phaseId(failedPhase.name),
      removeQueuedPhaseIds: queuedIds,
      pipeline,
      plan,
      reason: amendment.reason,
      attempt,
      evidence,
      before: previousTail.slice(1).map((phase) => phase.name),
      after: amendment.phases.map((phase) => phase.name),
      newPhases: amendment.phases,
      engineer: this.deps.engineer,
    });

    for (const phase of previousTail) {
      this.phaseIds.delete(phase.name);
      this.envelopes.delete(phase.name);
      this.commandResults.delete(phase.name);
      this.feedback.delete(phase.name);
    }
    for (const [name, id] of ids) this.phaseIds.set(name, id);
    this.agents.push(...amendment.agents);
    this.pipeline = pipeline;
    this.plan = plan;
  }

  private traceRejectedAmendment(phase: PhaseDef, attempt: number, issues: string[]): void {
    this.deps.tracer.event({
      runId: this.deps.runId,
      phaseId: this.phaseId(phase.name),
      type: 'log',
      name: 'replan proposal rejected',
      payload: { attempt, issues },
    });
  }

  /**
   * Writes where this phase begins, durably, before it begins.
   *
   * Never fatal. A run that cannot record its checkpoint is still a run the
   * operator asked for; failing it here would trade a working phase for a
   * missing record. The failure is traced so the absence is explained rather
   * than silent, and split-2 restore reads an absent checkpoint as absent.
   */
  private async checkpointPhaseStart(phase: PhaseDef): Promise<void> {
    const { tracer, runId } = this.deps;
    try {
      // Inside the try: `phaseId` throws for a phase that was never queued,
      // and this method promises never to be the thing that fails a run.
      const phaseId = this.phaseId(phase.name);
      const capture = await capturePhaseStart({ cwd: this.cwd, handoffDir: HANDOFF_DIR });
      const session = phase.agent ? this.sessions.get(phase.agent) : undefined;
      tracer.recordPhaseCheckpoint({
        runId,
        phaseId,
        phaseName: phase.name,
        phaseKind: phase.kind,
        headSha: capture.headSha,
        branch: this.handle?.branch ?? null,
        worktreePath: this.cwd,
        // A non-isolated run has no worktree: `this.cwd` is the project
        // checkout, so the capture holds the operator's own uncommitted work.
        // Recorded rather than skipped — that run has no worktree to discard,
        // which is precisely where a phase-start record is worth having — but
        // marked, because restoring into a live checkout is a different act.
        isolated: this.handle !== null,
        model: this.appointedModel(phase),
        agent: phase.agent ?? null,
        // The session's own id when one is already open, otherwise whatever a
        // previous attempt persisted — a phase that has not opened a session
        // yet has no leaf, and inventing one would misdescribe the anchor.
        agentSessionId: session?.sessionId ?? this.persistedSessionId(phase.agent),
        leafMessageId: session?.lastUserMessageId ?? null,
        handoffFiles: capture.handoffFiles,
        envelopePhases: [...this.envelopes.keys()],
        envelopeIds: this.envelopeIdsInEffect(),
        files: capture.files,
        truncated: capture.truncated,
        omittedPaths: capture.omittedPaths,
        bytesStored: capture.bytesStored,
      });
    } catch (e) {
      tracer.event({
        runId,
        // A phase with no queued row has no id to file the failure under; the
        // run-level event still records that a checkpoint was missed.
        phaseId: this.phaseIds.get(phase.name) ?? null,
        type: 'error',
        name: 'checkpoint',
        payload: { phase: phase.name, message: (e as Error).message },
      });
    }
  }

  /**
   * The envelope *row* behind each in-effect envelope, by phase name.
   *
   * `this.envelopes` is keyed by phase name and holds one parsed envelope per
   * completed phase, but `recordEnvelope` is a plain insert: a phase re-entered
   * through `feedbackTo` leaves several rows on the same `phase_id`, only the
   * last valid one of which is what the map holds. Naming that row is what lets
   * a reader tell which envelope a given generation actually ran against.
   */
  private envelopeIdsInEffect(): Record<string, string> {
    const byPhaseId = new Map<string, string>();
    for (const envelope of this.deps.tracer.envelopes(this.deps.runId)) {
      // Rows arrive in created_at order, so the last valid one wins.
      if (envelope.valid) byPhaseId.set(envelope.phaseId, envelope.envelopeId);
    }
    const out: Record<string, string> = {};
    for (const name of this.envelopes.keys()) {
      const envelopeId = byPhaseId.get(this.phaseIds.get(name) ?? '');
      if (envelopeId) out[name] = envelopeId;
    }
    return out;
  }

  /** The model this phase's agent will actually run on, resolved as the runner resolves it. */
  private appointedModel(phase: PhaseDef): string | null {
    if (phase.kind !== 'agent') return null;
    if (phase.model && phase.model !== 'inherit') return phase.model;
    const agent = this.agents.find((a) => a.name === phase.agent);
    if (!agent) return null;
    return resolveAgentExecution(agent, {
      model: this.deps.defaultModel,
      reasoningEffort: this.deps.defaultReasoningEffort ?? 'medium',
    }).model;
  }

  private persistedSessionId(agent: string | undefined): string | null {
    if (!agent) return null;
    const row = this.deps.tracer
      .agentSessions(this.deps.runId)
      .find((session) => session.agent === agent);
    return row?.agentSessionId ?? null;
  }

  private async runPhase(phase: PhaseDef): Promise<PhaseJump> {
    const runner = (this.runners as Partial<Record<PhaseKind, PhaseRunner>>)[phase.kind];
    // PhaseKind is a closed union, so a missing runner means a pipeline stored a
    // kind this build does not have. Keep failing loudly rather than skipping.
    if (!runner) return { kind: 'abort', detail: `unknown phase kind for "${phase.name}"` };
    try {
      return await runner.run(phase, this.ctx());
    } finally {
      // The note describes the attempt the operator killed, so it belongs to
      // this entry into the phase and no other. A later `feedbackTo` can send
      // the pipeline back here, and telling the agent it is recovering from an
      // interruption that it has meanwhile already redone would be false.
      // Retries and corrections live inside the call above, so they still see
      // it.
      this.recoveryNotes.delete(phase.name);
    }
  }

  private ctx(): RunContext {
    return {
      tracer: this.deps.tracer,
      runId: this.deps.runId,
      project: this.deps.project,
      pipeline: this.pipeline,
      request: this.deps.request,
      cwd: this.cwd,
      handoffDir: HANDOFF_DIR,
      branch: this.handle?.branch ?? null,
      baseRef: this.deps.project.baseRef,
      branchPointSha: this.handle?.branchPointSha ?? '',
      envelopes: this.envelopes,
      commandResults: this.commandResults,
      feedback: this.feedback,
      recoveryNotes: this.recoveryNotes,
      commandDrift: this.commandDrift,
      healing: this.deps.healing ?? null,
      cancelled: () => this.cancelled,
      onCancel: (abort) => this.onCancel(abort),
      phaseId: (name: string) => this.phaseId(name),
      recordPr: (input) => this.recordPr(input),
      recordIssue: (input) => this.recordIssue(input),
    };
  }

  private phaseEnvelope(phase: PhaseDef): string | undefined {
    return effectivePhaseEnvelope(phase, this.agents);
  }

  /**
   * Push `foundry/<runId>` from the project checkout (worktrees share that
   * git dir) and create or discover the branch PR. No fallbacks: missing
   * branch, remote, gh, or a refused push/create is the exact error.
   */
  private async recordPr(input: { title: string; body: string }): Promise<PrAction> {
    const branch = this.handle?.branch ?? null;
    if (!branch) {
      return { ok: false, detail: 'this run has no branch to open a PR from' };
    }
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title || !body) {
      return { ok: false, detail: 'the pr envelope is missing a title or body' };
    }
    return openPr(
      this.deps.project.path,
      {
        branch,
        baseRef: this.deps.project.baseRef,
        title,
        body,
      },
      this.deps.gh,
    );
  }

  /**
   * File a GitHub issue from the project checkout. No branch is needed — an
   * issue is repository metadata — so this also serves a non-isolated run.
   * No fallbacks: a missing gh or a refused create is the exact error.
   */
  private async recordIssue(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<IssueAction> {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title || !body) {
      return { ok: false, detail: 'the issue envelope is missing a title or body' };
    }
    return createIssue(this.deps.project.path, { title, body, labels: input.labels }, this.deps.gh);
  }

  private phaseId(name: string): string {
    const id = this.phaseIds.get(name);
    if (!id) throw new Error(`phase "${name}" was never queued`);
    return id;
  }

  private currentSetupExecution(): SetupExecution | null {
    if (this.setupExecution) return this.setupExecution;
    const setup = this.deps.tracer
      .eventsAfter(this.deps.runId, 0, 1000)
      .find((event) => event.type === 'tool_call' && event.name === 'setup');
    const command = setup?.payload.script;
    const exitCode = setup?.payload.exitCode;
    if (typeof command !== 'string' || (typeof exitCode !== 'number' && exitCode !== null)) {
      return null;
    }
    this.setupExecution = { command, exitCode };
    return this.setupExecution;
  }

  private async sessionFor(
    agent: AgentDef,
    modelOverride?: string,
    reasoningEffortOverride?: AgentDef['reasoningEffort'],
  ): Promise<AgentSession> {
    const resolved = resolveAgentExecution(agent, {
      model: this.deps.defaultModel,
      reasoningEffort: this.deps.defaultReasoningEffort ?? 'medium',
    });
    const model = modelOverride && modelOverride !== 'inherit' ? modelOverride : resolved.model;
    const reasoningEffort = reasoningEffortOverride ?? resolved.reasoningEffort;
    const existing = this.sessions.get(agent.name);
    if (existing?.model === model && existing.reasoningEffort === reasoningEffort) {
      return existing;
    }
    if (existing) {
      // The successor is a different session object, so it misses the ledger on
      // identity alone; dropping the old entries keeps that from being the only
      // thing standing between a replaced session and a wrong delta.
      this.prompts.forget(existing);
      await existing.close();
    }

    const effectiveAgent = {
      ...agent,
      model,
      reasoningEffort,
    };
    // A killed phase's agent starts a new conversation: the persisted row is
    // kept as evidence, it is simply not reopened. Consumed here so the ban
    // covers this one entry into the phase and nothing after it.
    const fresh = this.freshSessionAgents.delete(agent.name);
    const persistedSession = fresh
      ? undefined
      : this.deps.tracer
          .agentSessions(this.deps.runId)
          .find((row) => row.agent === agent.name && row.model === model);
    const session = new AgentSession(effectiveAgent, {
      runId: this.deps.runId,
      worktree: this.cwd,
      tracer: this.deps.tracer,
      protectedPaths: this.deps.project.protectedPaths,
      existingSessionId: persistedSession?.agentSessionId,
      transport: (req) => this.transportFor(req),
      ...(fresh ? { onOpened: (id) => this.noteRecoveredSession(agent.name, id) } : {}),
    });
    this.sessions.set(agent.name, session);
    return session;
  }

  /**
   * Completes the recovery event once the fresh session has an id.
   *
   * A session opens lazily, so the successor id only exists after the phase's
   * first turn. The event is patched rather than duplicated, so a reader sees
   * one row naming both the abandoned conversation and the one that replaced
   * it.
   *
   * Written up front and patched, rather than written once at open: `reopenRun`
   * overwrites the terminal status in place, so between the resume and the
   * first turn this event is the only record anywhere that the run had been
   * killed. Deferring it would mean a run killed again — or a crash — before
   * that turn leaves no trace of the first kill at all.
   *
   * The cost is that `events.jsonl` keeps the pre-patch line, since
   * `patchEvent` updates only the queryable mirror. That is how every streamed
   * row already behaves (assistant text, tool calls), so the JSONL is a
   * first-frame log rather than a settled one; SQLite is the read path for
   * both the renderer and Companion.
   */
  private noteRecoveredSession(agent: string, newSessionId: string | null): void {
    const pending = this.recovery;
    if (!pending || pending.agent !== agent) return;
    this.recovery = null;
    this.deps.tracer.patchEvent(pending.eventId, { newSessionId });
  }

  /**
   * The transport every agent session drives. Sessions files land in the run's
   * own trace directory, so a run's conversation is one of its artifacts and
   * the user's own agent install is never written to.
   */
  private transportFor(req: TransportRequest): AgentTransport {
    if (this.deps.transport) return this.deps.transport(req);
    return lazyTransport(async () => {
      const { PiTransport } = await import('../pi/pi-transport.js');
      return new PiTransport({
        cwd: req.cwd,
        runId: req.runId,
        model: req.agent.model,
        reasoningEffort: req.agent.reasoningEffort,
        ...(req.agent.toolProfile ? { toolProfile: req.agent.toolProfile } : {}),
        supportDir: this.deps.supportDir,
        sessionDir: join(this.deps.tracer.runDir(req.runId), 'sessions'),
        hiddenModelIds: this.deps.hiddenModelIds,
        onPermission: req.onPermission,
        onEvent: req.onEvent,
        onModelWarning: req.onModelWarning,
        tools: {
          runId: req.runId,
          agentName: req.agent.name,
          phaseId: req.phaseId,
          envelopes: () => this.envelopes,
          tracer: this.deps.tracer,
          // Resolved here, not by the agent: `git_diff` answers within the run's
          // own worktree and branch point, and a model-supplied ref would be a
          // way to read outside it. Read per call because a repair can move the
          // branch point under a session that is already open.
          diff: () => ({ cwd: this.cwd, branchPointSha: this.handle?.branchPointSha ?? '' }),
        },
      });
    });
  }

  /**
   * Compacts every session that has filled past the threshold. A session that
   * cannot report its occupancy (one-shot has none) is left alone, and a
   * compaction that fails is not an error the run answers for: the next turn
   * hits the same context wall it would have hit without this.
   */
  private async compactFullSessions(): Promise<void> {
    const threshold = this.deps.compactionThreshold;
    for (const session of this.sessions.values()) {
      const stats = await session.contextStats();
      if (!stats?.limit) continue;
      if (stats.used / stats.limit < threshold) continue;
      // A summarised conversation may no longer carry an earlier phase's
      // prompt verbatim, and a compaction that refused still consumed the
      // decision — forget either way and let the next entry render in full.
      this.prompts.forget(session);
      await session.compact(stats);
    }
  }

  private async settleKilled(): Promise<RunOutcome> {
    await this.closeSessions();
    return this.finish('killed', KILLED_DETAIL);
  }

  private async closeSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
        this.prompts.forget(session);
        await session.close();
      } catch {
        // A session that will not close cleanly must not block the outcome.
      }
    }
  }

  /**
   * Status, notification, and the exit banner settle here together, so they
   * cannot disagree about what happened.
   */
  private async finish(status: RunStatus, detail: string): Promise<RunOutcome> {
    const { tracer, runId, project } = this.deps;
    tracer.finishRun(runId, status, detail);
    await this.advanceSource(status === 'accepted' ? 'completed' : 'failed');

    let settleDetail = detail;
    const handle = this.handle;
    if (handle) {
      void worktreeLib
        .settle({
          repo: project.path,
          handle,
          accepted: status === 'accepted',
          policy: project.mergePolicy,
        })
        .then((outcome) => {
          if (outcome.merged) {
            const live = this.deps.landing?.currentProject() ?? project;
            recordLanding({ project: live, tracer }, runId, handle.branch, this.deps.landing);
          }
          tracer.event({
            runId,
            type: 'log',
            name: 'worktree',
            payload: { detail: outcome.detail, merged: outcome.merged, removed: outcome.removed },
          });
          if (outcome.merged) this.deps.landing?.notifyRuns();
        })
        .catch((e: Error) => {
          tracer.event({ runId, type: 'error', name: 'worktree', payload: { message: e.message } });
        });
      if (status === 'accepted' && project.mergePolicy === 'auto') {
        settleDetail = `${detail} (merging)`;
      }
    }

    this.deps.onRunFinished?.(status);
    return {
      runId,
      status,
      worktreePath: this.handle?.path ?? null,
      branch: this.handle?.branch ?? null,
      merged: false,
      detail: settleDetail,
    };
  }

  private async advanceSource(stage: RunSourceStage): Promise<void> {
    await this.deps.sourceLifecycle?.advance(stage);
  }
}

function uniqueIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.level}|${issue.where}|${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
