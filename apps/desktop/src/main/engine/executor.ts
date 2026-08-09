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
  AutonomyLevel,
  CliConfig,
  CliVendor,
  CommandResult,
  PhaseDef,
  PhaseKind,
  PipelineDef,
  ProjectDef,
  RunStatus,
} from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import { AgentSession, type InterruptRequest, type Mode } from '../droid/agent.js';
import { decideAcceptance } from './acceptance.js';
import type { PhaseRunner, RunContext, PhaseJump } from './phase-context.js';
import { AgentPhaseRunner } from './runners/agent.js';
import { CodePhaseRunner } from './runners/code.js';
import { EngineerPhaseRunner } from './runners/engineer.js';
import * as worktreeLib from './worktree.js';
import type { Envelope } from './envelopes.js';

export interface ExecutorDeps {
  tracer: Tracer;
  /** Where each CLI lives and how it is invoked. Agents name the vendor. */
  clis: Record<CliVendor, CliConfig>;
  autonomy: AutonomyLevel;
  defaultModel?: string;
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

const HANDOFF_DIR = '.foundry-handoff';

export class Executor {
  private readonly sessions = new Map<string, AgentSession>();
  private readonly envelopes = new Map<string, Envelope>();
  private readonly commandResults = new Map<string, CommandResult>();
  private readonly phaseIds = new Map<string, string>();
  private readonly feedback = new Map<string, string>();
  private cancelled = false;
  private handle: worktreeLib.WorktreeHandle | null = null;
  private cwd: string;
  private mode: Mode = 'rpc';
  private readonly runners: Record<PhaseKind, PhaseRunner>;

  constructor(private readonly deps: ExecutorDeps) {
    this.cwd = deps.project.path;
    this.runners = {
      agent: new AgentPhaseRunner({
        agents: deps.agents,
        envelopeRetries: deps.envelopeRetries,
        sessionFor: (agent) => this.sessionFor(agent),
        onLiveText: deps.onLiveText,
        onModeObserved: (mode) => this.observeMode(mode),
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
      envelopes: this.envelopes,
      commandResults: this.commandResults,
      feedback: this.feedback,
      cancelled: () => this.cancelled,
      phaseId: (name: string) => this.phaseId(name),
      askHuman: (req) => this.deps.askHuman(req),
    };
  }

  private observeMode(mode: Mode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.deps.tracer.setRunMode(this.deps.runId, mode);
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
    const session = new AgentSession(effectiveAgent, {
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
