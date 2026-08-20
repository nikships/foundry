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
      turnTimeoutMs: 5_000,
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
