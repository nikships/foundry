import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  deliverPhaseMessage,
  phaseMessages,
  pendingPhaseMessages,
  readPhaseMessages,
  acknowledgePhaseMessage,
} from '../../../src/main/engine/phase-messages.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import { AgentSession } from '../../../src/main/pi/session.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';
import { makeFakeGh } from '../../helpers/fake-gh.js';
import {
  createHarness,
  addOrigin,
  buildAgent,
  codePhase,
  agentPhase,
  pipe,
  reviewEnvelope,
  prEnvelope,
  prWriter,
  openPrPhase,
  runForHarness,
} from './executor-harness.js';

const ruling =
  'Model note was pipeline-only; screenshots belong in the PR body; the plan staying untracked is intentional; read-only waiting is correct without a desktop route.';

function fixture() {
  const h = createHarness();
  const runId = 'run_direction';
  const pipeline = pipe([agentPhase('final_review'), agentPhase('other')]);
  h.tracer.startRun({
    runId,
    projectId: h.project.id,
    pipeline,
    request: 'review',
    engineer: 'test',
    worktreePath: h.repo,
    branch: null,
    baseRef: 'main',
    mode: 'pi',
  });
  const phaseId = h.tracer.openPhase({
    runId,
    seq: 0,
    name: 'final_review',
    kind: 'agent',
    owner: 'builder',
    description: '',
  });
  const otherId = h.tracer.queuePhase({
    runId,
    seq: 1,
    name: 'other',
    kind: 'agent',
    owner: 'builder',
    description: '',
  });
  return { ...h, runId, phaseId, otherId };
}

describe('durable phase direction', () => {
  it('persists without resuming, scopes acknowledgment, and advances the trace cursor at every state', () => {
    const h = fixture();
    h.tracer.closePhase(h.phaseId, 'fail', 'old reading');
    const note = deliverPhaseMessage(h.tracer, h.runId, h.phaseId, ruling);
    const restored = new Tracer(h.db, h.tracer.runDir(h.runId).replace(/\/run_direction$/, ''));
    expect(phaseMessages(restored, h.runId)[0]).toEqual(note);
    expect(h.tracer.phase(h.phaseId)?.status).toBe('fail');
    expect(pendingPhaseMessages(h.tracer, h.runId, h.otherId)).toEqual([]);
    expect(() =>
      acknowledgePhaseMessage(h.tracer, h.runId, h.phaseId, {
        messageId: note.messageId,
        status: 'acted_on',
        reason: 'done',
      }),
    ).toThrow('not been read');
    const cursor = Math.max(...h.tracer.eventsAfter(h.runId, 0).map((event) => event.changeId));
    readPhaseMessages(h.tracer, h.runId, h.phaseId);
    expect(
      h.tracer.eventsAfter(h.runId, cursor).find((event) => event.eventId === note.messageId)
        ?.payload.direction,
    ).toMatchObject({ status: 'read' });
    expect(() =>
      acknowledgePhaseMessage(h.tracer, h.runId, h.otherId, {
        messageId: note.messageId,
        status: 'acted_on',
        reason: 'wrong phase',
      }),
    ).toThrow();
    expect(() =>
      acknowledgePhaseMessage(h.tracer, h.runId, h.phaseId, {
        messageId: note.messageId,
        status: 'dismissed',
        reason: ' ',
      }),
    ).toThrow();
    acknowledgePhaseMessage(h.tracer, h.runId, h.phaseId, {
      messageId: note.messageId,
      status: 'dismissed',
      reason: 'A separate reproducible code defect remains.',
    });
    expect(phaseMessages(h.tracer, h.runId)[0]).toMatchObject({
      status: 'dismissed',
      readAt: expect.any(String),
      resolvedAt: expect.any(String),
      reason: 'A separate reproducible code defect remains.',
    });
    expect(pendingPhaseMessages(h.tracer, h.runId, h.phaseId)).toEqual([]);
    expect(() => deliverPhaseMessage(h.tracer, 'wrong_run', h.phaseId, ruling)).toThrow();
    h.tracer.closePhase(h.otherId, 'success');
    expect(deliverPhaseMessage(h.tracer, h.runId, h.otherId, ruling).noteOnly).toBe(true);
    expect(readPhaseMessages(h.tracer, h.runId, h.otherId)).toEqual([]);
  });

  it('reads a mid-turn note on the next call and does not return the old verdict', async () => {
    const h = fixture();
    const scripted = new ScriptedAgent(['old verdict', 'new verdict']);
    let calls = 0;
    const session = new AgentSession(buildAgent(), {
      runId: h.runId,
      worktree: h.repo,
      tracer: h.tracer,
      protectedPaths: [],
      transport: (req) => {
        const transport = scripted.transport(req);
        const send = transport.send.bind(transport);
        transport.send = async (text, opts) => {
          calls += 1;
          const direction = opts?.direction?.();
          if (calls === 1) {
            expect(direction).toBeNull();
            deliverPhaseMessage(h.tracer, h.runId, h.phaseId, ruling);
          } else {
            expect(direction).toContain(ruling);
            const note = phaseMessages(h.tracer, h.runId)[0]!;
            acknowledgePhaseMessage(h.tracer, h.runId, h.phaseId, {
              messageId: note.messageId,
              status: 'acted_on',
              reason: 'Re-evaluated all four points and the code.',
            });
          }
          return send(text, opts);
        };
        return transport;
      },
    });
    const result = await session.send('review', { phaseId: h.phaseId });
    expect(result.text).toBe('new verdict');
    expect(result.usage.inputTokens).toBe(200);
    expect(calls).toBe(2);
    expect(phaseMessages(h.tracer, h.runId)[0]?.status).toBe('acted_on');
    expect(await session.interruptPhase(h.phaseId)).toBe(false);
    await session.close();
  });

  it('does not accept an ignored note or continue after an explicit interrupt', async () => {
    const h = fixture();
    const note = deliverPhaseMessage(h.tracer, h.runId, h.phaseId, ruling);
    const scripted = new ScriptedAgent(['ignored']);
    const session = new AgentSession(buildAgent(), {
      runId: h.runId,
      worktree: h.repo,
      tracer: h.tracer,
      protectedPaths: [],
      transport: (req) => {
        const transport = scripted.transport(req);
        const send = transport.send.bind(transport);
        transport.send = (text, opts) => {
          opts?.direction?.();
          return send(text, opts);
        };
        return transport;
      },
    });
    await expect(session.send('review', { phaseId: h.phaseId })).rejects.toThrow(
      'did not acknowledge',
    );
    expect(phaseMessages(h.tracer, h.runId)[0]).toMatchObject({
      messageId: note.messageId,
      status: 'read',
    });
    await session.close();

    const stalled = new ScriptedAgent(['unused'], [], [], { stallOnTurns: [0] });
    const live = new AgentSession(buildAgent(), {
      runId: h.runId,
      worktree: h.repo,
      tracer: h.tracer,
      protectedPaths: [],
      transport: (req) => stalled.transport(req),
    });
    const pending = live.send('review', { phaseId: h.phaseId });
    await vi.waitFor(() => expect(stalled.turnStarted).toBe(true));
    expect(await live.interruptPhase(h.otherId)).toBe(false);
    expect(await live.interruptPhase(h.phaseId)).toBe(true);
    expect((await pending).interrupted).toBe(true);
    expect(stalled.turnMarkers).toHaveLength(1);
    await live.close();
  });

  it('re-evaluates a rejected reviewer in the same worktree and conversation, then reaches open_pr without rebuilding', async () => {
    const h = createHarness();
    addOrigin(h.repo);
    const reviewer = buildAgent({
      name: 'reviewer',
      envelope: 'review',
      writes: [],
      toolProfile: 'read-only',
    });
    const agents = [reviewer, prWriter()];
    const pipeline = pipe([
      codePhase('screenshot_verify', {
        argv: ['sh', '-c', 'echo verified >> verification-count; echo keep > plan.md'],
      }),
      agentPhase('final_review', {
        agent: 'reviewer',
        envelope: 'review',
        gates: ['verdict_consistent', 'disapproval_halts'],
      }),
      openPrPhase(),
    ]);
    const first = await runForHarness(h, {
      agents,
      pipeline,
      scripted: new ScriptedAgent([
        JSON.stringify({ ...JSON.parse(reviewEnvelope(false)), status: 'fail' }),
      ]),
    });
    expect(first.status).toBe('rejected');
    const run = h.tracer.run(first.runId)!;
    const phase = h.tracer.phases(first.runId).find((row) => row.name === 'final_review')!;
    const previousSessionId = h.tracer.agentSessions(first.runId)[0]!.agentSessionId;
    const note = deliverPhaseMessage(h.tracer, first.runId, phase.phaseId, ruling);
    expect(h.tracer.run(first.runId)?.status).toBe('rejected');
    const scripted = new ScriptedAgent([reviewEnvelope(true), prEnvelope()]);
    const gh = makeFakeGh({ createUrl: 'https://github.com/acme/widgets/pull/42' });
    const deps: ExecutorDeps = {
      tracer: h.tracer,
      runId: first.runId,
      project: h.project,
      pipeline,
      agents,
      engineer: 'test',
      request: 'review',
      supportDir: h.support,
      envelopeDefs: [],
      envelopeRetries: 0,
      gateRetries: 0,
      compactionThreshold: 0.8,
      rewindAfterCorrections: 2,
      gh: { bin: gh.bin },
      transport: (req) => {
        const transport = scripted.transport(req);
        const send = transport.send.bind(transport);
        transport.send = async (text, opts) => {
          const direction = opts?.direction?.();
          if (req.agent.name === 'reviewer') {
            expect(direction).toContain(ruling);
            expect(req.agent.writes).toEqual([]);
            acknowledgePhaseMessage(h.tracer, first.runId, req.phaseId()!, {
              messageId: note.messageId,
              status: 'acted_on',
              reason: 'All four operator rulings applied; no other code blocker found.',
            });
          } else expect(direction).toBeNull();
          return send(text, opts);
        };
        return transport;
      },
    };
    const outcome = await new Executor(deps).resume();
    expect(outcome.status).toBe('accepted');
    expect(h.tracer.run(first.runId)?.prNumber).toBe(42);
    expect(h.tracer.run(first.runId)?.worktreePath).toBe(run.worktreePath);
    expect(readFileSync(join(run.worktreePath!, 'verification-count'), 'utf8')).toBe('verified\n');
    expect(readFileSync(join(run.worktreePath!, 'plan.md'), 'utf8')).toBe('keep\n');
    expect(scripted.reopened.find((entry) => entry.agent === 'reviewer')?.existingSessionId).toBe(
      previousSessionId,
    );
    expect(phaseMessages(h.tracer, first.runId)[0]?.status).toBe('acted_on');
  });
});
