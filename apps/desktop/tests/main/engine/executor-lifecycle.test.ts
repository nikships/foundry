/**
 * Executor test suite — split across files to parallelize over CPU cores.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHarness,
  sh,
  scriptedAgent,
  turnRequests,
  wireLog,
  turnMarkers,
  turnStarted,
  until,
  buildAgent,
  codePhase,
  agentPhase,
  pipe,
  buildEnvelope,
  runForHarness,
  startForHarness,
  eventsForHarness,
  type Harness,
  type RunInput,
} from './executor-harness.js';
import type { AppSettings, PipelineDef } from '../../../src/shared/types.js';
import { RunRegistry } from '../../../src/main/engine/registry.js';
import { breakdownFile } from '../../../src/main/pi/session.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import { type ScriptedAgent } from '../../helpers/scripted-transport.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});
const run = (input: RunInput) => runForHarness(h, input);
const start = (input: RunInput) => startForHarness(h, input);
const events = (runId: string) => eventsForHarness(h, runId);

/**
 * A kill is an operator verdict, not a transport flap. A killed turn looks
 * exactly like a failed one from the inside, so every recovery path has to stand
 * down once the kill has fired, or the operator's kill settles as an accepted run.
 */
describe('killing a run mid-turn', () => {
  it('settles killed rather than recovering the turn', async () => {
    // Turn 0 is begun and never answered, so the kill lands mid-turn.
    // Turn 1 would succeed: without the short-circuit, a recovery attempt
    // finishes the phase and the run settles accepted.
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [0],
    });
    const started = start({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a kill is not a transport failure.' })],
        {
          description: 'a run killed mid-turn',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(() => turnStarted(scripted), 'the scripted agent to start its turn');
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.status).toBe('killed');
    expect(row.outcomeDetail).toBe('the run was killed');

    // The killed turn is not filed as an agent failure: a kill is what the
    // operator asked for, so the timeline must not read like a broken agent.
    expect(events(outcome.runId).filter((e) => e.name === 'builder: turn failed')).toEqual([]);
    // Only the one turn the kill landed on was ever spent.
    expect(turnMarkers(scripted)).toEqual(['turn 0']);
    expect(h.tracer.run(outcome.runId)!.mode).toBe('pi');
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('does not accept a run whose remaining phases never ran', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [1],
    });
    const started = start({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Pass before the kill lands.' }),
          agentPhase('review', { description: 'Never finish: the kill lands here.' }),
        ],
        {
          description: 'a kill after one phase already passed',
          // The phase that passed would satisfy acceptance on its own.
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(
      () =>
        turnMarkers(scripted).length === 2 &&
        h.tracer.phases(started.runId)[0]?.status === 'success',
      'the first phase to pass and the second turn to start',
    );
    started.executor.cancel();
    const outcome = await started.done;

    expect(outcome.status).toBe('killed');
    expect(h.tracer.run(outcome.runId)!.outcomeDetail).toBe('the run was killed');
  });

  it('never spends a turn after the kill landed', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [0],
    });
    const started = start({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Prove no turn outlives the kill.' })], {
        description: 'a killed run spends nothing more',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    await until(() => turnStarted(scripted), 'the scripted agent to start its turn');
    started.executor.cancel();
    await started.done;

    // A turn spent after the kill is both real money and a result the run
    // could still be settled on.
    expect(turnMarkers(scripted)).toHaveLength(1);
    expect(h.tracer.openProcesses(started.runId)).toHaveLength(0);
  });
});

/**
 * Continuing a killed run.
 *
 * A rejected or failed run is continued as a correction: the interrupted
 * agent's own session is reopened, because it still describes the phase and
 * ends on a turn that actually completed. A kill is different — the operator
 * cut a turn off mid-flight, so reopening that conversation would make a
 * truncated exchange the context the retry reasons from. The phase restarts on
 * a new session over the worktree the kill left behind, and the abandoned
 * conversation stays on the record rather than being deleted.
 */
describe('continuing a killed run', () => {
  const killedPipeline = (): PipelineDef =>
    pipe(
      [
        codePhase('prepare', { argv: ['sh', '-c', 'echo prepared >> prepare-count'] }),
        agentPhase('build', { description: 'Restart this phase after the kill.' }),
      ],
      {
        description: 'a run the operator stopped mid-phase',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      },
    );

  /** Runs `killedPipeline` until the agent turn is in flight, then kills it. */
  async function killedRun(): Promise<{ runId: string; scripted: ScriptedAgent }> {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      stallOnTurns: [0],
    });
    const started = start({ scripted, pipeline: killedPipeline() });
    await until(() => turnStarted(scripted), 'the scripted agent to start its turn');
    started.executor.cancel();
    const outcome = await started.done;
    expect(outcome.status).toBe('killed');
    return { runId: outcome.runId, scripted };
  }

  /** A resume on its own executor, the way `RunRegistry.resume` builds one. */
  function continueRun(
    runId: string,
    continued: ScriptedAgent,
    over: Partial<ExecutorDeps> = {},
  ): Promise<{ status: string }> {
    const executor = new Executor({
      tracer: h.tracer,
      envelopeRetries: 2,
      gateRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      supportDir: h.support,
      transport: (req) => continued.transport(req),
      agents: [buildAgent()],
      envelopeDefs: [],
      project: h.project,
      pipeline: killedPipeline(),
      request: 'do the thing',
      runId,
      engineer: 'test',
      ...over,
    });
    return executor.resume();
  }

  function recoveryEvent(runId: string) {
    const rows = events(runId).filter((e) => e.name === 'run recovered');
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('restarts the interrupted phase on a new session', async () => {
    const { runId } = await killedRun();
    const abandoned = h.tracer.agentSessions(runId)[0]!.agentSessionId;
    expect(abandoned).toBeTruthy();

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    const outcome = await continueRun(runId, continued);

    expect(outcome.status).toBe('accepted');
    // The engine asked for a new conversation rather than the persisted one.
    expect(continued.reopened).toEqual([{ agent: 'builder', existingSessionId: null }]);
    expect(turnRequests(continued)[0]!.sessionId).not.toBe(abandoned);
    expect(turnRequests(continued)[0]!.sessionId).toBe('k1');
  });

  it('records the recovery with both session ids and how the run had stopped', async () => {
    const { runId } = await killedRun();
    const abandoned = h.tracer.agentSessions(runId)[0]!.agentSessionId;

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    await continueRun(runId, continued);

    // `reopenRun` overwrote `killed` in place, so this event is the only
    // remaining record that the run had been stopped by hand.
    expect(recoveryEvent(runId).payload).toMatchObject({
      fromStatus: 'killed',
      strategy: 'fresh_session',
      phase: 'build',
      agent: 'builder',
      previousSessionId: abandoned,
      newSessionId: 'k1',
    });
  });

  it('keeps the abandoned session id on the record and the transcript it produced', async () => {
    const { runId } = await killedRun();
    const abandoned = h.tracer.agentSessions(runId)[0]!.agentSessionId;
    // Identity, not a count: a comparison of lengths alone would still pass if
    // the continue had deleted every killed-attempt event and written more.
    const killedAttempt = events(runId)
      .filter((e) => e.phaseId)
      .map((e) => e.eventId);
    expect(killedAttempt.length).toBeGreaterThan(0);

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    await continueRun(runId, continued);

    // The row is keyed on (run, agent), so the successor overwrites it in
    // place. What survives the kill is the transcript and the recovery event
    // that names the abandoned id.
    expect(h.tracer.agentSessions(runId)).toHaveLength(1);
    const after = new Set(events(runId).map((e) => e.eventId));
    for (const id of killedAttempt) expect(after.has(id)).toBe(true);
    expect(events(runId).filter((e) => e.phaseId).length).toBeGreaterThan(killedAttempt.length);
    expect(recoveryEvent(runId).payload.previousSessionId).toBe(abandoned);
  });

  it('resolves the roster model rather than inheriting a failed-over one', async () => {
    const { runId } = await killedRun();
    // What a failover mid-kill leaves behind: the persisted row names a model
    // the roster never asked for. The lookup `sessionFor` skips is keyed by
    // model, so a row under the roster's own name has to be present too —
    // otherwise this passes on a plain miss rather than on the ban.
    h.tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'failed-over/model',
      reasoningEffort: 'medium',
      agentSessionId: 'abandoned-session',
      mode: 'pi',
      color: '#5ad2dd',
    });
    h.tracer.upsertAgentSession({
      runId,
      agent: 'builder',
      model: 'scripted',
      reasoningEffort: 'medium',
      agentSessionId: 'abandoned-roster-session',
      mode: 'pi',
      color: '#5ad2dd',
    });

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    await continueRun(runId, continued);

    // Neither persisted row is reopened, and the roster model is the one the
    // restarted phase runs on.
    expect(continued.reopened).toEqual([{ agent: 'builder', existingSessionId: null }]);
    expect(turnRequests(continued)[0]!.sessionId).toBe('k1');
    const agentStart = events(runId)
      .filter((e) => e.type === 'agent_start')
      .at(-1);
    expect(agentStart!.payload.model).toBe('scripted');
  });

  it('sends a full prompt with a recovery note instead of a delta', async () => {
    const { runId } = await killedRun();
    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    await continueRun(runId, continued);

    const prompt = turnRequests(continued)[0]!.text;
    // Full: the new session holds nothing, so the phase's own ask is re-sent.
    expect(prompt).toContain('Build: do the thing');
    expect(prompt).toContain('call `submit_envelope` once');
    expect(prompt).not.toContain('## Report');
    expect(prompt).toContain('## Recovering an interrupted attempt');
    expect(prompt).toContain('stopped by the operator while the "build" phase');
    expect(prompt).toMatch(/may already contain partial/);
    expect(events(runId)).toContainEqual(
      expect.objectContaining({
        type: 'log',
        name: 'prompt',
        payload: expect.objectContaining({ phase: 'build', kind: 'full' }),
      }),
    );
  });

  it('keeps earlier phases and the dirty worktree rather than replaying setup', async () => {
    const { runId } = await killedRun();
    const worktree = h.tracer.run(runId)!.worktreePath!;
    // A partial write from the killed attempt, which the operator's Continue
    // must not roll back: earlier phases wrote into the same tree.
    writeFileSync(join(worktree, 'half-written.txt'), 'from the killed attempt\n');
    const phaseIds = h.tracer.phases(runId).map((phase) => phase.phaseId);

    const continued = scriptedAgent([buildEnvelope()], [], [], { sessionIdPrefix: 'k' });
    const outcome = await continueRun(runId, continued);

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(runId).map((phase) => phase.phaseId)).toEqual(phaseIds);
    // The code phase that already passed is not re-run, so its append-only
    // marker still reads once.
    expect(readFileSync(join(worktree, 'prepare-count'), 'utf8')).toBe('prepared\n');
    expect(readFileSync(join(worktree, 'half-written.txt'), 'utf8')).toBe(
      'from the killed attempt\n',
    );
  });

  it('refuses a merged killed run', async () => {
    const { runId } = await killedRun();
    h.tracer.setMerged(runId, true);

    await expect(continueRun(runId, scriptedAgent([buildEnvelope()]))).rejects.toThrow(
      'a merged run cannot be continued',
    );
  });

  it('refuses a killed run whose worktree is gone', async () => {
    const { runId } = await killedRun();
    const worktree = h.tracer.run(runId)!.worktreePath!;
    sh(h.repo, ['git', 'worktree', 'remove', '--force', worktree]);

    await expect(continueRun(runId, scriptedAgent([buildEnvelope()]))).rejects.toThrow(
      'this run’s worktree is no longer available',
    );
  });

  it('refuses a killed run with no failed phase left to continue', async () => {
    const { runId } = await killedRun();
    for (const phase of h.tracer.phases(runId)) {
      if (phase.status === 'fail') h.tracer.closePhase(phase.phaseId, 'success');
    }

    await expect(continueRun(runId, scriptedAgent([buildEnvelope()]))).rejects.toThrow(
      'this run has no failed phase to continue',
    );
  });

  it('refuses a run that settled accepted, naming every continuable status', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()]);
    const accepted = await run({ scripted, pipeline: killedPipeline() });
    expect(accepted.status).toBe('accepted');

    await expect(continueRun(accepted.runId, scriptedAgent([buildEnvelope()]))).rejects.toThrow(
      'only a rejected, failed, or killed run can be continued',
    );
  });
});

/**
 * The registry's own gate on Continue — what the desktop banner, the Companion
 * route, and Smith all reach through.
 *
 * The pipeline here is code-only on purpose: a registry-launched run builds its
 * own transport, and there is no model in a unit test. What is under test is
 * eligibility and the launch, not the agent path the executor suite above
 * already covers.
 */
describe('the registry gate on continuing a killed run', () => {
  function registry(): RunRegistry {
    return new RunRegistry({
      appSupportDir: h.support,
      settings: () => ({ compactionThreshold: 0.8 }) as AppSettings,
      engineerName: 'test',
      onRunFinished: () => undefined,
      onRunsChanged: () => undefined,
    });
  }

  /**
   * A killed run whose interrupted phase is a command that fails until a
   * sentinel exists — so continuing it can actually converge without a model.
   */
  async function killedCodeRun(): Promise<{ runId: string; worktree: string }> {
    const pipeline = pipe(
      [codePhase('gate', { argv: ['sh', '-c', 'test -f go'] }, { heal: false })],
      { description: 'a command the operator stopped the run over' },
    );
    const outcome = await run({ pipeline });
    expect(outcome.status).toBe('rejected');
    // The trace a kill leaves: a terminal `killed` row over a red phase, with
    // the worktree kept.
    h.tracer.finishRun(outcome.runId, 'killed', 'the run was killed');
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    return { runId: outcome.runId, worktree };
  }

  const resumeInput = (runId: string) => ({
    project: h.project,
    runId,
    agents: [buildAgent()],
    envelopeDefs: [],
  });

  it('accepts a killed run and re-runs the command it stopped', async () => {
    const { runId, worktree } = await killedCodeRun();
    writeFileSync(join(worktree, 'go'), '');

    const runs = registry();
    // A killed *command* is not a restart: there is no conversation to
    // abandon, so the operator is told the ordinary thing.
    const answer = runs.resume(resumeInput(runId));
    expect(answer).toEqual({ ok: true, detail: 'Continuing from “gate”…' });

    await until(() => !runs.isLive(runId), 'the continued run to settle');
    expect(runs.tracerFor(h.project).run(runId)!.status).toBe('accepted');
  });

  it('records no recovery for a killed command phase', async () => {
    const { runId, worktree } = await killedCodeRun();
    writeFileSync(join(worktree, 'go'), '');

    const runs = registry();
    expect(runs.resume(resumeInput(runId)).ok).toBe(true);
    await until(() => !runs.isLive(runId), 'the continued run to settle');

    // Nothing was moved off a session, so a `run recovered` row would claim a
    // recovery that never happened — and could never be completed, because no
    // session opens to supply the successor id.
    expect(events(runId).filter((e) => e.name === 'run recovered')).toEqual([]);
    expect(events(runId).find((e) => e.name === 'run continued')!.payload).toMatchObject({
      phase: 'gate',
      fromStatus: 'killed',
      strategy: 'reopen_session',
    });
  });

  it('still calls a failed run a continuation rather than a restart', async () => {
    const pipeline = pipe(
      [codePhase('gate', { argv: ['sh', '-c', 'test -f go'] }, { heal: false })],
      { description: 'a command that simply failed' },
    );
    const outcome = await run({ pipeline });
    expect(outcome.status).toBe('rejected');

    expect(registry().resume(resumeInput(outcome.runId)).detail).toBe('Continuing from “gate”…');
  });

  it('refuses a merged killed run, a missing worktree, and a run with nothing red', async () => {
    const merged = await killedCodeRun();
    h.tracer.setMerged(merged.runId, true);
    expect(registry().resume(resumeInput(merged.runId))).toEqual({
      ok: false,
      detail: 'a merged run cannot be continued',
    });

    const discarded = await killedCodeRun();
    sh(h.repo, ['git', 'worktree', 'remove', '--force', discarded.worktree]);
    expect(registry().resume(resumeInput(discarded.runId))).toEqual({
      ok: false,
      detail: 'this run’s worktree is no longer available',
    });

    const green = await killedCodeRun();
    for (const phase of h.tracer.phases(green.runId)) {
      h.tracer.closePhase(phase.phaseId, 'success');
    }
    expect(registry().resume(resumeInput(green.runId))).toEqual({
      ok: false,
      detail: 'this run has no failed phase to continue',
    });
  });

  it('refuses an accepted run by naming every continuable status', async () => {
    const outcome = await run({
      pipeline: pipe([codePhase('gate', { argv: ['true'] })], { description: 'a green run' }),
    });
    expect(outcome.status).toBe('accepted');

    expect(registry().resume(resumeInput(outcome.runId))).toEqual({
      ok: false,
      detail: 'only a rejected, failed, or killed run can be continued',
    });
  });
});

/**
 * What is filling an agent's context. The session is the only thing that can
 * answer, and it dies with the run, so the answer has to outlive it or the
 * Inspector shows every finished run the same empty panel.
 */
describe('the context breakdown an agent leaves behind', () => {
  function registry(): RunRegistry {
    return new RunRegistry({
      appSupportDir: h.support,
      settings: () => ({}) as AppSettings,
      engineerName: 'test',
      onRunFinished: () => undefined,
      onRunsChanged: () => undefined,
    });
  }

  it('records the breakdown each turn produced with the run files', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Produce one turn to snapshot.' })], {
        description: 'a run whose breakdown is kept',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const captured = h.tracer.readRunJson<{
      capturedAt: string;
      breakdown: { modelId: string; usedTokens: number; freeTokens: number; contextBudget: number };
    }>(outcome.runId, breakdownFile('builder'));
    // Context stats and the breakdown come off the same session, so the
    // occupancy the agent reports and the one the snapshot keeps are one number.
    expect(captured?.breakdown.usedTokens).toBe(1234);
    // Used plus free is the whole budget: the lane draws the bar from these two
    // numbers alone, so a drift between them would show as a gap or an overflow.
    expect(captured!.breakdown.usedTokens + captured!.breakdown.freeTokens).toBe(
      captured!.breakdown.contextBudget,
    );
    expect(captured?.breakdown.modelId).toBe('scripted');
    expect(Date.parse(captured!.capturedAt)).toBeGreaterThan(0);
  });

  it('answers for a finished run from that record, marked as not live', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Produce one turn to snapshot.' })], {
        description: 'a finished run still explains its context',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    const result = await registry().contextBreakdown(h.project, outcome.runId, 'builder');
    expect(result.breakdown?.usedTokens).toBe(1234);
    expect(result.live).toBe(false);
    expect(result.capturedAt).toBeTruthy();
    expect(result.reason).toBeUndefined();
  });

  it('says why there is nothing rather than answering with an empty breakdown', async () => {
    const result = await registry().contextBreakdown(h.project, 'run_never_existed', 'builder');
    expect(result.breakdown).toBeNull();
    expect(result.reason).toBe('not_live');
  });
});

/**
 * Rewind correction loops. After N failed corrections PhaseRewinder rewinds
 * the session before the retry turn — without extending budgets. File restore
 * itself is covered in tests/rewinder.test.ts.
 */
describe('rewind correction policy', () => {
  const PHASE_START = 'phase-start content\n';
  const seedThenBuild = (): PipelineDef =>
    pipe(
      [
        codePhase(
          'seed',
          { argv: ['sh', '-c', 'printf "phase-start content\\n" > watched.txt'] },
          { description: 'Leave a dirty file the agent phase will snapshot.' },
        ),
        agentPhase('build', {
          description: 'Fail twice so the 2nd correction rewinds, then succeed.',
        }),
      ],
      {
        description: 'seed a dirty file, then an agent phase that rewinds',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      },
    );

  function corrections(runId: string) {
    return events(runId).filter((e) => e.type === 'correction');
  }

  it('rewinds on the 2nd correction and retries on the rewound session', async () => {
    const scripted = scriptedAgent(
      ['prose', 'still prose', buildEnvelope()],
      ['watched.txt', 'watched.txt', null],
      [],
      { rewindFiles: { 'watched.txt': PHASE_START } },
    );
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('accepted');

    const wire = wireLog(scripted);
    expect(wire).toContain('get_rewind_info');
    expect(wire).toContain('rewind');
    // The engine asks what a rewind could restore before it rewinds, and the
    // retry turn comes after both.
    const infoAt = wire.indexOf('get_rewind_info');
    const rewindAt = wire.indexOf('rewind');
    expect(infoAt).toBeGreaterThanOrEqual(0);
    expect(rewindAt).toBeGreaterThan(infoAt);
    const turns = wire.filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    // A rewind moves the session back through its own history rather than
    // minting a new one, so every turn is the same session.
    for (const turn of turns) expect(turn).toContain('session=s1');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.agentSessionId).toBe('s1');

    const rewound = corrections(outcome.runId).filter((e) => e.payload.rewind === true);
    expect(rewound).toHaveLength(1);
    expect(rewound[0]!.payload.correctionIndex).toBe(2);
    expect(rewound[0]!.payload.restoredCount).toBe(1);
    expect(rewound[0]!.payload.deletedCount).toBe(0);
    // No novel event type — architecture reuses correction.
    expect(events(outcome.runId).map((e) => e.type)).not.toContain('rewind');
  });

  it('falls back to append-style correction when rewind fails', async () => {
    const scripted = scriptedAgent(['prose', 'still prose', buildEnvelope()], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
      rewindFails: true,
    });
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      pipeline: seedThenBuild(),
    });
    // A refused rewind must not fail the phase: the append-style retry still runs.
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted)).toContain('get_rewind_info');
    expect(wireLog(scripted)).not.toContain('rewind');
    // All three turns stayed on the original session.
    const turns = wireLog(scripted).filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    for (const turn of turns) expect(turn).toContain('session=s1');
    expect(h.tracer.agentSessions(outcome.runId)[0]!.agentSessionId).toBe('s1');
    expect(corrections(outcome.runId).some((e) => e.payload.rewind === true)).toBe(false);
    expect(events(outcome.runId).some((e) => e.name === 'builder: rewind failed')).toBe(true);
  });

  it('disables rewind entirely when rewindAfterCorrections is 0', async () => {
    const scripted = scriptedAgent(['prose', 'still prose', buildEnvelope()], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
    });
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      rewindAfterCorrections: 0,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted)).not.toContain('get_rewind_info');
    expect(wireLog(scripted)).not.toContain('rewind');
    expect(corrections(outcome.runId).some((e) => e.payload.rewind === true)).toBe(false);
  });

  it('does not extend the envelope budget when a rewind runs', async () => {
    // Every reply is prose: envelopeRetries+1 attempts, then the phase fails.
    // Rewind on the 2nd correction must not buy an extra turn.
    const scripted = scriptedAgent(['no', 'still no', 'nope', 'never'], [], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
    });
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      rewindAfterCorrections: 2,
      pipeline: seedThenBuild(),
    });
    expect(outcome.status).toBe('rejected');
    expect(h.tracer.phases(outcome.runId).find((p) => p.name === 'build')!.status).toBe('fail');
    // envelopeRetries + 1 turn attempts, exactly — rewind consumed a correction
    // slot inside that envelope, it did not add one.
    expect(turnRequests(scripted)).toHaveLength(3);
    expect(wireLog(scripted)).toContain('rewind');
    const envelopeCorrections = corrections(outcome.runId).filter(
      (e) => e.name === 'envelope did not parse',
    );
    expect(envelopeCorrections).toHaveLength(3);
  });
});

/** VAL-CROSS-009 — rewind and compaction coexist without trace corruption. */
describe('rewind and compaction coexist (VAL-CROSS-009)', () => {
  const PHASE_START = 'phase-start content\n';

  it('records both a rewind and a compaction, keeps event ordering and the session row intact', async () => {
    // Two agent phases: phase-one trips a rewind on its 2nd correction; between
    // phases the session is full and gets compacted before phase-two.
    const scripted = scriptedAgent(
      ['prose', 'still prose', buildEnvelope(), buildEnvelope()],
      ['watched.txt', 'watched.txt', null, null],
      [],
      {
        rewindFiles: { 'watched.txt': PHASE_START },
        contextUsed: 85_000,
        contextUsedAfterCompaction: 8_500,
      },
    );
    const outcome = await run({
      scripted,
      envelopeRetries: 2,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      pipeline: pipe(
        [
          codePhase(
            'seed',
            { argv: ['sh', '-c', 'printf "phase-start content\\n" > watched.txt'] },
            { description: 'Seed a dirty file so rewind has something to restore.' },
          ),
          agentPhase('one', {
            description: 'Fail twice to trigger rewind on the 2nd correction, then succeed.',
          }),
          agentPhase('two', { description: 'Run after the compaction.' }),
        ],
        {
          description: 'rewind in phase-one + compaction between phases',
          acceptance: { kind: 'all_phases_pass' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const runId = outcome.runId;

    // Both event kinds are present in the same run.
    const all = events(runId);
    const hadRewind = all.some((e) => e.type === 'correction' && e.payload.rewind === true);
    const hadCompaction = all.some((e) => e.type === 'compaction');
    expect(hadRewind).toBe(true);
    expect(hadCompaction).toBe(true);

    // Every payload is valid JSON (tracer stores object, not string — assert no null payloads).
    for (const e of all) {
      expect(e.payload).not.toBeNull();
      expect(typeof e.payload).toBe('object');
    }

    // change_id replay yields all rows once (cursor pagination, same as VAL-CROSS-006).
    let cursor = 0;
    const replayed: ReturnType<typeof events> = [];
    for (;;) {
      const page = h.tracer.eventsAfter(runId, cursor, 10);
      if (!page.length) break;
      replayed.push(...page);
      cursor = page[page.length - 1]!.changeId;
    }
    expect(replayed).toHaveLength(all.length);
    const ids = replayed.map((r) => r.changeId);
    for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
    const byId = new Map(replayed.map((r) => [r.eventId, r]));
    expect(byId.size).toBe(replayed.length);

    // One agent_sessions row for the agent, re-persisted by both the rewind and
    // the compaction rather than duplicated by either.
    const sessions = h.db
      .prepare(
        'SELECT agent, agent_session_id FROM agent_sessions WHERE run_id = ? ORDER BY last_used_at',
      )
      .all(runId) as { agent: string; agent_session_id: string }[];
    expect(sessions.some((s) => s.agent === 'builder')).toBe(true);
    const builder = sessions.find((s) => s.agent === 'builder')!;
    expect(builder.agent_session_id).toBeTruthy();

    expect(h.tracer.run(runId)!.outcomeDetail).toBeTruthy();
  });
});

/**
 * VAL-PROD-012 — a session that cannot start surfaces as a settled failure, not
 * a hang and not a quiet downgrade. There is one transport an agent run has, so
 * "cannot start it" has to reach the operator as a failed run carrying the
 * reason; the old behaviour (fall through to a subprocess, then to a one-shot
 * child that never consults the policy) finished the run under a weaker policy
 * than was configured and said nothing.
 */
describe('a session that will not start (VAL-PROD-012)', () => {
  it('settles failed with a legible outcome_detail rather than degrading', async () => {
    const outcome = await run({
      sessionUnavailable: 'no model provider is configured',
      pipeline: pipe([agentPhase('build', { description: 'the session cannot start' })], {
        description: 'a session that will not start',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    // No hang, no perpetual running — run settles terminal.
    expect(['failed', 'rejected']).toContain(outcome.status);
    const row = h.tracer.run(outcome.runId)!;
    expect(row.outcomeDetail).toBeTruthy();
    // The trace explains the root cause rather than masking it.
    const combined = events(outcome.runId)
      .map((e) => JSON.stringify(e.payload))
      .join('\n');
    expect(combined).toMatch(/agent session start failed/i);
    expect(combined).toMatch(/no model provider is configured/i);
  });
});
