import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';
import { agentPhase, buildAgent, codePhase, createHarness, pipe } from './executor-harness.js';

function start(replanning: boolean) {
  const h = createHarness();
  const pipeline = pipe([
    codePhase('proof', { argv: ['true'] }),
    agentPhase('build'),
    codePhase('after', { argv: ['true'] }),
  ]);
  pipeline.acceptance = { kind: 'phase_flag', phase: 'proof', flag: 'passed' };
  const scripted = new ScriptedAgent(['unused'], [], [], { stallOnTurns: [0] });
  const propose = vi.fn().mockResolvedValue(null);
  const deps: ExecutorDeps = {
    tracer: h.tracer,
    runId: 'run_interrupt',
    project: h.project,
    pipeline,
    agents: [buildAgent()],
    engineer: 'test',
    request: 'build',
    supportDir: h.support,
    envelopeDefs: [],
    envelopeRetries: 2,
    gateRetries: 2,
    compactionThreshold: 0.8,
    rewindAfterCorrections: 2,
    transport: (req) => scripted.transport(req),
    replanner: { propose },
    plan: replanning
      ? {
          planId: 'plan_interrupt',
          projectId: h.project.id,
          prompt: 'build',
          refinedRequest: 'build',
          rationale: 'test interruption',
          pipeline,
          agents: [],
          warnings: [],
          model: 'scripted',
          reasoningEffort: 'medium',
        }
      : null,
  };
  const executor = new Executor(deps);
  return { ...h, executor, scripted, propose, done: executor.run(), runId: deps.runId };
}

describe('operator phase interruption', () => {
  it.each([false, true])(
    'stops without acceptance or automatic recovery (replanning: %s)',
    async (replanning) => {
      const h = start(replanning);
      await vi.waitFor(() => expect(h.scripted.turnStarted).toBe(true));
      const phases = h.tracer.phases(h.runId);
      const phaseId = phases.find((phase) => phase.name === 'build')!.phaseId;
      expect(await h.executor.interruptPhase(phases[0]!.phaseId)).toBe(false);
      expect(await h.executor.interruptPhase(phaseId)).toBe(true);
      const outcome = await h.done;
      expect(h.propose).not.toHaveBeenCalled();
      expect(outcome.status).toBe('rejected');
      expect(outcome.detail).toContain('interrupted');
      expect(existsSync(outcome.worktreePath!)).toBe(true);
      expect(h.tracer.phases(h.runId).map((phase) => phase.status)).toEqual([
        'success',
        'fail',
        'queued',
      ]);
      expect(h.scripted.turnMarkers).toHaveLength(1);
      expect(await h.executor.interruptPhase(phaseId)).toBe(false);
    },
  );

  it('lets a simultaneous run cancellation outrank interruption', async () => {
    const h = start(true);
    await vi.waitFor(() => expect(h.scripted.turnStarted).toBe(true));
    const phaseId = h.tracer.phases(h.runId).find((phase) => phase.name === 'build')!.phaseId;
    const interrupted = h.executor.interruptPhase(phaseId);
    h.executor.cancel();
    await interrupted;
    expect((await h.done).status).toBe('killed');
    expect(h.propose).not.toHaveBeenCalled();
  });
});
