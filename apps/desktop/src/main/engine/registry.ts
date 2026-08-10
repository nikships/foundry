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
import type { ContextBreakdownResult } from '@shared/ipc-contract.js';
import { openDb, projectDbPath, projectRunsDir } from '../trace/db.js';
import { Tracer } from '../trace/tracer.js';
import { Executor } from './executor.js';
import { commandMatches, isAlive, killRun } from '../system/procs.js';
import { breakdownFile, type CapturedBreakdown, type InterruptRequest } from '../droid/agent.js';

export interface RegistryDeps {
  appSupportDir: string;
  settings: () => AppSettings;
  engineerName: string;
  onRunFinished: (run: RunRow) => void;
  onInterruptsChanged: () => void;
  onRunsChanged: () => void;
}

interface LiveRun {
  runId: string;
  projectId: string;
  executor: Executor;
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
    return {
      breakdown: null,
      reason: answer.mode === 'oneshot' ? 'no_session_context' : 'unanswered',
    };
  }

  start(input: {
    project: ProjectDef;
    pipeline: PipelineDef;
    agents: AgentDef[];
    envelopeDefs: EnvelopeDef[];
    request: string;
  }): string {
    const settings = this.deps.settings();
    const runId = `run_${new Date().toISOString().slice(2, 10).replace(/-/g, '')}_${randomBytes(3).toString('hex')}`;
    const tracer = this.tracerFor(input.project);

    const executor = new Executor({
      tracer,
      clis: settings.clis,
      defaultModel: settings.defaultModel,
      turnTimeoutMs: settings.turnTimeoutMs,
      envelopeRetries: settings.envelopeRetries,
      gateRetries: settings.gateRetries,
      compactionThreshold: settings.compactionThreshold,
      agents: input.agents,
      envelopeDefs: input.envelopeDefs,
      project: input.project,
      pipeline: input.pipeline,
      request: input.request,
      runId,
      engineer: this.deps.engineerName,
      askHuman: (req) => this.raiseInterrupt(req),
      onLiveText: (phaseId, text) => this.appendLiveText(phaseId, text),
    });

    this.live.set(runId, { runId, projectId: input.project.id, executor });
    this.deps.onRunsChanged();

    void executor
      .run()
      .then((outcome) => this.settleRun(input.project, runId, outcome.status))
      .catch((e: Error) => {
        tracer.event({ runId, type: 'error', name: 'engine', payload: { message: e.message } });
        this.settleRun(input.project, runId, 'failed');
      });

    return runId;
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

  closeAll(): void {
    for (const entry of this.live.values()) entry.executor.cancel();
  }
}
