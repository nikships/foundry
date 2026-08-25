/**
 * Durable phase-start checkpoints. Real git repos, real SQLite, the scripted
 * transport standing in for a model — never a network and never a mocked git.
 *
 * What these pin down is the property the in-memory rewinder cannot give: a
 * record written *before* the phase started that is still readable by a process
 * that did not write it.
 */

import { execFileSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import { capturePhaseStart } from '../../../src/main/engine/checkpoint.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import type {
  AgentDef,
  CommandSpec,
  PhaseCheckpointPayload,
  PhaseDef,
  PipelineDef,
  ProjectDef,
} from '../../../src/shared/types.js';
import { ScriptedAgent } from '../../helpers/scripted-transport.js';
import { tempDir } from '../../helpers/tmp.js';

function sh(cwd: string, argv: string[]): string {
  try {
    return execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: 'utf8' });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? '';
    throw new Error(`${argv.join(' ')} failed in ${cwd}: ${stderr.trim() || String(e)}`);
  }
}

function scratchRepo(): string {
  const dir = tempDir('foundry-checkpoint-');
  sh(dir, ['git', 'init', '-q', '-b', 'main']);
  sh(dir, ['git', 'config', 'user.email', 'test@foundry.local']);
  sh(dir, ['git', 'config', 'user.name', 'Foundry Test']);
  writeFileSync(join(dir, 'README.md'), '# scratch\n');
  writeFileSync(join(dir, 'tracked.txt'), 'committed\n');
  sh(dir, ['git', 'add', '-A']);
  sh(dir, ['git', 'commit', '-qm', 'initial']);
  return dir;
}

const buildAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
  name: 'builder',
  purpose: 'build things',
  model: 'scripted/model',
  reasoningEffort: 'medium',
  systemPrompt: 'You build.',
  userPrompt: 'Build: {{request}}',
  writes: null,
  envelope: 'build',
  color: '#5ad2dd',
  ...over,
});

function agentPhase(name: string, over: Partial<PhaseDef> = {}): PhaseDef {
  return {
    name,
    kind: 'agent',
    agent: 'builder',
    description: over.description ?? name,
    envelope: 'build',
    prompt: { inputs: ['request'] },
    ...over,
  };
}

function codePhase(name: string, command: CommandSpec, over: Partial<PhaseDef> = {}): PhaseDef {
  return { name, kind: 'code', description: over.description ?? name, command, ...over };
}

function pipe(phases: PhaseDef[], over: Partial<PipelineDef> = {}): PipelineDef {
  return {
    id: 'p',
    name: 'p',
    description: 'checkpoint pipeline',
    acceptance: { kind: 'all_phases_pass' },
    phases,
    ...over,
  };
}

function buildEnvelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'success',
    summary: 'built it',
    artifacts: [],
    commit_message: 'add a thing',
    notes_for_next_agent: '',
    ...over,
  });
}

interface Harness {
  repo: string;
  support: string;
  db: Db;
  tracer: Tracer;
  project: ProjectDef;
}

let h: Harness;

beforeEach(() => {
  const repo = scratchRepo();
  const support = tempDir('foundry-checkpoint-support-');
  const db = openDb(projectDbPath(support, repo));
  h = {
    repo,
    support,
    db,
    tracer: new Tracer(db, projectRunsDir(support, repo)),
    project: { ...defaultProject(repo), mergePolicy: 'never' },
  };
});

interface RunInput {
  pipeline: PipelineDef;
  agents?: AgentDef[];
  scripted?: ScriptedAgent;
  project?: Partial<ProjectDef>;
  landing?: ExecutorDeps['landing'];
}

async function run(input: RunInput): Promise<{ status: string; runId: string }> {
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  const scripted = input.scripted ?? new ScriptedAgent([buildEnvelope()]);
  const executor = new Executor({
    tracer: h.tracer,
    envelopeRetries: 2,
    gateRetries: 2,
    compactionThreshold: 0.8,
    rewindAfterCorrections: 2,
    healing: null,
    supportDir: h.support,
    transport: (req) => scripted.transport(req),
    agents: input.agents ?? [buildAgent()],
    envelopeDefs: [],
    project: { ...h.project, ...input.project },
    pipeline: input.pipeline,
    request: 'do the thing',
    runId,
    engineer: 'test',
    askHuman: async () => ({ approve: true }),
    landing: input.landing,
  });
  const outcome = await executor.run();
  return { status: outcome.status, runId };
}

/** Reopens the same database and run directory, as a relaunched app would. */
function reopenedTracer(): Tracer {
  return new Tracer(openDb(projectDbPath(h.support, h.repo)), projectRunsDir(h.support, h.repo));
}

describe('checkpoints a run writes', () => {
  it('records one before every phase starts, in phase order', async () => {
    const scripted = new ScriptedAgent([buildEnvelope(), buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([
        agentPhase('plan', { description: 'Plan the change.' }),
        codePhase('touch', { argv: ['sh', '-c', 'echo hi > made.txt'] }),
        agentPhase('build', { description: 'Build the change.' }),
      ]),
    });

    expect(outcome.status).toBe('accepted');
    const checkpoints = h.tracer.phaseCheckpoints(outcome.runId);
    expect(checkpoints.map((c) => c.phaseName)).toEqual(['plan', 'touch', 'build']);
    expect(checkpoints.map((c) => c.generation)).toEqual([1, 1, 1]);
    for (const checkpoint of checkpoints) {
      expect(checkpoint.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(checkpoint.createdAt).toBeTruthy();
      expect(checkpoint.exactRestorePossible).toBe(true);
    }
  });

  it('names the phase’s appointed model and its agent', async () => {
    const outcome = await run({
      pipeline: pipe([agentPhase('build', { model: 'anthropic/opus' })]),
    });
    const [checkpoint] = h.tracer.phaseCheckpoints(outcome.runId);
    expect(checkpoint!.model).toBe('anthropic/opus');
    expect(checkpoint!.agent).toBe('builder');
  });

  it('falls back to the roster model when the phase appoints none', async () => {
    const outcome = await run({ pipeline: pipe([agentPhase('build')]) });
    expect(h.tracer.phaseCheckpoints(outcome.runId)[0]!.model).toBe('scripted/model');
  });

  it('leaves the model null for a code phase, which has no agent', async () => {
    const outcome = await run({
      pipeline: pipe([codePhase('noop', { argv: ['sh', '-c', 'true'] })]),
    });
    const [checkpoint] = h.tracer.phaseCheckpoints(outcome.runId);
    expect(checkpoint!.model).toBeNull();
    expect(checkpoint!.agent).toBeNull();
    expect(checkpoint!.phaseKind).toBe('code');
  });

  it('carries the session leaf and the envelopes already in effect', async () => {
    // The planner writes the handoff file itself, as an agent with a handoff
    // write boundary does; the engine only records that it was there.
    const scripted = new ScriptedAgent(
      [buildEnvelope(), buildEnvelope()],
      ['.foundry-handoff/plan.json'],
    );
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('plan'), agentPhase('build')]),
    });
    const [first, second] = h.tracer.phaseCheckpoints(outcome.runId);

    // Nothing has been sent when the first phase starts, so there is no leaf
    // to name — and inventing one would misdescribe the anchor.
    expect(first!.leafMessageId).toBeNull();
    expect(second!.leafMessageId).toBe('u0');
    expect(second!.agentSessionId).toBeTruthy();

    const loaded = h.tracer.phaseCheckpoint(second!.checkpointId)!;
    expect(loaded.payload.envelopePhases).toEqual(['plan']);
    expect(loaded.payload.handoffFiles).toEqual([join('.foundry-handoff', 'plan.json')]);
  });
});

describe('a checkpoint after the process that wrote it is gone', () => {
  it('reads back intact from a fresh Tracer on the same database', async () => {
    const scripted = new ScriptedAgent([buildEnvelope()], ['fresh.txt']);
    const outcome = await run({ pipeline: pipe([agentPhase('build')]), scripted });

    const written = h.tracer.phaseCheckpoints(outcome.runId);
    const reopened = reopenedTracer();
    const rows = reopened.phaseCheckpoints(outcome.runId);
    expect(rows).toEqual(written);

    const loaded = reopened.phaseCheckpoint(rows[0]!.checkpointId)!;
    expect(loaded.payload.phaseName).toBe('build');
    expect(loaded.payload.headSha).toBe(rows[0]!.headSha);
    expect(loaded.payload.worktreePath).toBe(h.tracer.run(outcome.runId)!.worktreePath);
  });

  it('keeps issuing change ids above what the reopened database already holds', async () => {
    const outcome = await run({ pipeline: pipe([agentPhase('build')]) });
    const highest = Math.max(
      ...h.tracer.phaseCheckpoints(outcome.runId).map((c) => c.changeId),
      ...h.tracer.eventsAfter(outcome.runId, 0, 1000).map((e) => e.changeId),
    );

    const reopened = reopenedTracer();
    const eventId = reopened.event({ runId: outcome.runId, type: 'log', name: 'after' });
    const after = reopened
      .eventsAfter(outcome.runId, 0, 1000)
      .find((e) => e.eventId === eventId)!.changeId;
    expect(after).toBeGreaterThan(highest);
  });
});

describe('what a checkpoint captured', () => {
  it('holds the phase-start bytes, not what the phase went on to write', async () => {
    // The code phase dirties a tracked file; the checkpoint the agent phase
    // records must hold that content, and the agent then overwrites it.
    const scripted = new ScriptedAgent([buildEnvelope()], ['tracked.txt']);
    const outcome = await run({
      scripted,
      pipeline: pipe([
        codePhase('dirty', { argv: ['sh', '-c', 'printf "phase-start\\n" > tracked.txt'] }),
        agentPhase('build'),
      ]),
    });

    const build = h.tracer.phaseCheckpoints(outcome.runId).find((c) => c.phaseName === 'build')!;
    const payload = h.tracer.phaseCheckpoint(build.checkpointId)!.payload;
    const tracked = payload.files.find((f) => f.path === 'tracked.txt')!;
    expect(tracked.state).toBe('modified');
    expect(tracked.content).toBe('phase-start\n');
    expect(tracked.encoding).toBe('utf8');

    // The worktree has moved on; the checkpoint has not.
    const worktree = h.tracer.run(outcome.runId)!.worktreePath!;
    expect(readFileSync(join(worktree, 'tracked.txt'), 'utf8')).not.toBe('phase-start\n');
  });

  it('records an untracked file’s content, which lives nowhere else', async () => {
    const scripted = new ScriptedAgent([buildEnvelope(), buildEnvelope()], ['new-file.txt']);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('build'), agentPhase('review')]),
    });

    const review = h.tracer.phaseCheckpoints(outcome.runId).find((c) => c.phaseName === 'review')!;
    const payload = h.tracer.phaseCheckpoint(review.checkpointId)!.payload;
    const created = payload.files.find((f) => f.path === 'new-file.txt')!;
    expect(created.state).toBe('untracked');
    expect(created.content).toBe('written by the scripted agent\n');
    expect(review.untrackedCount).toBeGreaterThanOrEqual(1);
  });

  it('names a tracked deletion without content, because git still carries it', async () => {
    const outcome = await run({
      pipeline: pipe([
        codePhase('remove', { argv: ['sh', '-c', 'rm tracked.txt'] }),
        agentPhase('build'),
      ]),
    });
    const build = h.tracer.phaseCheckpoints(outcome.runId).find((c) => c.phaseName === 'build')!;
    const payload = h.tracer.phaseCheckpoint(build.checkpointId)!.payload;
    const deleted = payload.files.find((f) => f.path === 'tracked.txt')!;
    expect(deleted.state).toBe('deleted');
    expect(deleted.content).toBeUndefined();
    expect(deleted.omitted).toBeUndefined();
    expect(build.exactRestorePossible).toBe(true);
  });
});

describe('a second attempt at the same phase', () => {
  it('opens a new generation and leaves the first checkpoint intact', async () => {
    // Passes only once the builder has written fix.txt, so the first pass
    // routes feedback back into `build` and re-enters it.
    writeFileSync(join(h.repo, 'check.sh'), '#!/bin/sh\ntest -f fix.txt\n');
    chmodSync(join(h.repo, 'check.sh'), 0o755);
    sh(h.repo, ['git', 'add', '-A']);
    sh(h.repo, ['git', 'commit', '-qm', 'add check']);

    const scripted = new ScriptedAgent([buildEnvelope(), buildEnvelope()], [null, 'fix.txt']);
    const outcome = await run({
      scripted,
      project: { commands: [{ name: 'test', argv: ['./check.sh'] }] },
      pipeline: pipe(
        [
          agentPhase('build'),
          codePhase('test', { ref: 'test' }, { feedbackTo: 'build', feedbackRetries: 2 }),
        ],
        { acceptance: { kind: 'phase_flag', phase: 'test', flag: 'passed' } },
      ),
    });

    expect(outcome.status).toBe('accepted');
    const builds = h.tracer.phaseCheckpoints(outcome.runId).filter((c) => c.phaseName === 'build');
    expect(builds.map((c) => c.generation)).toEqual([1, 2]);
    expect(builds[0]!.checkpointId).not.toBe(builds[1]!.checkpointId);
    // Both payloads are still on disk: the retry added a record, it did not
    // replace one.
    expect(h.tracer.phaseCheckpoint(builds[0]!.checkpointId)).not.toBeNull();
    expect(h.tracer.phaseCheckpoint(builds[1]!.checkpointId)).not.toBeNull();
    expect(h.tracer.phaseCheckpoint(builds[0]!.checkpointId)!.payload.generation).toBe(1);

    // The first attempt began on a clean tree; the second began after the
    // first attempt's work, which is the difference the generations record.
    const first = h.tracer.phaseCheckpoint(builds[0]!.checkpointId)!.payload;
    const second = h.tracer.phaseCheckpoint(builds[1]!.checkpointId)!.payload;
    expect(first.envelopePhases).toEqual([]);
    expect(second.envelopePhases).toContain('build');
    expect(second.leafMessageId).toBe('u0');
  });
});

describe('a run that has no checkpoints', () => {
  it('reads back as empty rather than as a fabricated entry', () => {
    h.tracer.startRun({
      runId: 'run_before_checkpoints',
      projectId: 'proj',
      pipeline: pipe([]),
      request: 'x',
      engineer: 'test',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    expect(h.tracer.phaseCheckpoints('run_before_checkpoints')).toEqual([]);
    expect(h.tracer.phaseCheckpoints('run_that_never_existed')).toEqual([]);
    expect(h.tracer.phaseCheckpoint('cp_nothing')).toBeNull();
  });
});

describe('the size cap', () => {
  it('flags the row when a file’s content did not fit', async () => {
    const cwd = scratchRepo();
    writeFileSync(join(cwd, 'tracked.txt'), 'x'.repeat(4096));
    writeFileSync(join(cwd, 'small.txt'), 'ok\n');

    const capture = await capturePhaseStart({
      cwd,
      handoffDir: '.foundry-handoff',
      limits: { fileMaxBytes: 16, totalMaxBytes: 1024 },
    });
    expect(capture.truncated).toBe(true);
    expect(capture.omittedPaths).toEqual(['tracked.txt']);

    const big = capture.files.find((f) => f.path === 'tracked.txt')!;
    expect(big.content).toBeUndefined();
    expect(big.omitted).toBe('too_large');
    // A hash without content can detect drift but cannot undo it, which is
    // exactly why the row has to say so.
    expect(big.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(capture.files.find((f) => f.path === 'small.txt')!.content).toBe('ok\n');

    h.tracer.startRun({
      runId: 'run_truncated',
      projectId: 'proj',
      pipeline: pipe([]),
      request: 'x',
      engineer: 'test',
      worktreePath: cwd,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    const phaseId = h.tracer.queuePhase({
      runId: 'run_truncated',
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'd',
    });
    const row = h.tracer.recordPhaseCheckpoint({
      runId: 'run_truncated',
      phaseId,
      phaseName: 'build',
      phaseKind: 'agent',
      headSha: capture.headSha,
      branch: null,
      worktreePath: cwd,
      model: 'scripted/model',
      agent: 'builder',
      agentSessionId: null,
      leafMessageId: null,
      handoffFiles: capture.handoffFiles,
      envelopePhases: [],
      files: capture.files,
      truncated: capture.truncated,
      omittedPaths: capture.omittedPaths,
      bytesStored: capture.bytesStored,
    });

    expect(row.truncated).toBe(true);
    expect(row.exactRestorePossible).toBe(false);
    expect(h.tracer.phaseCheckpoint(row.checkpointId)!.payload.omittedPaths).toEqual([
      'tracked.txt',
    ]);
  });

  it('stops storing content once the whole-checkpoint budget is spent', async () => {
    const cwd = scratchRepo();
    writeFileSync(join(cwd, 'a.txt'), 'a'.repeat(64));
    writeFileSync(join(cwd, 'b.txt'), 'b'.repeat(64));

    const capture = await capturePhaseStart({
      cwd,
      handoffDir: '.foundry-handoff',
      limits: { fileMaxBytes: 1024, totalMaxBytes: 100 },
    });
    const stored = capture.files.filter((f) => f.content !== undefined);
    expect(stored).toHaveLength(1);
    expect(capture.bytesStored).toBe(64);
    expect(capture.files.find((f) => f.content === undefined)!.omitted).toBe('budget_exhausted');
    expect(capture.truncated).toBe(true);
  });

  it('keeps a binary file base64 rather than mangling it through utf8', async () => {
    const cwd = scratchRepo();
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x10, 0x80]);
    writeFileSync(join(cwd, 'blob.bin'), bytes);

    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });
    const blob = capture.files.find((f) => f.path === 'blob.bin')!;
    expect(blob.encoding).toBe('base64');
    expect(Buffer.from(blob.content!, 'base64')).toEqual(bytes);
  });
});

describe('a checkpoint payload that is no longer on disk', () => {
  it('reads as absent rather than handing back a row with no contents', async () => {
    const outcome = await run({ pipeline: pipe([agentPhase('build')]) });
    const [checkpoint] = h.tracer.phaseCheckpoints(outcome.runId);
    // The row is the index; the payload is the record. A reader must not be
    // told a checkpoint is loadable when its contents are gone.
    h.tracer.writeRunFile(outcome.runId, checkpoint!.payloadPath, 'not json');
    expect(h.tracer.phaseCheckpoint(checkpoint!.checkpointId)).toBeNull();
    expect(h.tracer.phaseCheckpoints(outcome.runId)).toHaveLength(1);
  });
});

describe('a payload path a phase name cannot break out of', () => {
  it('sanitises the name into the run’s own checkpoints directory', () => {
    h.tracer.startRun({
      runId: 'run_paths',
      projectId: 'proj',
      pipeline: pipe([]),
      request: 'x',
      engineer: 'test',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    const phaseId = h.tracer.queuePhase({
      runId: 'run_paths',
      seq: 0,
      name: '../../escape me',
      kind: 'code',
      owner: 'code',
      description: 'd',
    });
    const row = h.tracer.recordPhaseCheckpoint({
      runId: 'run_paths',
      phaseId,
      phaseName: '../../escape me',
      phaseKind: 'code',
      headSha: 'deadbeef',
      branch: null,
      worktreePath: '/tmp/nowhere',
      model: null,
      agent: null,
      agentSessionId: null,
      leafMessageId: null,
      handoffFiles: [],
      envelopePhases: [],
      files: [],
      truncated: false,
      omittedPaths: [],
      bytesStored: 0,
    });
    expect(row.payloadPath.startsWith('checkpoints/')).toBe(true);
    expect(row.payloadPath).not.toContain('..');
    const payload = h.tracer.readRunJson<PhaseCheckpointPayload>('run_paths', row.payloadPath);
    expect(payload!.phaseName).toBe('../../escape me');
  });
});
