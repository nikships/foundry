/**
 * AgentSession has exactly one transport.
 *
 * Foundry used to degrade daemon → subprocess → one-shot whenever the daemon
 * could not do something. Only two of those transports consulted the policy, so
 * a run that reached one-shot quietly swapped Foundry's write-boundary policy
 * for the CLI's coarser `--auto` gate and said nothing. These tests pin the
 * replacement guarantee: the injected transport is the only one, and when it
 * cannot be opened or a turn fails on it, the turn fails loudly.
 *
 * Scripted transport — no agent runtime, no credentials, no model.
 */

import { tempDir } from '../../helpers/tmp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentSession, type Mode, type TransportRequest } from '../../../src/main/pi/session.js';
import type { AgentTransport } from '../../../src/main/pi/transport.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { AgentDef } from '../../../src/shared/types.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';
import {
  acknowledgePhaseMessage,
  deliverPhaseMessage,
  pendingPhaseMessages,
} from '../../../src/main/engine/phase-messages.js';

const agent: AgentDef = {
  name: 'scout',
  purpose: 'look around',
  model: 'scripted',
  reasoningEffort: 'off',
  systemPrompt: 'You scout.',
  userPrompt: '{{request}}',
  writes: null,
  envelope: 'none',
  color: '#abc',
};

describe('AgentSession has one transport', () => {
  let support: string;
  let tracer: Tracer;
  let worktree: string;
  let runId: string;
  let phaseId: string;

  beforeEach(() => {
    support = tempDir('foundry-agent-transport-');
    worktree = tempDir('foundry-agent-wt-');
    const db = openDb(projectDbPath(support, 'proj'));
    tracer = new Tracer(db, projectRunsDir(support, 'proj'));
    runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  });

  function beginRun(mode: Mode = 'pi'): void {
    tracer.startRun({
      runId,
      projectId: 'proj',
      pipeline: {
        id: 'p',
        name: 'p',
        description: '',
        acceptance: { kind: 'all_phases_pass' },
        phases: [],
      },
      request: 'go',
      engineer: 'test',
      worktreePath: worktree,
      branch: null,
      baseRef: 'main',
      mode,
    });
    // A real phase row: the trace's events reference one, so a turn folded
    // against an invented id would fail on the foreign key rather than on
    // whatever the test is about.
    phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'scout',
      kind: 'agent',
      owner: agent.name,
      description: 'look around',
    });
  }

  function makeSession(transport: (req: TransportRequest) => AgentTransport): AgentSession {
    return new AgentSession(agent, {
      runId,
      worktree,
      tracer,
      protectedPaths: [],
      transport,
    });
  }

  function sessionOn(scripted: ScriptedAgent): AgentSession {
    return makeSession((req) => scripted.transport(req));
  }

  it('runs the turn on the transport and records which one answered', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['ok']);
    const session = sessionOn(scripted);

    const outcome = await session.send('go', { phaseId });

    expect(outcome.text).toBe('ok');
    expect(session.currentMode).toBe('pi');
    expect(tracer.run(runId)!.mode).toBe('pi');
    expect(tracer.agentSessions(runId)[0]!.mode).toBe('pi');
    expect(tracer.phaseSessionEvents(runId, phaseId).at(-1)?.payload).toEqual({
      model: 'scripted',
      agentSessionId: session.sessionId,
    });
    await session.close();
  });

  it('keeps each phase identity when the same session runs a later phase', async () => {
    beginRun();
    const later = tracer.openPhase({
      runId,
      seq: 1,
      name: 'build',
      kind: 'agent',
      owner: agent.name,
      description: 'build',
    });
    const scripted = new ScriptedAgent(['plan', 'build']);
    const session = sessionOn(scripted);
    await session.send('plan', { phaseId });
    await session.send('build', { phaseId: later });
    expect(tracer.phaseSessionEvents(runId, phaseId)).toHaveLength(1);
    expect(tracer.phaseSessionEvents(runId, later)).toHaveLength(1);
    expect(tracer.phaseSessionEvents(runId, later)[0]?.payload.agentSessionId).toBe(
      session.sessionId,
    );
    await session.close();
  });

  it('revisits a late direction and accumulates usage for the final verdict', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['old verdict', 'revised verdict']);
    let turns = 0;
    const session = makeSession((req) => {
      const transport = scripted.transport(req);
      const send = transport.send.bind(transport);
      transport.send = async (text, opts) => {
        if (turns++ === 0) {
          expect(opts?.direction?.()).toBeNull();
          const result = await send(text, opts);
          deliverPhaseMessage(tracer, runId, phaseId, 'Check rollback.');
          return result;
        }
        expect(opts?.direction?.()).toContain('Check rollback.');
        expect(opts?.direction?.()).toBeNull();
        const note = pendingPhaseMessages(tracer, runId, phaseId)[0]!;
        acknowledgePhaseMessage(tracer, runId, phaseId, {
          messageId: note.messageId,
          status: 'acted_on',
          reason: 'Rollback verified.',
        });
        return send(text, opts);
      };
      return transport;
    });
    const outcome = await session.send('go', { phaseId });
    expect(outcome.text).toBe('revised verdict');
    expect(outcome.usage.inputTokens).toBe(200);
    expect(pendingPhaseMessages(tracer, runId, phaseId)).toEqual([]);
    await session.close();
  });

  it('fails closed when supplied direction remains unacknowledged', async () => {
    beginRun();
    deliverPhaseMessage(tracer, runId, phaseId, 'Check rollback.');
    const scripted = new ScriptedAgent(['ignored']);
    const session = makeSession((req) => {
      const transport = scripted.transport(req);
      const send = transport.send.bind(transport);
      transport.send = (text, opts) => {
        expect(opts?.direction?.()).toContain('Check rollback.');
        return send(text, opts);
      };
      return transport;
    });
    await expect(session.send('go', { phaseId })).rejects.toThrow('did not acknowledge');
    expect(scripted.turnRequests).toHaveLength(1);
    expect(pendingPhaseMessages(tracer, runId, phaseId)[0]?.status).toBe('read');
    await session.close();
  });

  it('does not count previous usage again when the direction follow-up is interrupted', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['old verdict']);
    let turns = 0;
    const session = makeSession((req) => {
      const transport = scripted.transport(req);
      const send = transport.send.bind(transport);
      transport.send = async (text, opts) => {
        if (turns++ === 0) {
          const result = await send(text, opts);
          deliverPhaseMessage(tracer, runId, phaseId, 'Check rollback.');
          return result;
        }
        return {
          text: '',
          usage: null,
          reason: 'aborted',
          interrupted: true,
          structuredOutput: null,
        };
      };
      return transport;
    });
    const outcome = await session.send('go', { phaseId });
    expect(outcome.interrupted).toBe(true);
    expect(turns).toBe(2);
    expect(outcome.usage.inputTokens).toBe(100);
    await session.close();
  });

  it('fails the turn when the session cannot be opened, rather than degrading', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['never reached'], [], [], {
      unavailable: 'no model provider is configured',
    });
    const session = sessionOn(scripted);

    await expect(session.send('go', { phaseId })).rejects.toThrow(
      /agent session start failed: no model provider is configured/,
    );
    // The run never claims a transport it did not get onto, and no turn was spent.
    expect(tracer.run(runId)!.mode).toBe('pi');
    expect(scripted.turnRequests).toHaveLength(0);
    await session.close();
  });

  it('fails the turn when building the transport throws', async () => {
    beginRun();
    const session = makeSession(() => {
      throw new Error('runtime state directory is not writable');
    });

    await expect(session.send('go', { phaseId })).rejects.toThrow(
      /runtime state directory is not writable/,
    );
    await session.close();
  });

  it('surfaces a mid-turn transport failure instead of retrying it elsewhere', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['never reached'], [], [], { dieOnTurns: [0] });
    const session = sessionOn(scripted);

    await expect(session.send('go', { phaseId })).rejects.toThrow(/died mid-turn/);
    // No fallback event exists to be written, because no fallback exists.
    const names = tracer.eventsAfter(runId, 0).map((e) => e.name);
    expect(names.some((n) => /fallback/.test(n))).toBe(false);
    await session.close();
  });

  it('keeps one session across turns rather than reopening per turn', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['one', 'two']);
    const session = sessionOn(scripted);

    await session.send('first', { phaseId });
    await session.send('second', { phaseId });

    expect(scripted.sessionOpens).toBe(1);
    expect(scripted.turnRequests.map((t) => t.text)).toEqual(['first', 'second']);
    await session.close();
  });

  it('opens no session at all for an agent that never runs a phase', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['ok']);
    const session = sessionOn(scripted);

    // Lazily started: a roster agent no phase names must cost nothing.
    expect(scripted.sessionOpens).toBe(0);
    expect(session.sessionId).toBeNull();
    expect(await session.contextStats()).toBeNull();
    await session.close();
  });

  it('rewinds by message id and a plain path list', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['ok'], [], [], { rewindFiles: { 'a.txt': 'x' } });
    const session = sessionOn(scripted);

    await session.send('go', { phaseId });
    const outcome = await session.rewind({
      messageId: session.lastUserMessageId!,
      paths: ['a.txt'],
    });

    expect(outcome?.restoredCount).toBe(1);
    expect(scripted.wire).toContain('get_rewind_info');
    expect(scripted.wire).toContain('rewind');
    await session.close();
  });

  it('hands the transport factory the agent, so a tool profile reaches the session', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['ok']);
    const requests: TransportRequest[] = [];
    const readOnly: AgentDef = { ...agent, toolProfile: 'read-only' };
    const session = new AgentSession(readOnly, {
      runId,
      worktree,
      tracer,
      protectedPaths: [],
      transport: (req) => {
        requests.push(req);
        return scripted.transport(req);
      },
    });

    await session.send('go', { phaseId });

    // The executor reads it off this request to pick the tool list; a profile
    // the factory never sees is a profile the session cannot honour.
    expect(requests[0]!.agent.toolProfile).toBe('read-only');
    await session.close();
  });

  it('refuses to answer a turn once the run has been killed', async () => {
    beginRun();
    const scripted = new ScriptedAgent(['ok']);
    const session = sessionOn(scripted);

    session.kill();
    await expect(session.send('go', { phaseId })).rejects.toThrow(/the run was killed/);
    // A killed run must not spend a turn: that is money, and a result the run
    // could still have been settled on.
    expect(scripted.turnRequests).toHaveLength(0);
    await session.close();
  });
});
