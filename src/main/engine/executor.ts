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

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentDef,
  CliConfig,
  CliVendor,
  CommandResult,
  ContextBreakdown,
  EnvelopeDef,
  PhaseDef,
  PhaseKind,
  PipelineDef,
  ProjectDef,
  RunStatus,
  UserMcpServer,
} from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import {
  AgentSession,
  KILLED_DETAIL,
  type InterruptRequest,
  type Mode,
  type OpenDaemonResult,
} from '../droid/agent.js';
import { decideAcceptance } from './acceptance.js';
import type { PhaseRunner, RunContext, PhaseJump } from './phase-context.js';
import { AgentPhaseRunner } from './runners/agent.js';
import { CodePhaseRunner } from './runners/code.js';
import { EngineerPhaseRunner } from './runners/engineer.js';
import * as worktreeLib from './worktree.js';
import type { Envelope } from './envelopes.js';
import type { CommandDriftRecord } from './detect.js';
import { runCommand } from './commands.js';
import { openPr, type GhOptions } from '../system/gh.js';
import type { PrAction } from '@shared/ipc-contract.js';
import { effectivePhaseEnvelope } from '@shared/types.js';

export interface ExecutorDeps {
  tracer: Tracer;
  /** Where each CLI lives and how it is invoked. Agents name the vendor. */
  clis: Record<CliVendor, CliConfig>;
  defaultModel?: string;
  turnTimeoutMs: number;
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
   * Preferred port for the app-owned droid daemon (37600–37699). DaemonManager
   * scans up within the band when this port is busy.
   */
  daemonPort: number;
  mcpServers: UserMcpServer[];
  agents: AgentDef[];
  /** Shared custom envelope library snapshotted at run start. */
  envelopeDefs: EnvelopeDef[];
  project: ProjectDef;
  pipeline: PipelineDef;
  request: string;
  runId: string;
  engineer: string;
  /** Raises an engineer phase's checkpoint and resolves with what was chosen. */
  askHuman: (req: InterruptRequest) => Promise<{ approve: boolean; text?: string }>;
  onLiveText?: (phaseId: string, text: string) => void;
  onRunFinished?: (status: RunStatus) => void;
  /** Test seam: the fake gh script stands in for the real binary. */
  gh?: GhOptions;
  /**
   * Test seam: supply the daemon's session facade instead of connecting to a
   * real `droid daemon`. Production leaves this unset — a real run has no other
   * transport, so there is nothing here to fall back to.
   */
  openDaemonSessions?: (agent: AgentDef) => Promise<OpenDaemonResult>;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  worktreePath: string | null;
  branch: string | null;
  merged: boolean;
  detail: string;
}

const HANDOFF_DIR = '.foundry-handoff';

export class Executor {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly envelopes = new Map<string, Envelope>();
  private readonly commandResults = new Map<string, CommandResult>();
  private readonly phaseIds = new Map<string, string>();
  private readonly feedback = new Map<string, string>();
  private readonly commandDrift = new Map<string, CommandDriftRecord>();
  private cancelled = false;
  /**
   * The host install as it looked when this run started. Snapshotted so an
   * operator installing a skill mid-run cannot widen what a running agent
   * reaches, and so every phase agrees on what had to be withheld.
   */
  private handle: worktreeLib.WorktreeHandle | null = null;
  private cwd: string;
  private mode: Mode;
  private readonly runners: Record<PhaseKind, PhaseRunner>;

  constructor(private readonly deps: ExecutorDeps) {
    this.cwd = deps.project.path;
    // Agent runs are daemon-only; the field stays so the run row keeps saying
    // which transport answered rather than leaving the reader to assume.
    this.mode = 'daemon';
    this.runners = {
      agent: new AgentPhaseRunner({
        agents: deps.agents,
        envelopeDefs: deps.envelopeDefs,
        envelopeRetries: deps.envelopeRetries,
        rewindAfterCorrections: deps.rewindAfterCorrections,
        sessionFor: (agent) => this.sessionFor(agent),
        onLiveText: deps.onLiveText,
      }),
      code: new CodePhaseRunner(),
      engineer: new EngineerPhaseRunner(),
    };
  }

  get runId(): string {
    return this.deps.runId;
  }

  cancel(): void {
    this.cancelled = true;
    for (const session of this.sessions.values()) session.kill();
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
        timeoutMs: 300_000,
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

    let index = 0;
    let guard = 0;
    const maxSteps = pipeline.phases.length + 32;
    let detail = '';

    while (index < pipeline.phases.length) {
      if (this.cancelled) return this.settleKilled();
      if (guard++ > maxSteps) {
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

      const phase = pipeline.phases[index]!;
      const jump = await this.runPhase(phase);
      if (jump.kind === 'abort') {
        // FOU-15: a PR phase that could not create/discover the PR is a hard
        // fail with the exact error. Do not let a prior acceptance flag
        // (e.g. production_check.approved) mark the run accepted.
        if (this.phaseEnvelope(phase) === 'pr') {
          await this.closeSessions();
          return this.finish('rejected', jump.detail);
        }
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

    // A kill is an operator verdict, not a phase outcome: whatever the pipeline
    // managed to finish first must not be run through acceptance, or a phase
    // that completed before the kill landed settles the run as accepted.
    if (this.cancelled) return this.settleKilled();

    await this.closeSessions();
    const verdict = decideAcceptance({
      acceptance: pipeline.acceptance,
      phases: tracer.phases(runId),
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

  private async runPhase(phase: PhaseDef): Promise<PhaseJump> {
    const runner = (this.runners as Partial<Record<PhaseKind, PhaseRunner>>)[phase.kind];
    // PhaseKind is a closed union, so a missing runner means a pipeline stored a
    // kind this build does not have. Keep failing loudly rather than skipping.
    if (!runner) return { kind: 'abort', detail: `unknown phase kind for "${phase.name}"` };
    return runner.run(phase, this.ctx());
  }

  private ctx(): RunContext {
    return {
      tracer: this.deps.tracer,
      runId: this.deps.runId,
      project: this.deps.project,
      pipeline: this.deps.pipeline,
      request: this.deps.request,
      cwd: this.cwd,
      handoffDir: HANDOFF_DIR,
      branch: this.handle?.branch ?? null,
      baseRef: this.deps.project.baseRef,
      envelopes: this.envelopes,
      commandResults: this.commandResults,
      feedback: this.feedback,
      commandDrift: this.commandDrift,
      cancelled: () => this.cancelled,
      phaseId: (name: string) => this.phaseId(name),
      askHuman: (req) => this.deps.askHuman(req),
      recordPr: (input) => this.recordPr(input),
    };
  }

  private phaseEnvelope(phase: PhaseDef): string | undefined {
    return effectivePhaseEnvelope(phase, this.deps.agents);
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

  private phaseId(name: string): string {
    const id = this.phaseIds.get(name);
    if (!id) throw new Error(`phase "${name}" was never queued`);
    return id;
  }

  private sessionFor(agent: AgentDef): AgentSession {
    const existing = this.sessions.get(agent.name);
    if (existing) return existing;

    const vendor = agent.cli ?? 'droid';
    const cli = this.deps.clis[vendor] ?? this.deps.clis.droid;
    const model =
      agent.model === 'inherit' && this.deps.defaultModel && this.deps.defaultModel !== 'inherit'
        ? this.deps.defaultModel
        : agent.model;
    const effectiveAgent = { ...agent, model };
    const openDaemonSessions = this.deps.openDaemonSessions;
    const session = new AgentSession(effectiveAgent, {
      cliPath: cli.path,
      cliExtraArgs: cli.extraArgs,
      runId: this.deps.runId,
      worktree: this.cwd,
      turnTimeoutMs: this.deps.turnTimeoutMs,
      tracer: this.deps.tracer,
      policy: { protectedPaths: this.deps.project.protectedPaths },
      envelopes: this.envelopes,
      daemonPort: this.deps.daemonPort,
      userMcpServers: this.deps.mcpServers.filter((s) => !s.disabled),
      ...(openDaemonSessions
        ? { openDaemonSessions: () => openDaemonSessions(effectiveAgent) }
        : {}),
    });
    this.sessions.set(agent.name, session);
    return session;
  }

  /**
   * Compacts every session that has filled past the threshold. A session that
   * cannot report its occupancy (one-shot has none) is left alone, and a
   * compaction that fails is not an error the run answers for: the next turn
   * hits the same context wall it would have hit without this.
   */
  private async compactFullSessions(threshold = this.deps.compactionThreshold): Promise<void> {
    const effective = threshold ?? 0.8;
    for (const session of this.sessions.values()) {
      const stats = await session.contextStats();
      if (!stats?.limit) continue;
      if (stats.used / stats.limit < effective) continue;
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
