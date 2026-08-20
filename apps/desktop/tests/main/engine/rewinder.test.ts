/**
 * PhaseRewinder owns correction rollback: snapshot, rewind, restore,
 * re-snapshot. Real git repos; the session is either a fake or the production
 * AgentSession over ScriptedAgent — never a network or a model.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { PhaseRewinder, type RewindableSession } from '../../../src/main/engine/rewinder.js';
import { AgentSession, type TransportRequest } from '../../../src/main/pi/session.js';
import type { AgentTransport, RewindOutcome } from '../../../src/main/pi/transport.js';
import { openDb, projectDbPath, projectRunsDir } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import type { AgentDef } from '../../../src/shared/types.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';
import { tempDir } from '../../helpers/tmp.js';

function sh(cwd: string, argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
}

function tempRepo(): string {
  const dir = tempDir('foundry-rewinder-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# rewinder\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

const PHASE_START = 'phase-start content\n';

class FakeSession implements RewindableSession {
  canRewind = true;
  lastUserMessageId: string | null = 'u0';
  rewindResult: RewindOutcome | null = {
    restoredCount: 1,
    deletedCount: 0,
    failedRestoreCount: 0,
    failedDeleteCount: 0,
  };
  readonly calls: { messageId: string; paths: string[] }[] = [];

  async rewind(input: { messageId: string; paths: string[] }): Promise<RewindOutcome | null> {
    this.calls.push(input);
    return this.rewindResult;
  }
}

describe('PhaseRewinder policy', () => {
  it('does nothing below the correction threshold', async () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const session = new FakeSession();
    const rewinder = await PhaseRewinder.create(cwd, session, 2);

    expect(await rewinder.rewindIfDue(1)).toBeNull();
    expect(session.calls).toEqual([]);
  });

  it('does nothing when rewindAfterCorrections is 0', async () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const session = new FakeSession();
    const rewinder = await PhaseRewinder.create(cwd, session, 0);

    expect(await rewinder.rewindIfDue(4)).toBeNull();
    expect(session.calls).toEqual([]);
  });

  it('does nothing when the session cannot rewind', async () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const session = new FakeSession();
    session.canRewind = false;
    const rewinder = await PhaseRewinder.create(cwd, session, 1);

    expect(await rewinder.rewindIfDue(1)).toBeNull();
    expect(session.calls).toEqual([]);
  });

  it('does nothing when no message id is available', async () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const session = new FakeSession();
    session.lastUserMessageId = null;
    const rewinder = await PhaseRewinder.create(cwd, session, 1);

    expect(await rewinder.rewindIfDue(1)).toBeNull();
    expect(session.calls).toEqual([]);
  });

  it('asks the session to rewind with the dirty-at-start paths', async () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const session = new FakeSession();
    const rewinder = await PhaseRewinder.create(cwd, session, 1);
    rewinder.noteAnchor();

    const trace = await rewinder.rewindIfDue(1);
    expect(trace).toMatchObject({ restoredCount: 1, deletedCount: 0 });
    expect(session.calls).toHaveLength(1);
    expect(session.calls[0]!.messageId).toBe('u0');
    expect(session.calls[0]!.paths).toContain('watched.txt');
    expect(session.calls[0]!.paths).toContain(join(cwd, 'watched.txt').replace(/\\/g, '/'));
  });

  it('falls back when the session refuses the rewind', async () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const session = new FakeSession();
    session.rewindResult = null;
    const rewinder = await PhaseRewinder.create(cwd, session, 1);
    const before = rewinder.baseline();

    expect(await rewinder.rewindIfDue(1)).toBeNull();
    expect(rewinder.baseline()).toBe(before);
  });

  it('pins the first user-message id and ignores later ones', async () => {
    const cwd = tempRepo();
    const session = new FakeSession();
    const rewinder = await PhaseRewinder.create(cwd, session, 1);

    session.lastUserMessageId = 'u0';
    rewinder.noteAnchor();
    session.lastUserMessageId = 'u1';
    rewinder.noteAnchor();

    await rewinder.rewindIfDue(1);
    expect(session.calls[0]!.messageId).toBe('u0');
  });
});

describe('PhaseRewinder worktree restore', () => {
  it('re-snapshots the baseline after a successful rewind', async () => {
    const cwd = tempRepo();
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const session = new FakeSession();
    const rewinder = await PhaseRewinder.create(cwd, session, 1);
    expect(rewinder.baseline().paths.has('watched.txt')).toBe(true);

    writeFileSync(join(cwd, 'new.txt'), 'created during the failed turn\n');
    const trace = await rewinder.rewindIfDue(1);

    expect(trace?.worktreeCleanedCount).toBe(1);
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false);
    expect(rewinder.baseline().paths.has('new.txt')).toBe(false);
    expect(rewinder.baseline().paths.has('watched.txt')).toBe(true);
  });

  it('checks out a clean-tree tracked deletion the transport cannot see', async () => {
    const cwd = tempRepo();
    const kept = 'keep me\n';
    writeFileSync(join(cwd, 'old.txt'), kept);
    sh(cwd, ['git', 'add', '-A']);
    sh(cwd, ['git', 'commit', '-qm', 'add old']);

    const session = new FakeSession();
    session.rewindResult = {
      restoredCount: 0,
      deletedCount: 1,
      failedRestoreCount: 0,
      failedDeleteCount: 0,
    };
    const rewinder = await PhaseRewinder.create(cwd, session, 1);
    expect(rewinder.baseline().paths.has('old.txt')).toBe(false);

    unlinkSync(join(cwd, 'old.txt'));
    writeFileSync(join(cwd, 'new.txt'), 'scratch\n');
    const trace = await rewinder.rewindIfDue(1);

    expect(trace?.worktreeRestoredCount).toBe(1);
    expect(trace?.worktreeCleanedCount).toBe(1);
    expect(readFileSync(join(cwd, 'old.txt'), 'utf8')).toBe(kept);
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false);
  });
});

const agent: AgentDef = {
  name: 'builder',
  purpose: 'build things',
  model: 'scripted',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build.',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
};

describe('PhaseRewinder with ScriptedAgent', () => {
  let support: string;
  let tracer: Tracer;
  let runId: string;
  let phaseId: string;
  let cwd: string;

  beforeEach(() => {
    support = tempDir('foundry-rewinder-support-');
    cwd = tempRepo();
    const db = openDb(projectDbPath(support, 'proj'));
    tracer = new Tracer(db, projectRunsDir(support, 'proj'));
    runId = `run_${Math.random().toString(36).slice(2, 8)}`;
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
      worktreePath: cwd,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    phaseId = tracer.openPhase({
      runId,
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: agent.name,
      description: 'build',
    });
  });

  function sessionOn(scripted: ScriptedAgent): AgentSession {
    return new AgentSession(agent, {
      runId,
      worktree: cwd,
      turnTimeoutMs: 5_000,
      tracer,
      protectedPaths: [],
      transport: (req: TransportRequest): AgentTransport => scripted.transport(req),
    });
  }

  it('restores phase-start file bytes before the next turn starts', async () => {
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const scripted = new ScriptedAgent(['first', 'second'], ['watched.txt', null], [], {
      rewindFiles: { 'watched.txt': PHASE_START },
    });
    const session = sessionOn(scripted);
    const rewinder = await PhaseRewinder.create(cwd, session, 1);

    await session.send('one', { phaseId });
    rewinder.noteAnchor();
    expect(readFileSync(join(cwd, 'watched.txt'), 'utf8')).toBe('written by the scripted agent\n');

    const trace = await rewinder.rewindIfDue(1);
    expect(trace?.restoredCount).toBe(1);
    await session.send('two', { phaseId });

    expect(scripted.contentAtTurns.map((s) => s.turn)).toEqual([0, 1]);
    expect(scripted.contentAtTurns[0]!.files['watched.txt']).toBe(PHASE_START);
    expect(scripted.contentAtTurns[1]!.files['watched.txt']).toBe(PHASE_START);
    expect(scripted.wire).toContain('get_rewind_info');
    expect(scripted.wire).toContain('rewind');
    await session.close();
  });

  it('matches a transport that reports the dirty file as an absolute path', async () => {
    writeFileSync(join(cwd, 'watched.txt'), PHASE_START);
    const abs = join(cwd, 'watched.txt');
    const scripted = new ScriptedAgent(['first'], ['watched.txt'], [], {
      rewindFiles: { [abs]: PHASE_START },
    });
    const session = sessionOn(scripted);
    const rewinder = await PhaseRewinder.create(cwd, session, 1);

    await session.send('one', { phaseId });
    rewinder.noteAnchor();
    const trace = await rewinder.rewindIfDue(1);

    expect(trace?.restoredCount).toBe(1);
    expect(readFileSync(join(cwd, 'watched.txt'), 'utf8')).toBe(PHASE_START);
    await session.close();
  });
});
