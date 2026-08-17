/**
 * AgentSession has exactly one transport.
 *
 * Foundry used to degrade daemon → subprocess → one-shot whenever the daemon
 * could not do something. Only the daemon and subprocess transports consult
 * `permissions.ts`, so a run that reached one-shot quietly swapped Foundry's
 * write-boundary policy for the CLI's coarser `--auto` gate and said nothing.
 * These tests pin the replacement guarantee: the daemon is the only transport,
 * and when it cannot be opened or a turn fails on it, the turn fails loudly.
 *
 * Scripted daemon facade — no real daemon, no API key, no model.
 */

import { tempDir } from './tmp.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentSession, type Mode, type OpenDaemonResult } from '../src/main/droid/agent.js';
import { openDb, projectDbPath, projectRunsDir } from '../src/main/trace/db.js';
import { Tracer } from '../src/main/trace/tracer.js';
import type { AgentDef } from '../src/shared/types.js';
import { ScriptedAgent } from './scripted-agent.js';

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

describe('AgentSession is daemon-only', () => {
  let support: string;
  let tracer: Tracer;
  let worktree: string;
  let runId: string;

  beforeEach(() => {
    support = tempDir('foundry-agent-transport-');
    worktree = tempDir('foundry-agent-wt-');
    const db = openDb(projectDbPath(support, 'proj'));
    tracer = new Tracer(db, projectRunsDir(support, 'proj'));
    runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  });

  function beginRun(mode: Mode = 'daemon'): void {
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
  }

  function makeSession(open: () => Promise<OpenDaemonResult>): AgentSession {
    return new AgentSession(agent, {
      cliPath: 'droid-not-used',
      runId,
      worktree,
      turnTimeoutMs: 5_000,
      tracer,
      policy: { protectedPaths: [] },
      openDaemonSessions: open,
    });
  }

  it('runs the turn on the daemon and reports daemon mode', async () => {
    beginRun();
    const daemon = new ScriptedAgent(['ok']);
    const session = makeSession(async () => ({ ok: true, sessions: daemon }));

    const outcome = await session.send('go', { phaseId: 'p1' });

    expect(outcome.text).toBe('ok');
    expect(session.currentMode).toBe('daemon');
    expect(tracer.run(runId)!.mode).toBe('daemon');
    expect(tracer.agentSessions(runId)[0]!.mode).toBe('daemon');
    await session.close();
  });

  it('fails the turn when the daemon cannot be reached, rather than degrading', async () => {
    beginRun();
    const session = makeSession(async () => ({ ok: false, reason: 'connect_failed: no daemon' }));

    await expect(session.send('go', { phaseId: 'p1' })).rejects.toThrow(
      /daemon unavailable: connect_failed: no daemon/,
    );
    // The run never claims a transport it did not get onto.
    expect(tracer.run(runId)!.mode).toBe('daemon');
    await session.close();
  });

  it('fails the turn when reaching the daemon throws', async () => {
    beginRun();
    const session = makeSession(async () => {
      throw new Error('websocket refused');
    });

    await expect(session.send('go', { phaseId: 'p1' })).rejects.toThrow(
      /daemon unavailable: websocket refused/,
    );
    await session.close();
  });

  it('fails the turn when the daemon session will not start', async () => {
    beginRun();
    const daemon = new ScriptedAgent(['ok']);
    // A facade whose create always refuses is how a daemon that is up but
    // unable to open a session presents itself.
    const refusing = Object.create(daemon) as ScriptedAgent;
    refusing.create = async () => {
      throw new Error('session limit reached');
    };
    const session = makeSession(async () => ({ ok: true, sessions: refusing }));

    await expect(session.send('go', { phaseId: 'p1' })).rejects.toThrow(
      /daemon session start failed: session limit reached/,
    );
    await session.close();
  });

  it('surfaces a mid-turn transport failure instead of retrying it elsewhere', async () => {
    beginRun();
    const daemon = new ScriptedAgent(['never reached'], [], [], { dieOnTurns: [0] });
    const session = makeSession(async () => ({ ok: true, sessions: daemon }));

    await expect(session.send('go', { phaseId: 'p1' })).rejects.toThrow(/died mid-turn/);
    // No fallback event exists to be written, because no fallback exists.
    const names = tracer.eventsAfter(runId, 0).map((e) => e.name);
    expect(names.some((n) => /fallback/.test(n))).toBe(false);
    await session.close();
  });

  it('keeps one daemon session across turns rather than reopening per turn', async () => {
    beginRun();
    const daemon = new ScriptedAgent(['one', 'two']);
    const session = makeSession(async () => ({ ok: true, sessions: daemon }));

    await session.send('first', { phaseId: 'p1' });
    await session.send('second', { phaseId: 'p1' });

    expect(daemon.sessionOpens).toBe(1);
    expect(daemon.turnRequests.map((t) => t.text)).toEqual(['first', 'second']);
    await session.close();
  });

  it('refuses to answer a turn once the run has been killed', async () => {
    beginRun();
    const daemon = new ScriptedAgent(['ok']);
    const session = makeSession(async () => ({ ok: true, sessions: daemon }));

    session.kill();
    await expect(session.send('go', { phaseId: 'p1' })).rejects.toThrow(/the run was killed/);
    // A killed run must not spend a turn: that is money, and a result the run
    // could still have been settled on.
    expect(daemon.turnRequests).toHaveLength(0);
    await session.close();
  });
});
