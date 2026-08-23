/**
 * Owns the live runs: one tracer per project, the kill path, the interrupt
 * queue, and the relaunch sweep.
 *
 * The sweep is what keeps a crashed app from leaving runs reading `running`
 * forever: any `processes` row still open whose pid is gone (or whose pid was
 * recycled onto a different command) finalises its run to `failed`.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type {
  AgentDef,
  AppSettings,
  EnvelopeDef,
  InterruptAnswer,
  PendingInterrupt,
  PipelineDef,
  ProjectDef,
  RunRow,
  RunStatus,
} from '@shared/types.js';
import { FIXED_ENGINE_DEFAULTS } from '@shared/types.js';
import type { ContextBreakdownResult } from '@shared/ipc-contract.js';
import { appDbPath, appRunsDir, openDb, projectDbPath, projectRunsDir } from '../trace/db.js';
import { Tracer } from '../trace/tracer.js';
import { Executor } from './executor.js';
import { healingSupport } from './healing.js';
import { commandMatches, isAlive, killRun, terminate } from '../system/procs.js';
import type { BridgeTrace } from '../bridge/service.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import { breakdownFile, type CapturedBreakdown, type InterruptRequest } from '../pi/session.js';

export interface RegistryDeps {
  appSupportDir: string;
  settings: () => AppSettings;
  engineerName: string;
  onRunFinished: (run: RunRow) => void;
  onInterruptsChanged: () => void;
  onRunsChanged: () => void;
  /**
   * How a failing code phase opens its healing turn. Omitted means no healing:
   * a test-only harness that never wires a runtime gets the pre-healing
   * escalation path rather than a session it cannot open.
   */
  oneShot?: OneShotFactory;
  /** Live project row + save, so auto-merge can apply command drift. */
  projectById?: (id: string) => ProjectDef | null;
  saveProject?: (next: ProjectDef) => { ok: boolean };
  notifySettings?: () => void;
}

interface LiveRun {
  runId: string;
  projectId: string;
  executor: Executor;
}

interface ExecutorInput {
  project: ProjectDef;
  pipeline: PipelineDef;
  agents: AgentDef[];
  envelopeDefs: EnvelopeDef[];
  request: string;
}

interface PendingEntry {
  interrupt: PendingInterrupt;
  resolve: (answer: { approve: boolean; text?: string }) => void;
}

const LIVE_TAIL_LINES = 40;

const ENGINEER_OPTIONS: PendingInterrupt['options'] = [
  { id: 'approve', label: 'Approve', kind: 'approve' },
  { id: 'edit', label: 'Approve with notes', kind: 'edit' },
  { id: 'reject', label: 'Reject', kind: 'reject' },
];

function processStillAlive(pid: number, command: string): boolean {
  return isAlive(pid) && commandMatches(pid, command);
}

export class RunRegistry extends EventEmitter {
  private readonly tracers = new Map<string, Tracer>();
  private appTracerInstance: Tracer | null = null;
  private readonly live = new Map<string, LiveRun>();
  private readonly pending = new Map<string, PendingEntry>();
  /** Live agent text per phase: a ring buffer, deliberately not persisted. */
  private readonly liveText = new Map<string, string[]>();

  constructor(private readonly deps: RegistryDeps) {
    super();
  }

  tracerFor(project: ProjectDef): Tracer {
    let tracer = this.tracers.get(project.id);
    if (!tracer) {
      const db = openDb(projectDbPath(this.deps.appSupportDir, project.path));
      tracer = new Tracer(db, projectRunsDir(this.deps.appSupportDir, project.path));
      this.tracers.set(project.id, tracer);
    }
    return tracer;
  }

  /**
   * The app-scoped trace, opened on first use. A project may be removed while
   * its Bridge is still running, and a Bridge started before any project exists
   * has no per-project trace to be written to at all — so the row that outlives
   * every run lives in a store that outlives every project.
   */
  appTracer(): Tracer {
    if (!this.appTracerInstance) {
      const support = this.deps.appSupportDir;
      this.appTracerInstance = new Tracer(openDb(appDbPath(support)), appRunsDir(support));
    }
    return this.appTracerInstance;
  }

  /**
   * The app trace as the Bridge writes to it. A named seam rather than an
   * inline closure at the construction site, so the wiring a test exercises is
   * the wiring the app runs.
   */
  bridgeTrace(): BridgeTrace {
    const tracer = this.appTracer();
    return {
      record: (input) => tracer.recordProcess(input),
      close: (id) => tracer.endProcess(id),
    };
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }

  liveRunCount(): number {
    return this.live.size;
  }

  liveTail(phaseId: string): string {
    return (this.liveText.get(phaseId) ?? []).join('');
  }

  /**
   * What is filling one agent's context. A breakdown can only be read off a
   * live session, so a finished run answers from the snapshot each turn left
   * behind, and every remaining way of having nothing carries its own reason.
   */
  async contextBreakdown(
    project: ProjectDef,
    runId: string,
    agent: string,
  ): Promise<ContextBreakdownResult> {
    const entry = this.live.get(runId);
    const answer = entry ? await entry.executor.contextBreakdown(agent) : null;
    if (answer?.breakdown) return { breakdown: answer.breakdown, live: true };

    const captured = this.tracerFor(project).readRunJson<CapturedBreakdown>(
      runId,
      breakdownFile(agent),
    );
    if (captured?.breakdown) {
      return { breakdown: captured.breakdown, live: false, capturedAt: captured.capturedAt };
    }
    if (!entry) return { breakdown: null, reason: 'not_live' };
    if (!answer) return { breakdown: null, reason: 'not_started' };
    return { breakdown: null, reason: 'unanswered' };
  }

  start(input: ExecutorInput): string {
    const runId = `run_${new Date().toISOString().slice(2, 10).replace(/-/g, '')}_${randomBytes(3).toString('hex')}`;
    const tracer = this.tracerFor(input.project);
    const executor = this.executorFor(input, runId, tracer);

    this.launch(input.project, runId, tracer, executor, 'run');
    return runId;
  }

  resume(input: Omit<ExecutorInput, 'pipeline' | 'request'> & { runId: string }): {
    ok: boolean;
    detail: string;
  } {
    const tracer = this.tracerFor(input.project);
    const run = tracer.run(input.runId);
    if (!run) return { ok: false, detail: 'run not found' };
    if (this.live.has(input.runId) || run.status === 'running') {
      return { ok: false, detail: 'this run is already running' };
    }
    if (run.status !== 'rejected' && run.status !== 'failed') {
      return { ok: false, detail: 'only a rejected or failed run can be continued' };
    }
    if (run.merged) return { ok: false, detail: 'a merged run cannot be continued' };
    const failed = tracer.phases(input.runId).find((phase) => phase.status === 'fail');
    if (!failed) return { ok: false, detail: 'this run has no failed phase to continue' };
    if (run.worktreePath && !existsSync(run.worktreePath)) {
      return { ok: false, detail: 'this run’s worktree is no longer available' };
    }
    const pipeline = tracer.readRunJson<PipelineDef>(input.runId, 'pipeline.json');
    if (!pipeline?.phases?.length || pipeline.id !== run.pipelineId) {
      return { ok: false, detail: 'this run’s saved pipeline is no longer available' };
    }
    const request = tracer.readRunFile(input.runId, 'request.md') ?? run.request;
    const executor = this.executorFor({ ...input, pipeline, request }, input.runId, tracer);

    this.launch(input.project, input.runId, tracer, executor, 'resume');
    return { ok: true, detail: `Continuing from “${failed.name}”…` };
  }

  private executorFor(input: ExecutorInput, runId: string, tracer: Tracer): Executor {
    const settings = this.deps.settings();
    return new Executor({
      tracer,
      defaultModel: settings.defaultModel,
      defaultReasoningEffort: settings.defaultReasoningEffort,
      envelopeRetries: FIXED_ENGINE_DEFAULTS.envelopeRetries,
      gateRetries: FIXED_ENGINE_DEFAULTS.gateRetries,
      compactionThreshold: settings.compactionThreshold,
      rewindAfterCorrections: FIXED_ENGINE_DEFAULTS.rewindAfterCorrections,
      healing: this.deps.oneShot ? healingSupport(this.deps.oneShot, settings) : null,
      supportDir: this.deps.appSupportDir,
      agents: input.agents,
      envelopeDefs: input.envelopeDefs,
      project: input.project,
      pipeline: input.pipeline,
      request: input.request,
      runId,
      engineer: this.deps.engineerName,
      askHuman: (req) => this.raiseInterrupt(req),
      onLiveText: (phaseId, text) => this.appendLiveText(phaseId, text),
      landing: (() => {
        const { saveProject, notifySettings, projectById } = this.deps;
        if (!saveProject || !notifySettings) return undefined;
        return {
          currentProject: () => projectById?.(input.project.id) ?? input.project,
          saveProject,
          notifySettings,
          notifyRuns: () => this.deps.onRunsChanged(),
        };
      })(),
    });
  }

  private launch(
    project: ProjectDef,
    runId: string,
    tracer: Tracer,
    executor: Executor,
    action: 'run' | 'resume',
  ): void {
    this.live.set(runId, { runId, projectId: project.id, executor });
    this.deps.onRunsChanged();

    void executor[action]()
      .then((outcome) => this.settleRun(project, runId, outcome.status))
      .catch((e: Error) => {
        tracer.event({ runId, type: 'error', name: 'engine', payload: { message: e.message } });
        this.settleRun(project, runId, 'failed');
      });
  }

  private settleRun(project: ProjectDef, runId: string, status: RunStatus): void {
    this.live.delete(runId);
    const tracer = this.tracerFor(project);
    const current = tracer.run(runId);
    // finishRun already settled a terminal status; only a crash path needs this.
    const run = current && current.status === 'running' ? tracer.finishRun(runId, status) : current;

    for (const [id, entry] of this.pending) {
      if (entry.interrupt.runId !== runId) continue;
      entry.resolve({ approve: false });
      this.pending.delete(id);
    }

    for (const phase of tracer.phases(runId)) this.liveText.delete(phase.phaseId);

    this.deps.onInterruptsChanged();
    this.deps.onRunsChanged();
    if (run) this.deps.onRunFinished(run);
  }

  kill(project: ProjectDef, runId: string): boolean {
    const entry = this.live.get(runId);
    const tracer = this.tracerFor(project);
    killRun(runId);

    if (entry) {
      entry.executor.cancel();
      return true;
    }

    // Not live in this process: a leftover row from a previous launch.
    const run = tracer.run(runId);
    if (run && run.status === 'running') {
      tracer.finishRun(runId, 'killed');
      this.deps.onRunsChanged();
      return true;
    }
    return false;
  }

  private raiseInterrupt(req: InterruptRequest): Promise<{ approve: boolean; text?: string }> {
    const interruptId = `int_${randomBytes(5).toString('hex')}`;
    const interrupt: PendingInterrupt = {
      interruptId,
      runId: req.runId,
      phaseId: req.phaseId,
      kind: req.kind,
      title: req.title,
      body: req.body,
      options: ENGINEER_OPTIONS,
      createdAt: new Date().toISOString(),
    };
    return new Promise((resolve) => {
      this.pending.set(interruptId, { interrupt, resolve });
      this.deps.onInterruptsChanged();
      this.emit('needs-input', interrupt);
    });
  }

  interrupts(): PendingInterrupt[] {
    return [...this.pending.values()].map((e) => e.interrupt);
  }

  answer(answer: InterruptAnswer): boolean {
    const entry = this.pending.get(answer.interruptId);
    if (!entry) return false;
    this.pending.delete(answer.interruptId);
    entry.resolve({ approve: answer.decision === 'approve', text: answer.text });
    this.deps.onInterruptsChanged();
    return true;
  }

  private appendLiveText(phaseId: string, text: string): void {
    const buffer = this.liveText.get(phaseId) ?? [];
    buffer.push(text);
    while (buffer.length > LIVE_TAIL_LINES * 20) buffer.shift();
    this.liveText.set(phaseId, buffer);
  }

  /**
   * Relaunch sweep. A run whose engine process is gone can never finish, so it
   * is finalised to `failed` rather than left reading `running` forever.
   */
  sweep(projects: ProjectDef[]): { runsFinalised: string[] } {
    const finalised: string[] = [];

    for (const project of projects) {
      let tracer: Tracer;
      try {
        tracer = this.tracerFor(project);
      } catch {
        continue;
      }

      for (const proc of tracer.openProcesses()) {
        if (!processStillAlive(proc.pid, proc.command)) tracer.endProcess(proc.id);
      }

      for (const runId of tracer.activeRunIds()) {
        if (this.live.has(runId)) continue;
        const remaining = tracer
          .openProcesses(runId)
          .filter((p) => processStillAlive(p.pid, p.command));
        if (remaining.length) continue;

        tracer.event({
          runId,
          type: 'error',
          name: 'orphaned run',
          payload: { detail: 'the engine process is gone: finalised by the relaunch sweep' },
        });
        tracer.finishRun(runId, 'failed');
        finalised.push(runId);
      }
    }

    if (finalised.length) this.deps.onRunsChanged();
    return { runsFinalised: finalised };
  }

  /**
   * Relaunch sweep for the app-scoped trace, which today holds the Bridge.
   *
   * A crash leaves the child alive and still bound to its port, and the new
   * launch's `ensure()` would scan up onto a second one — two proxies serving
   * the same accounts, the older of them belonging to nothing. So a survivor
   * whose argv still matches is killed, not adopted: this process owns the
   * Bridge singleton and is about to start its own. A pid that is gone (or was
   * recycled onto another command) just has its row closed.
   *
   * Async because reclaiming means SIGTERM, then SIGKILL if it will not go, and
   * a row must stay open for a pid that survived both.
   */
  async sweepAppProcesses(): Promise<{ reclaimed: number[]; closed: number }> {
    let tracer: Tracer;
    try {
      tracer = this.appTracer();
    } catch {
      return { reclaimed: [], closed: 0 };
    }

    const reclaimed: number[] = [];
    let closed = 0;
    for (const proc of tracer.openProcesses()) {
      if (processStillAlive(proc.pid, proc.command)) {
        if (!(await terminate(proc.pid))) continue;
        reclaimed.push(proc.pid);
      }
      tracer.endProcess(proc.id);
      closed += 1;
    }
    return { reclaimed, closed };
  }

  closeAll(): void {
    for (const entry of this.live.values()) entry.executor.cancel();
  }
}
