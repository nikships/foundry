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

import { mkdirSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type {
  AgentDef,
  AutonomyLevel,
  CliConfig,
  CliVendor,
  CommandResult,
  PhaseDef,
  PipelineDef,
  ProjectDef,
  RunStatus,
} from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import { AgentSession, type InterruptRequest, type Mode } from '../droid/agent.js';
import { BUILTIN_ARGV, runCommand } from './commands.js';
import * as boundary from './boundary.js';
import { correctionMessage, feedbackEnvelope, parseEnvelope, type Envelope } from './envelopes.js';
import { gateCorrection, runGates, violationsOf, type GateReport } from './gates.js';
import { changedPaths } from './git.js';
import { combineForTurn, renderPrompt, resolveEnvelopeRef, type RenderContext } from './prompts.js';
import * as worktreeLib from './worktree.js';

export interface ExecutorDeps {
  tracer: Tracer;
  /** Where each CLI lives and how it is invoked. Agents name the vendor. */
  clis: Record<CliVendor, CliConfig>;
  autonomy: AutonomyLevel;
  turnTimeoutMs: number;
  envelopeRetries: number;
  gateRetries: number;
  agents: AgentDef[];
  project: ProjectDef;
  pipeline: PipelineDef;
  request: string;
  runId: string;
  engineer: string;
  /** Raises the interrupt sheet and resolves with what the human chose. */
  askHuman: (
    req: InterruptRequest,
  ) => Promise<{ approve: boolean; text?: string; remember?: boolean }>;
  onLiveText?: (phaseId: string, text: string) => void;
  onCommandRemembered?: (command: string) => void;
  onRunFinished?: (status: RunStatus) => void;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  worktreePath: string | null;
  branch: string | null;
  merged: boolean;
  detail: string;
}

type PhaseJump =
  { kind: 'next' } | { kind: 'goto'; phase: string } | { kind: 'abort'; detail: string };

type CommandResolution =
  | { ok: true; argv: string[]; skip?: false }
  | { ok: true; skip: true; argv: string[]; detail: string }
  | { ok: false; detail: string };

const HANDOFF_DIR = '.foundry-handoff';

export class Executor {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly envelopes = new Map<string, Envelope>();
  private readonly commandResults = new Map<string, CommandResult>();
  private readonly phaseIds = new Map<string, string>();
  private readonly feedbackUsed = new Map<string, number>();
  private readonly feedback = new Map<string, string>();
  private cancelled = false;
  private handle: worktreeLib.WorktreeHandle | null = null;
  private cwd: string;
  private mode: Mode = 'rpc';

  constructor(private readonly deps: ExecutorDeps) {
    this.cwd = deps.project.path;
  }

  get runId(): string {
    return this.deps.runId;
  }

  cancel(): void {
    this.cancelled = true;
    for (const session of this.sessions.values()) session.kill();
  }

  async run(): Promise<RunOutcome> {
    const { tracer, pipeline, project, runId } = this.deps;
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
        });
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
    });

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

    let index = 0;
    let guard = 0;
    const maxSteps = pipeline.phases.length + 32;
    let detail = '';

    while (index < pipeline.phases.length) {
      if (this.cancelled) {
        await this.closeSessions();
        return this.finish('killed', 'the run was killed');
      }
      if (guard++ > maxSteps) {
        detail = 'the pipeline exceeded its step budget: a feedback loop is not converging';
        tracer.event({ runId, type: 'error', name: 'loop guard', payload: { detail } });
        break;
      }

      const phase = pipeline.phases[index]!;
      const jump = await this.runPhase(phase);
      if (jump.kind === 'abort') {
        detail = jump.detail;
        break;
      }
      if (jump.kind === 'goto') {
        index = pipeline.phases.findIndex((p) => p.name === jump.phase);
        if (index < 0) {
          detail = `feedback target "${jump.phase}" vanished`;
          break;
        }
        continue;
      }
      index++;
    }

    await this.closeSessions();
    const verdict = this.isAccepted();
    // An abort detail explains why the pipeline stopped early; otherwise the
    // acceptance criterion explains itself.
    return this.finish(
      verdict.accepted ? 'accepted' : 'rejected',
      detail ? `${detail} (${verdict.reason})` : verdict.reason,
    );
  }

  private async runPhase(phase: PhaseDef): Promise<PhaseJump> {
    switch (phase.kind) {
      case 'agent':
        return this.runAgentPhase(phase);
      case 'code':
        return this.runCodePhase(phase);
      case 'engineer':
        return this.runEngineerPhase(phase);
      default:
        return { kind: 'abort', detail: `unknown phase kind for "${phase.name}"` };
    }
  }

  private phaseId(name: string): string {
    const id = this.phaseIds.get(name);
    if (!id) throw new Error(`phase "${name}" was never queued`);
    return id;
  }

  private async runAgentPhase(phase: PhaseDef): Promise<PhaseJump> {
    const { tracer, runId } = this.deps;
    const phaseId = this.phaseId(phase.name);
    tracer.beginQueuedPhase(phaseId);

    const agent = this.deps.agents.find((a) => a.name === phase.agent);
    if (!agent) {
      const detail = `no agent named "${phase.agent}" in the roster`;
      tracer.closePhase(phaseId, 'fail', detail);
      return { kind: 'abort', detail };
    }

    const session = this.sessionFor(agent);
    const envelopeKind = phase.envelope ?? agent.envelope;
    const before = await boundary.snapshot(this.cwd);
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

    let prompt = combineForTurn(renderPrompt(agent, phase, this.renderContext(phase)));
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
      );
      if (!parsed.ok) {
        lastError = parsed.detail;
        tracer.closePhase(phaseId, 'fail', lastError);
        return { kind: 'abort', detail: lastError };
      }
      envelope = parsed.envelope;

      const enforcement = await boundary.enforce({
        cwd: this.cwd,
        before,
        writes: agent.writes,
        projectProtected: this.deps.project.protectedPaths,
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

      const reports = await this.runPhaseGates(phase, envelope, phaseId, gateAttempt);
      const violations = violationsOf(reports);
      if (!violations.length) {
        this.envelopes.set(phase.name, envelope);
        if (envelope.status === 'fail') {
          lastError = `the agent reported failure: ${envelope.summary}`;
          tracer.closePhase(phaseId, 'fail', lastError);
          return { kind: 'abort', detail: lastError };
        }
        this.writeHandoff(phase.name, envelope);
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
  ): Promise<{ ok: true; envelope: Envelope } | { ok: false; detail: string }> {
    const { tracer, runId } = this.deps;
    let prompt = firstPrompt;

    for (let attempt = 1; attempt <= this.deps.envelopeRetries + 1; attempt++) {
      if (this.cancelled) return { ok: false, detail: 'the run was killed' };

      let outcome;
      try {
        outcome = await session.send(prompt, {
          phaseId,
          onText: (text) => this.deps.onLiveText?.(phaseId, text),
        });
      } catch (e) {
        tracer.event({
          runId,
          phaseId,
          type: 'error',
          name: `${agent.name}: turn failed`,
          payload: { message: (e as Error).message, attempt },
        });
        return { ok: false, detail: `the agent turn failed: ${(e as Error).message}` };
      }

      if (session.currentMode !== this.mode) {
        this.mode = session.currentMode;
        tracer.setRunMode(runId, this.mode);
      }

      const usageEventId = tracer.recordUsage(runId, phaseId, agent.name, outcome.usage);
      tracer.appendRunFile(
        runId,
        `${agent.name}/raw.jsonl`,
        `${JSON.stringify({ phase: phase.name, gateAttempt, attempt, reason: outcome.reason, text: outcome.text })}\n`,
      );

      const parsed = parseEnvelope(outcome.text, envelopeKind, agent.customFields);
      tracer.recordEnvelope({
        runId,
        phaseId,
        agent: agent.name,
        schemaKind: envelopeKind,
        payload: parsed.envelope ?? { raw: outcome.text.slice(0, 4000) },
        valid: parsed.ok,
        attempt,
      });
      tracer.writeRunFile(
        runId,
        `envelope-${phase.name}-${gateAttempt}-${attempt}.json`,
        JSON.stringify(parsed.envelope ?? { raw: outcome.text }, null, 2),
      );

      if (parsed.ok && parsed.envelope) {
        tracer.endEvent(usageEventId, {
          status: parsed.envelope.status,
          summary: parsed.envelope.summary,
        });
        return { ok: true, envelope: parsed.envelope };
      }

      const problem = parsed.problem ?? 'the envelope did not validate';
      tracer.event({
        runId,
        phaseId,
        type: 'correction',
        name: 'envelope did not parse',
        payload: { attempt, problem },
      });
      prompt = correctionMessage(problem, envelopeKind, agent.customFields);
    }

    return {
      ok: false,
      detail: `the agent did not produce a valid ${envelopeKind} envelope in ${this.deps.envelopeRetries + 1} attempts`,
    };
  }

  private async runPhaseGates(
    phase: PhaseDef,
    envelope: Envelope,
    phaseId: string,
    attempt: number,
  ): Promise<GateReport[]> {
    const specs = phase.gates ?? [];
    if (!specs.length) return [];

    const reports = await runGates(specs, envelope, {
      cwd: this.cwd,
      changedPaths: await changedPaths(this.cwd),
    });
    for (const report of reports) {
      this.deps.tracer.recordGate({
        runId: this.deps.runId,
        phaseId,
        attempt,
        gate: report.gate,
        passed: report.passed,
        checks: report.checks,
      });
    }
    return reports;
  }

  private async runCodePhase(phase: PhaseDef): Promise<PhaseJump> {
    const { tracer, runId } = this.deps;
    const phaseId = this.phaseId(phase.name);
    tracer.beginQueuedPhase(phaseId);

    const resolved = this.resolveCommand(phase);
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
      payload: { argv: resolved.argv, cwd: this.cwd },
    });
    const result = await runCommand({
      argv: resolved.argv,
      cwd: this.cwd,
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
    this.commandResults.set(phase.name, result);
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
        this.feedback.set(phase.feedbackTo, `${fb.summary}\n\n${fb.notes_for_next_agent}`);
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

  private resolveCommand(phase: PhaseDef): CommandResolution {
    const spec = phase.command;
    if (!spec) return { ok: false, detail: `code phase "${phase.name}" has no command` };
    if ('argv' in spec) return { ok: true, argv: spec.argv };

    if ('ref' in spec) {
      const command = this.deps.project.commands.find((c) => c.name === spec.ref);
      if (!command) {
        return {
          ok: false,
          detail: `project command "${spec.ref}" is not configured — set it in Settings → Project`,
        };
      }
      return { ok: true, argv: command.argv };
    }

    const builder = BUILTIN_ARGV[spec.builtin];
    if (!builder) return { ok: false, detail: `unknown builtin "${spec.builtin}"` };

    if (spec.builtin === 'git_commit') {
      const message = spec.messageFrom
        ? (resolveEnvelopeRef(spec.messageFrom, this.envelopes) ?? '')
        : '';
      return { ok: true, argv: this.gitCommitArgv(message) };
    }
    return { ok: true, argv: builder({}) };
  }

  /** `git commit` fails on an empty index, so staging is part of the phase. */
  private gitCommitArgv(message: string): string[] {
    const subject = message.split('\n')[0]?.trim() || 'foundry: run changes';
    return [
      'sh',
      '-c',
      `git add -A && git diff --cached --quiet || git commit -m ${shellQuote(subject)}`,
    ];
  }

  private async runEngineerPhase(phase: PhaseDef): Promise<PhaseJump> {
    const { tracer, runId } = this.deps;
    const phaseId = this.phaseId(phase.name);
    tracer.beginQueuedPhase(phaseId);

    const eventId = tracer.event({
      runId,
      phaseId,
      type: 'interrupt',
      name: phase.name,
      payload: { question: phase.question ?? phase.description },
    });
    const answer = await this.deps.askHuman({
      runId,
      phaseId,
      kind: 'engineer',
      title: phase.name,
      body: phase.question ?? phase.description,
    });
    tracer.endEvent(eventId, {
      decision: answer.approve ? 'approve' : 'reject',
      text: answer.text ?? '',
    });

    if (!answer.approve) {
      tracer.closePhase(phaseId, 'fail', 'the engineer rejected this phase');
      return { kind: 'abort', detail: 'the engineer rejected this phase' };
    }

    const notes = answer.text?.trim();
    if (notes) {
      // Edited text becomes an envelope so later phases can read it the same
      // way they read an agent's answer.
      this.envelopes.set(phase.name, {
        status: 'success',
        summary: notes.slice(0, 400),
        artifacts: [],
        notes_for_next_agent: notes,
      });
    }

    tracer.closePhase(phaseId, 'success');
    return { kind: 'next' };
  }

  private sessionFor(agent: AgentDef): AgentSession {
    const existing = this.sessions.get(agent.name);
    if (existing) return existing;

    const vendor = agent.cli ?? 'droid';
    const cli = this.deps.clis[vendor] ?? this.deps.clis.droid;
    const session = new AgentSession(agent, {
      cliPath: cli.path,
      cliExtraArgs: cli.extraArgs,
      runId: this.deps.runId,
      worktree: this.cwd,
      autonomy: this.deps.autonomy,
      turnTimeoutMs: this.deps.turnTimeoutMs,
      tracer: this.deps.tracer,
      policy: {
        protectedPaths: this.deps.project.protectedPaths,
        allowedCommands: this.deps.project.allowedCommands,
      },
      askHuman: async (req) => {
        const answer = await this.deps.askHuman(req);
        return { approve: answer.approve, remember: answer.remember };
      },
      onModeChange: (mode) => {
        this.mode = mode;
        this.deps.tracer.setRunMode(this.deps.runId, mode);
      },
      onCommandRemembered: (command) => this.deps.onCommandRemembered?.(command),
    });
    this.sessions.set(agent.name, session);
    return session;
  }

  private renderContext(phase: PhaseDef): RenderContext {
    return {
      request: this.deps.request,
      runId: this.deps.runId,
      worktree: this.cwd,
      handoffDir: join(this.cwd, HANDOFF_DIR),
      handoffFiles: this.handoffFiles(),
      envelopes: this.envelopes,
      feedback: this.feedback.get(phase.name),
    };
  }

  private handoffFiles(): string[] {
    try {
      return readdirSync(join(this.cwd, HANDOFF_DIR)).map((f) => join(HANDOFF_DIR, f));
    } catch {
      return [];
    }
  }

  private writeHandoff(phaseName: string, envelope: Envelope): void {
    this.deps.tracer.writeRunFile(
      this.deps.runId,
      `handoff/${phaseName}.json`,
      JSON.stringify(envelope, null, 2),
    );
    this.deps.tracer.event({
      runId: this.deps.runId,
      phaseId: this.phaseIds.get(phaseName) ?? null,
      type: 'handoff',
      name: phaseName,
      payload: { artifacts: envelope.artifacts, summary: envelope.summary },
    });
  }

  /**
   * Acceptance is the pipeline's own declared criterion, never a vibe. The
   * reason travels with the verdict so the banner can say what was checked
   * rather than restating the status it already shows.
   */
  private isAccepted(): { accepted: boolean; reason: string } {
    const { pipeline, tracer, runId } = this.deps;
    const phases = tracer.phases(runId);
    const acceptance = pipeline.acceptance;

    switch (acceptance.kind) {
      case 'all_phases_pass': {
        const bad = phases.filter((p) => p.status !== 'success' && p.status !== 'skipped');
        return bad.length
          ? {
              accepted: false,
              reason: `every phase had to pass; ${bad.map((p) => `${p.name} is ${p.status}`).join(', ')}`,
            }
          : { accepted: true, reason: `all ${phases.length} phases passed` };
      }

      case 'last_phase_pass': {
        const last = phases[phases.length - 1];
        if (!last) return { accepted: false, reason: 'the pipeline ran no phases' };
        return last.status === 'success'
          ? { accepted: true, reason: `the final phase "${last.name}" passed` }
          : { accepted: false, reason: `the final phase "${last.name}" is ${last.status}` };
      }

      case 'phase_flag': {
        const phase = phases.find((p) => p.name === acceptance.phase);
        if (!phase) {
          return { accepted: false, reason: `phase "${acceptance.phase}" never ran` };
        }
        if (phase.status !== 'success') {
          return { accepted: false, reason: `phase "${phase.name}" is ${phase.status}` };
        }
        if (acceptance.flag === 'passed') {
          const result = this.commandResults.get(acceptance.phase);
          if (!result) return { accepted: true, reason: `phase "${phase.name}" passed` };
          return result.passed
            ? { accepted: true, reason: `"${phase.name}" exited 0` }
            : {
                accepted: false,
                reason: `"${phase.name}" exited ${result.exitCode ?? 'abnormally'}`,
              };
        }
        const envelope = this.envelopes.get(acceptance.phase);
        return envelope?.approved === true
          ? { accepted: true, reason: `"${phase.name}" approved the work` }
          : {
              accepted: false,
              // The distinction that matters: the phase ran fine, the verdict was no.
              reason: `"${phase.name}" ran but did not approve the work`,
            };
      }

      case 'envelope_status': {
        const phase = phases.find((p) => p.name === acceptance.phase);
        if (!phase || phase.status !== 'success') {
          return {
            accepted: false,
            reason: `phase "${acceptance.phase}" is ${phase?.status ?? 'missing'}`,
          };
        }
        const envelope = this.envelopes.get(acceptance.phase);
        return envelope?.status === 'success'
          ? { accepted: true, reason: `"${phase.name}" reported success` }
          : {
              accepted: false,
              reason: `"${phase.name}" reported ${String(envelope?.status ?? 'nothing')}`,
            };
      }

      default:
        return { accepted: false, reason: 'the pipeline has no acceptance criterion' };
    }
  }

  private async closeSessions(): Promise<void> {
    for (const session of this.sessions.values()) {
      try {
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
  private finish(status: RunStatus, detail: string): RunOutcome {
    const { tracer, runId, project } = this.deps;
    tracer.finishRun(runId, status, detail);

    let settleDetail = detail;
    if (this.handle) {
      void worktreeLib
        .settle({
          repo: project.path,
          handle: this.handle,
          accepted: status === 'accepted',
          policy: project.mergePolicy,
        })
        .then((outcome) => {
          if (outcome.merged) tracer.setMerged(runId, true);
          tracer.event({
            runId,
            type: 'log',
            name: 'worktree',
            payload: { detail: outcome.detail, merged: outcome.merged, removed: outcome.removed },
          });
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
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function relativeToWorktree(worktree: string, path: string): string {
  const rel = relative(worktree, path);
  return rel.startsWith('..') ? path : rel;
}
