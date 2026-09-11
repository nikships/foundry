/**
 * Executor test suite — split across files to parallelize over CPU cores.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHarness,
  scriptedAgent,
  turnRequests,
  wireLog,
  handshakeCount,
  until,
  buildAgent,
  codePhase,
  agentPhase,
  pipe,
  buildEnvelope,
  runForHarness,
  startForHarness,
  eventsForHarness,
  processRowsForHarness,
  type Harness,
  type RunInput,
} from './executor-harness.js';
import type { PipelineDef } from '../../../src/shared/types.js';
import { exampleFor, jsonSchemaFor } from '../../../src/main/engine/envelopes.js';
import { Executor } from '../../../src/main/engine/executor.js';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});
const run = (input: RunInput) => runForHarness(h, input);
const start = (input: RunInput) => startForHarness(h, input);
const events = (runId: string) => eventsForHarness(h, runId);
const processRows = (runId: string) => processRowsForHarness(h, runId);

/**
 * The transport under the executor, exercised the way a run actually uses it.
 * These pin the properties a runtime swap could quietly lose — that agent
 * phases record which transport answered, that an in-process session leaves no
 * child behind, and that a failing turn fails rather than degrading to
 * something with a weaker permission policy.
 */
describe('the agent transport under the executor', () => {
  it('runs agent phases on the in-process transport', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove the agent phase drove the transport.' })],
        {
          description: 'one agent phase over the transport',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.run(outcome.runId)!.mode).toBe('pi');
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.mode).toBe('pi');
    // The session id only exists if the session actually opened.
    expect(sessions[0]!.agentSessionId).toBe('s1');
  });

  it('records no child process, because the agent runs in this process', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove no per-agent child is spawned.' })],
        {
          description: 'one agent phase',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // The agent runtime is a library call, so an agent phase has no child to
    // record or reap — and nothing can outlive the run.
    expect(processRows(outcome.runId)).toHaveLength(0);
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });

  it('keeps one session across a correction rather than reopening', async () => {
    const scripted = scriptedAgent(['prose, not JSON', buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Correct in the live session.' })], {
        description: 'a correction inside one session',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    expect(outcome.status).toBe('accepted');
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.mode).toBe('pi');
    expect(
      events(outcome.runId).some(
        (e) => e.type === 'correction' && e.name === 'envelope did not parse',
      ),
    ).toBe(true);
    // One session for the whole phase: a reopen would have started twice.
    expect(handshakeCount(scripted)).toBe(1);
  });

  it('leaves a stalled turn running until the operator kills it', async () => {
    const scripted = scriptedAgent([buildEnvelope()], [], [], { stallOnTurns: [0] });
    const launched = start({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a stalled turn has no deadline.' })],
        {
          description: 'a transport that stays live until the operator acts',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    await until(() => turnRequests(scripted).length === 1, 'stalled turn to begin');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(h.tracer.run(launched.runId)!.status).toBe('running');
    expect(events(launched.runId).some((e) => e.name === 'builder: turn failed')).toBe(false);

    launched.executor.cancel();
    expect((await launched.done).status).toBe('killed');
  });

  it('continues a naturally failed run in the same worktree and persisted agent session', async () => {
    const pipeline = pipe(
      [
        codePhase('prepare', { argv: ['sh', '-c', 'echo prepared >> prepare-count'] }),
        agentPhase('build', { description: 'Finish after the interrupted turn.' }),
      ],
      {
        description: 'a run that can continue after an app restart',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      },
    );
    const failed = scriptedAgent([buildEnvelope()], [], [], { dieOnTurns: [0] });
    const first = await run({ pipeline, scripted: failed });

    expect(first.status).toBe('rejected');
    const before = h.tracer.run(first.runId)!;
    const phaseIds = h.tracer.phases(first.runId).map((phase) => phase.phaseId);
    const sessionId = h.tracer.agentSessions(first.runId)[0]!.agentSessionId;
    expect(readFileSync(join(before.worktreePath!, 'prepare-count'), 'utf8')).toBe('prepared\n');

    const continued = scriptedAgent([buildEnvelope()]);
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
      pipeline,
      request: 'do the thing',
      runId: first.runId,
      engineer: 'test',
    });
    const outcome = await executor.resume();

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(first.runId).map((phase) => phase.phaseId)).toEqual(phaseIds);
    expect(readFileSync(join(before.worktreePath!, 'prepare-count'), 'utf8')).toBe('prepared\n');
    expect(turnRequests(continued)[0]!.sessionId).toBe(sessionId);
    expect(events(first.runId)).toContainEqual(
      expect.objectContaining({ type: 'log', name: 'run continued' }),
    );
    // A correction is not a recovery: nothing was abandoned, so nothing is
    // recorded as having been.
    expect(events(first.runId).filter((e) => e.name === 'run recovered')).toEqual([]);
  });

  it('fails the phase when the session dies mid-turn', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], { dieOnTurns: [0] });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a dead session is not papered over.' })],
        {
          description: 'a transport that dies',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    expect(h.tracer.run(outcome.runId)!.mode).toBe('pi');
    // No fallback events exist to be logged, because no fallback exists.
    expect(events(outcome.runId).some((e) => /fallback/.test(e.name))).toBe(false);
    expect(h.tracer.openProcesses(outcome.runId)).toHaveLength(0);
  });
});

/**
 * Pre-emptive compaction. The engine, not the agent, decides when a session has
 * filled up, and it decides it BETWEEN phases: compacting mid-turn would rewrite
 * the history a turn in flight is reasoning over.
 *
 * Compaction is in place — the session keeps its identity and loses messages —
 * so what a test can assert is the occupancy either side of it and that the run
 * carried on. There is no successor id to name. The Foundry summarizer, not
 * Pi's chat template, is what compact receives, and the ledger is forgotten
 * only after a compact that actually dropped messages.
 */
describe('compaction between phases', () => {
  /** Two agent phases so there is an inter-phase window at all. */
  function twoPhases(over: Partial<PipelineDef> = {}): PipelineDef {
    return pipe(
      [
        agentPhase('build', { description: 'Fill the context up.' }),
        agentPhase('polish', { description: 'Run after the window was compacted.' }),
      ],
      {
        description: 'two agent phases with a compaction window between them',
        acceptance: { kind: 'envelope_status', phase: 'polish' },
        ...over,
      },
    );
  }

  function compactions(runId: string) {
    return events(runId).filter((e) => e.type === 'compaction');
  }

  it('compacts a session over the threshold and runs the next phase on it', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    // One compaction, in the one window there was for it.
    const compacted = wireLog(scripted).filter((line) => line === 'compact');
    expect(compacted).toHaveLength(1);

    // Compaction is in place, so the id the trace carries is the one a resumed
    // run reopens — and it is the same session that was compacted.
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.agentSessionId).toBe('s1');

    const turns = wireLog(scripted).filter((line) => line.startsWith('turn_started'));
    expect(turns).toHaveLength(2);
    for (const turn of turns) expect(turn).toContain('session=s1');
    // One open, so the compaction did not cost a reopen either.
    expect(handshakeCount(scripted)).toBe(1);
  });

  it('records what the compaction removed and the window either side of it', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    const rows = compactions(outcome.runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('builder');
    expect(rows[0]!.payload.removedCount).toBe(7);
    expect(rows[0]!.payload.before).toEqual({ used: 85_000, limit: 100_000 });
    expect(rows[0]!.payload.after).toEqual({ used: 8_500, limit: 100_000 });
  });

  it('leaves a session under the threshold alone', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 40_000,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted)).not.toContain('compact');
    expect(compactions(outcome.runId)).toHaveLength(0);
    expect(h.tracer.agentSessions(outcome.runId)[0]!.agentSessionId).toBe('s1');
  });

  it('honours a threshold the operator moved', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 60_000,
    });
    const outcome = await run({
      scripted,
      compactionThreshold: 0.5,
      pipeline: twoPhases(),
    });

    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted).filter((l) => l === 'compact')).toHaveLength(1);
  });

  it('never compacts inside a turn, correction retries included', async () => {
    // Phase one needs a correction, so the phase spans two turns with one
    // inter-phase window after them — over threshold from the very first stats.
    const scripted = scriptedAgent(['prose, not JSON', buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 90_000,
      contextUsedAfterCompaction: 9_000,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    const log = wireLog(scripted);
    // Every compaction sits outside an open turn: between a completion and the
    // next turn's start, never between a start and its completion.
    let openTurn = false;
    for (const line of log) {
      if (line.startsWith('turn_started')) openTurn = true;
      if (line.startsWith('turn_completed')) openTurn = false;
      if (line === 'compact') expect(openTurn).toBe(false);
    }
    expect(log.filter((l) => l === 'compact')).toHaveLength(1);
    // Three turns: the bad envelope, its correction, then phase two.
    expect(log.filter((l) => l.startsWith('turn_started'))).toHaveLength(3);
  });

  it('carries a post-compaction correction on the compacted session', async () => {
    // Phase two's first reply is unparseable, so its correction is the first
    // thing the compacted session ever sees.
    const scripted = scriptedAgent([buildEnvelope(), 'prose, not JSON', buildEnvelope()], [], [], {
      contextUsed: 85_000,
      contextUsedAfterCompaction: 8_500,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    expect(outcome.status).toBe('accepted');
    const turns = wireLog(scripted).filter((l) => l.startsWith('turn_started'));
    expect(turns).toHaveLength(3);
    // All three turns, the post-compaction correction included, are the same
    // conversation: compaction shortens a session, it does not replace one.
    for (const turn of turns) expect(turn).toContain('session=s1');

    // One session row for the agent, and the correction is inside the phase.
    const sessions = h.tracer.agentSessions(outcome.runId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.agentSessionId).toBe('s1');
    expect(
      events(outcome.runId).some(
        (e) => e.type === 'correction' && e.name === 'envelope did not parse',
      ),
    ).toBe(true);
    // Compaction is not a reopen, so the run never opens a second session.
    expect(handshakeCount(scripted)).toBe(1);
  });

  it('hands the Foundry summarizer request, artifacts, pins, and envelope fields', async () => {
    const scripted = scriptedAgent(
      [buildEnvelope({ artifacts: ['.foundry-handoff/build.json'] }), buildEnvelope()],
      [],
      [],
      { contextUsed: 85_000, contextUsedAfterCompaction: 8_500 },
    );
    const outcome = await run({
      scripted,
      request: 'ship the widget',
      project: { contextSummary: '## Stack\nTypeScript' },
      pipeline: twoPhases(),
    });
    expect(outcome.status).toBe('accepted');
    expect(scripted.compactFacts).toHaveLength(1);
    const facts = scripted.compactFacts[0]!;
    expect(facts.request).toBe('ship the widget');
    expect(facts.phase).toBe('build');
    expect(facts.artifactPaths).toContain('.foundry-handoff/build.json');
    expect(facts.phaseUserPrompt).toContain('ship the widget');
    expect(facts.phaseUserPrompt).not.toContain('## Report');
    expect(facts.projectCard).toContain('## Stack\nTypeScript');
    expect(facts.envelopeKind).toBe('build');
    expect(facts.requiredFields).toContain('status');
    expect(facts.requiredFields).toContain('commit_message');
    // Standing role is re-injected, so the next turn still sees the project card.
    expect(turnRequests(scripted)[1]!.systemPrompt).toContain('## Stack\nTypeScript');
  });

  it('forgets the ledger only after a compact that actually dropped messages', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      compactFails: true,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted).filter((l) => l === 'compact')).toHaveLength(1);
    // Failure is traced; the compact still ran after the first phase, not before.
    const log = wireLog(scripted);
    const firstTurn = log.findIndex((l) => l.startsWith('turn_completed'));
    const compactAt = log.indexOf('compact');
    expect(firstTurn).toBeGreaterThanOrEqual(0);
    expect(compactAt).toBeGreaterThan(firstTurn);
  });

  it('carries on with the run when the session refuses to compact', async () => {
    const scripted = scriptedAgent([buildEnvelope(), buildEnvelope()], [], [], {
      contextUsed: 85_000,
      compactFails: true,
    });
    const outcome = await run({ scripted, pipeline: twoPhases() });

    // A failed compaction costs the run nothing: the next phase runs on the
    // session it already had and acceptance decides the outcome as usual.
    expect(outcome.status).toBe('accepted');
    expect(wireLog(scripted).filter((l) => l === 'compact')).toHaveLength(1);
    expect(compactions(outcome.runId)).toHaveLength(0);
    expect(h.tracer.agentSessions(outcome.runId)[0]!.agentSessionId).toBe('s1');
    const turns = wireLog(scripted).filter((l) => l.startsWith('turn_started'));
    expect(turns[1]).toContain('session=s1');
    // The failure is on the record, so a run that then hits the wall explains itself.
    const failures = events(outcome.runId).filter((e) => e.name === 'builder: compaction failed');
    expect(failures).toHaveLength(1);
    expect(String(failures[0]!.payload.message)).toContain('nothing to compact');
  });
});

/**
 * The envelope as a wire constraint. The schema an agent turn carries is the
 * same zod instance the reply is parsed against, and a structured reply is
 * still only a candidate: nothing succeeds without passing the parse.
 */
describe('structured-output envelopes', () => {
  /** Prose no `extractJson` can rescue, so only structuredOutput can settle it. */
  const NO_JSON = 'I did the work. There is no JSON anywhere in this sentence.';

  const structuredBuild = {
    status: 'success',
    summary: 'built it from the schema',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
  };

  function corrections(runId: string) {
    return events(runId).filter(
      (e) => e.type === 'correction' && e.name === 'envelope did not parse',
    );
  }

  it('constrains agent turns with the envelope schema and no other phase', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('build', { description: 'Carry the envelope schema on the wire.' }),
          codePhase('check', { argv: ['true'] }, { description: 'A command, not an agent turn.' }),
        ],
        {
          description: 'agent and code phases side by side',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    // Only the agent phase ever sends a turn, and it carries the schema the
    // reply is parsed against — same source, so the two cannot drift.
    const requests = turnRequests(scripted);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.outputFormat).toEqual({
      type: 'json_schema',
      schema: JSON.parse(JSON.stringify(jsonSchemaFor('build'))),
    });
  });

  it('carries an agent’s custom fields into the schema it puts on the wire', async () => {
    const scripted = scriptedAgent([buildEnvelope({ severity: 'high' })]);
    const custom = [
      { name: 'severity', type: 'string' as const, required: true, description: 'low|med|high' },
    ];
    const outcome = await run({
      scripted,
      agents: [buildAgent({ customFields: custom })],
      pipeline: pipe(
        [agentPhase('build', { description: 'Constrain the turn with the extended schema.' })],
        {
          description: 'an agent with a custom envelope field',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const format = turnRequests(scripted)[0]!.outputFormat as { schema: Record<string, unknown> };
    expect(format.schema).toEqual(JSON.parse(JSON.stringify(jsonSchemaFor('build', custom))));
    expect(format.schema.required).toContain('severity');
  });

  it('does not reprint the envelope example in the user prompt', async () => {
    const scripted = scriptedAgent([buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('build', { description: 'Keep a single envelope channel.' })], {
        description: 'the prompt no longer reprints the schema example',
        acceptance: { kind: 'envelope_status', phase: 'build' },
      }),
    });

    const example = exampleFor('build');
    const userText = String(turnRequests(scripted)[0]!.text);
    expect(userText).toContain('call `submit_envelope` once');
    expect(userText).not.toContain(example);
    expect(userText).not.toContain('## Report');
    const prompt = readFileSync(
      join(h.tracer.runDir(outcome.runId), 'builder/prompts/build-1.md'),
      'utf8',
    );
    expect(prompt).not.toContain(example);
  });

  it('accepts a valid structured reply whose text carries no envelope at all', async () => {
    const scripted = scriptedAgent([NO_JSON], [], [], { structuredOutputs: [structuredBuild] });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Settle the phase from the structured reply.' })],
        {
          description: 'structured output is the primary path',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    const envelopes = h.tracer.envelopes(outcome.runId);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.valid).toBe(true);
    expect(envelopes[0]!.payload).toMatchObject({
      status: 'success',
      summary: 'built it from the schema',
      commit_message: 'add a thing',
    });
  });

  it('accepts a structured reply on a non-generic kind with a required field', async () => {
    const structuredReview = {
      status: 'success',
      summary: 'reviewed from the schema',
      artifacts: [],
      approved: true,
      findings: [],
      blocking: [],
      notes_for_next_agent: '',
    };
    const scripted = scriptedAgent([NO_JSON], [], [], { structuredOutputs: [structuredReview] });
    const outcome = await run({
      scripted,
      agents: [buildAgent({ name: 'reviewer', envelope: 'review' })],
      pipeline: pipe(
        [
          agentPhase('review', {
            agent: 'reviewer',
            envelope: 'review',
            description: 'Settle a review phase from the structured reply.',
          }),
        ],
        {
          description: 'structured output on the review kind',
          acceptance: { kind: 'phase_flag', phase: 'review', flag: 'approved' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    expect(h.tracer.envelopes(outcome.runId)[0]!.payload).toMatchObject({
      approved: true,
      summary: 'reviewed from the schema',
    });
  });

  it('corrects a structured reply the schema accepts but the parse rejects', async () => {
    // `status: 'maybe'` is a string, so a loose schema check waves it through;
    // the zod enum is what actually decides, and it is the only authority.
    const bogus = { ...structuredBuild, status: 'maybe' };
    const scripted = scriptedAgent([NO_JSON, buildEnvelope()], [], [], {
      structuredOutputs: [bogus, null],
    });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Never trust a transport’s conformance claim.' })],
        {
          description: 'structured output that fails the zod parse',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrected = corrections(outcome.runId);
    expect(corrected).toHaveLength(1);
    expect(String(corrected[0]!.payload.problem)).toContain('status');
    // Both attempts are recorded, the rejected one as evidence.
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([false, true]);
  });

  it('reads the text when the agent could not shape the reply, without burning a retry', async () => {
    const scripted = scriptedAgent([buildEnvelope()], [], [], {
      turnReasons: ['structured_output_invalid'],
    });
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Fall back to the text on the same attempt.' })],
        {
          description: 'a schema failure whose text still parses',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(corrections(outcome.runId)).toHaveLength(0);
    expect(turnRequests(scripted)).toHaveLength(1);
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([true]);
  });

  it('spends the envelope budget, not a second one, when neither channel parses', async () => {
    const scripted = scriptedAgent([NO_JSON], [], [], {
      turnReasons: ['structured_output_missing', 'structured_output_missing'],
    });
    const outcome = await run({
      scripted,
      envelopeRetries: 1,
      pipeline: pipe(
        [agentPhase('build', { description: 'Prove a schema failure has no budget of its own.' })],
        {
          description: 'neither structured output nor text ever parses',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('rejected');
    // envelopeRetries + 1 attempts, exactly today's arithmetic.
    expect(turnRequests(scripted)).toHaveLength(2);
    expect(corrections(outcome.runId)).toHaveLength(2);
    // Born fail: nothing about a schema failure flips a phase.
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('fail');
  });

  it('keeps the bad-envelope-then-good scenario at one correction and two attempts', async () => {
    // The pre-SDK baseline for this scenario, unchanged by the wire constraint.
    const scripted = scriptedAgent(['I will explain in prose instead of JSON.', buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [agentPhase('build', { description: 'Hold the envelope retry rate where it was.' })],
        {
          description: 'first reply is prose, second is an envelope',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    expect(h.tracer.phases(outcome.runId)[0]!.status).toBe('success');
    expect(corrections(outcome.runId)).toHaveLength(1);
    expect(turnRequests(scripted)).toHaveLength(2);
    expect(h.tracer.envelopes(outcome.runId).map((e) => e.valid)).toEqual([false, true]);
  });
});

/**
 * Rewind instrumentation (Phase 3b part 1): every agent-phase correction carries
 * a per-phase running correctionIndex shared across envelope/boundary/gate, so
 * traces can answer "which attempt index succeeded".
 */
describe('correction instrumentation', () => {
  function agentCorrections(runId: string) {
    return events(runId).filter(
      (e) =>
        e.type === 'correction' &&
        (e.name === 'envelope did not parse' ||
          e.name === 'boundary violation' ||
          e.name === 'gate violations'),
    );
  }

  it('numbers every correction in a phase with a shared running correctionIndex', async () => {
    // Envelope fail → boundary fail → gate fail → success. One counter across
    // the three kinds, and the existing attempt field stays on each payload.
    const scripted = scriptedAgent(
      [
        'prose, not JSON',
        buildEnvelope(),
        buildEnvelope({ artifacts: ['ghost.txt'] }),
        buildEnvelope({ artifacts: ['real.txt'] }),
      ],
      [null, 'forbidden/slipped.txt', null, 'real.txt'],
    );
    const outcome = await run({
      scripted,
      agents: [buildAgent({ writes: ['allowed/', 'real.txt'] })],
      envelopeRetries: 1,
      pipeline: pipe(
        [
          agentPhase('build', {
            retries: 2,
            description: 'Share one correctionIndex across envelope, boundary, and gate.',
            gates: ['artifacts_exist'],
          }),
        ],
        {
          description: 'three correction kinds then success',
          acceptance: { kind: 'envelope_status', phase: 'build' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrections = agentCorrections(outcome.runId);
    expect(corrections.map((e) => e.name)).toEqual([
      'envelope did not parse',
      'boundary violation',
      'gate violations',
    ]);
    expect(corrections.map((e) => e.payload.correctionIndex)).toEqual([1, 2, 3]);
    // attempt is still present — Banner detail keys off it.
    for (const event of corrections) {
      expect(typeof event.payload.attempt).toBe('number');
      expect(event.payload.attempt).toBeGreaterThan(0);
    }
  });

  it('resets correctionIndex at the start of each agent phase', async () => {
    const scripted = scriptedAgent([
      'phase-one prose',
      buildEnvelope({ summary: 'phase one' }),
      'phase-two prose',
      buildEnvelope({ summary: 'phase two' }),
    ]);
    const outcome = await run({
      scripted,
      pipeline: pipe(
        [
          agentPhase('first', {
            description: 'First phase burns one envelope correction.',
          }),
          agentPhase('second', {
            description: 'Second phase starts the counter over.',
          }),
        ],
        {
          description: 'two agent phases each with one envelope correction',
          acceptance: { kind: 'all_phases_pass' },
        },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const corrections = agentCorrections(outcome.runId);
    expect(corrections).toHaveLength(2);
    expect(corrections.map((e) => e.payload.correctionIndex)).toEqual([1, 1]);
    // Distinct phases — the counter did not bleed across.
    expect(corrections[0]!.phaseId).not.toBe(corrections[1]!.phaseId);
  });
});
