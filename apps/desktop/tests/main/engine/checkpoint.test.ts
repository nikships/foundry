/**
 * Durable phase-start checkpoints. Real git repos, real SQLite, the scripted
 * transport standing in for a model — never a network and never a mocked git.
 *
 * What these pin down is the property the in-memory rewinder cannot give: a
 * record written *before* the phase started that is still readable by a process
 * that did not write it.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../../../src/main/trace/db.js';
import { Tracer, type PhaseCheckpointInput } from '../../../src/main/trace/tracer.js';
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
    landing: input.landing,
  });
  const outcome = await executor.run();
  return { status: outcome.status, runId };
}

/** Reopens the same database and run directory, as a relaunched app would. */
function reopenedTracer(): Tracer {
  return new Tracer(openDb(projectDbPath(h.support, h.repo)), projectRunsDir(h.support, h.repo));
}

/** A minimal well-formed checkpoint, for the paths that record one directly. */
function checkpointInput(
  runId: string,
  phaseId: string,
  over: Partial<PhaseCheckpointInput> = {},
): PhaseCheckpointInput {
  return {
    runId,
    phaseId,
    phaseName: 'build',
    phaseKind: 'agent',
    headSha: 'a'.repeat(40),
    branch: null,
    worktreePath: h.repo,
    isolated: true,
    model: 'scripted/model',
    agent: 'builder',
    agentSessionId: null,
    leafMessageId: null,
    handoffFiles: [],
    envelopePhases: [],
    files: [],
    truncated: false,
    omittedPaths: [],
    bytesStored: 0,
    ...over,
  };
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

  /**
   * The seed has to be the max across `events` *and* `phase_checkpoints`. A
   * completed run always emits its finish events after the last checkpoint, so
   * asserting against a finished run would pass with an events-only seed too —
   * the checkpoint has to be the last write for the case to bite.
   */
  it('reissues no id when a checkpoint, not an event, holds the highest', () => {
    const dbPath = projectDbPath(h.support, h.repo);
    const dir = projectRunsDir(h.support, h.repo);
    const first = new Tracer(openDb(dbPath), dir);
    first.startRun({
      runId: 'run_cp_last',
      projectId: 'proj',
      pipeline: pipe([]),
      request: 'x',
      engineer: 'test',
      worktreePath: h.repo,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    const phaseId = first.queuePhase({
      runId: 'run_cp_last',
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'd',
    });
    // Nothing after this write, so MAX(events.change_id) is now behind
    // MAX(phase_checkpoints.change_id).
    const checkpoint = first.recordPhaseCheckpoint(checkpointInput('run_cp_last', phaseId));
    const eventMax = Math.max(
      0,
      ...first.eventsAfter('run_cp_last', 0, 1000).map((e) => e.changeId),
    );
    expect(checkpoint.changeId).toBeGreaterThan(eventMax);

    const reopened = new Tracer(openDb(dbPath), dir);
    const eventId = reopened.event({ runId: 'run_cp_last', type: 'log', name: 'after' });
    const after = reopened
      .eventsAfter('run_cp_last', 0, 1000)
      .find((e) => e.eventId === eventId)!.changeId;
    // An events-only seed would have handed this event the checkpoint's id,
    // and the cursor would serve one of the two and never the other.
    expect(after).toBeGreaterThan(checkpoint.changeId);
  });

  it('starts a fresh database at 1 rather than skipping ids', () => {
    const support = tempDir('foundry-checkpoint-empty-');
    const tracer = new Tracer(
      openDb(projectDbPath(support, 'proj')),
      projectRunsDir(support, 'proj'),
    );
    tracer.startRun({
      runId: 'run_empty',
      projectId: 'proj',
      pipeline: pipe([]),
      request: 'x',
      engineer: 'test',
      worktreePath: null,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    const eventId = tracer.event({ runId: 'run_empty', type: 'log', name: 'first' });
    const first = tracer.eventsAfter('run_empty', 0, 1000).find((e) => e.eventId === eventId)!;
    expect(first.changeId).toBe(1);
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

  it('names a tracked deletion without content, since absence is what it restores', async () => {
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

describe('a file the capture could not read', () => {
  it('flags the row rather than passing the gap off as captured content', async () => {
    const cwd = scratchRepo();
    // A dangling symlink is the deterministic unreadable case: git reports it
    // as an untracked path, and both the stat and the read resolve through it
    // to a target that is not there.
    symlinkSync('/nonexistent/target', join(cwd, 'dangling'));
    writeFileSync(join(cwd, 'small.txt'), 'ok\n');

    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });
    expect(capture.truncated).toBe(true);
    expect(capture.omittedPaths).toEqual(['dangling']);

    const gap = capture.files.find((f) => f.path === 'dangling')!;
    expect(gap.content).toBeUndefined();
    expect(gap.omitted).toBe('unreadable');
    // No hash either: there are no bytes to hash, and a hash of nothing would
    // read as a hash of an empty file.
    expect(gap.contentHash).toBe('');
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
    const row = h.tracer.recordPhaseCheckpoint(
      checkpointInput('run_truncated', phaseId, {
        headSha: capture.headSha,
        worktreePath: cwd,
        handoffFiles: capture.handoffFiles,
        files: capture.files,
        truncated: capture.truncated,
        omittedPaths: capture.omittedPaths,
        bytesStored: capture.bytesStored,
      }),
    );

    expect(row.truncated).toBe(true);
    expect(row.exactRestorePossible).toBe(false);
    expect(h.tracer.phaseCheckpoint(row.checkpointId)!.payload.omittedPaths).toEqual(['dangling']);
  });

  it('records a directory git collapsed into one entry without trying to read it', async () => {
    const cwd = scratchRepo();
    // A submodule-like directory git reports as a single untracked entry:
    // reading it would throw, and naming it is still the useful answer.
    mkdirSync(join(cwd, 'nested'));
    sh(cwd, ['git', 'init', '-q', join(cwd, 'nested')]);
    writeFileSync(join(cwd, 'nested', 'inner.txt'), 'inner\n');

    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });
    const dir = capture.files.find((f) => f.path.startsWith('nested'))!;
    expect(dir.omitted).toBe('unreadable');
    expect(dir.content).toBeUndefined();
    expect(capture.truncated).toBe(true);
  });
});

describe('a file bigger than the caps that used to exist', () => {
  it('is captured in full rather than omitted for its size', async () => {
    const cwd = scratchRepo();
    // Past the retired 1 MiB per-file bound, and the pair past nothing at all:
    // the capture is no longer allowed to trade a path's only surviving copy
    // for the bytes it would have saved.
    const big = 'x'.repeat(4 * 1024 * 1024);
    writeFileSync(join(cwd, 'tracked.txt'), big);
    writeFileSync(join(cwd, 'also-big.txt'), big);

    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });
    expect(capture.truncated).toBe(false);
    expect(capture.omittedPaths).toEqual([]);
    for (const path of ['tracked.txt', 'also-big.txt']) {
      const file = capture.files.find((f) => f.path === path)!;
      expect(file.omitted).toBeUndefined();
      expect(file.content).toBe(big);
      expect(file.size).toBe(big.length);
      expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(capture.bytesStored).toBe(big.length * 2);
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

/**
 * The dirty set has to be enumerated in full. `runCommand` keeps only the last
 * 4000 characters of output, and roughly 110 porcelain lines exceed that, so a
 * capture built on it silently loses an arbitrary *prefix* of a busy worktree
 * while the row still claims the record is exact.
 */
describe('a worktree with more changed paths than a 4 KB tail holds', () => {
  it('captures every one of them', async () => {
    const cwd = scratchRepo();
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(cwd, `untracked-file-${i}.txt`), 'content\n');
    }
    // What git itself reports, as the independent count.
    const listing = sh(cwd, ['git', 'status', '--porcelain', '--untracked-files=all']);
    const reported = listing.split('\n').filter((line) => line.trim()).length;
    expect(reported).toBe(200);
    // Well past the old 4000-char tail, which is what makes this bite: only
    // the last ~157 of these lines would have survived it.
    expect(listing.length).toBeGreaterThan(4000);

    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });
    expect(capture.files).toHaveLength(reported);
    expect(capture.truncated).toBe(false);
    expect(capture.omittedPaths).toEqual([]);
  });

  it('refuses to claim exactness when the listing itself could not be read', async () => {
    // Not a repository, so git cannot enumerate anything. An empty file list
    // that reads as "nothing was dirty" is the one answer that must not be
    // given, because it is indistinguishable from a clean worktree.
    const cwd = tempDir('foundry-checkpoint-norepo-');
    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });
    expect(capture.files).toEqual([]);
    expect(capture.truncated).toBe(true);
  });
});

describe('a rename at phase start', () => {
  it('records the source as absent beside the destination', async () => {
    const outcome = await run({
      pipeline: pipe([
        codePhase('rename', { argv: ['git', 'mv', 'tracked.txt', 'renamed.txt'] }),
        agentPhase('build'),
      ]),
    });

    const build = h.tracer.phaseCheckpoints(outcome.runId).find((c) => c.phaseName === 'build')!;
    const payload = h.tracer.phaseCheckpoint(build.checkpointId)!.payload;

    // Both sides, or a restore from headSha resurrects the source and leaves
    // two files where phase start had one.
    const source = payload.files.find((f) => f.path === 'tracked.txt')!;
    const destination = payload.files.find((f) => f.path === 'renamed.txt')!;
    expect(source.state).toBe('deleted');
    expect(destination.state).toBe('modified');
    expect(destination.content).toBe('committed\n');
    expect(destination.renamedFrom).toBe('tracked.txt');
    expect(build.exactRestorePossible).toBe(true);
  });

  it('does not claim HEAD carries a renamed-away destination', async () => {
    // `RD a -> b` names `b`, which HEAD does not carry at all — the earlier
    // "git has the deleted path at headSha" premise was simply wrong.
    const cwd = scratchRepo();
    sh(cwd, ['git', 'mv', 'tracked.txt', 'gone.txt']);
    sh(cwd, ['rm', 'gone.txt']);
    expect(sh(cwd, ['git', 'status', '--porcelain'])).toContain('RD');

    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });
    const destination = capture.files.find((f) => f.path === 'gone.txt')!;
    const source = capture.files.find((f) => f.path === 'tracked.txt')!;
    expect(destination.state).toBe('deleted');
    expect(source.state).toBe('deleted');
    // The source is the one HEAD actually carries.
    expect(sh(cwd, ['git', 'cat-file', '-e', 'HEAD:tracked.txt'])).toBe('');
  });

  it('keeps a copy’s source, which a copy does not remove', async () => {
    const cwd = scratchRepo();
    writeFileSync(join(cwd, 'copy.txt'), 'committed\n');
    sh(cwd, ['git', 'add', '-A']);

    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });
    // Whether git reports `C` here depends on rename detection, so the
    // assertion is the invariant either way: a path still on disk is never
    // recorded as absent.
    for (const file of capture.files) {
      if (file.path === 'tracked.txt') expect(file.state).not.toBe('deleted');
    }
  });
});

describe('the truncated flag', () => {
  it('is derived from the files, not taken on trust', async () => {
    const cwd = scratchRepo();
    symlinkSync('/nonexistent/target', join(cwd, 'dangling'));
    const capture = await capturePhaseStart({ cwd, handoffDir: '.foundry-handoff' });

    h.tracer.startRun({
      runId: 'run_derived',
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
      runId: 'run_derived',
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'd',
    });
    // A caller asserting exactness over files that carry `omitted` must not be
    // believed: `exactRestorePossible` reads off this flag.
    const row = h.tracer.recordPhaseCheckpoint(
      checkpointInput('run_derived', phaseId, {
        headSha: capture.headSha,
        worktreePath: cwd,
        files: capture.files,
        truncated: false,
        omittedPaths: [],
      }),
    );
    expect(capture.files.some((f) => f.omitted)).toBe(true);
    expect(row.truncated).toBe(true);
    expect(row.exactRestorePossible).toBe(false);
    expect(h.tracer.phaseCheckpoint(row.checkpointId)!.payload.truncated).toBe(true);
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

  it('stops advertising exact restore once the payload has been pruned', async () => {
    const outcome = await run({ pipeline: pipe([agentPhase('build')]) });
    const before = h.tracer.phaseCheckpoints(outcome.runId)[0]!;
    expect(before.exactRestorePossible).toBe(true);
    expect(before.payloadPresent).toBe(true);

    rmSync(join(h.tracer.runDir(outcome.runId), before.payloadPath));

    // The list API is what split 2 enumerates from, so it is the one that must
    // not advertise a restore whose contents are gone.
    const after = h.tracer.phaseCheckpoints(outcome.runId)[0]!;
    expect(after.payloadPresent).toBe(false);
    expect(after.exactRestorePossible).toBe(false);
    expect(h.tracer.phaseCheckpoint(before.checkpointId)).toBeNull();
  });
});

describe('retention against a deleted run’s payloads', () => {
  it('takes the payloads with the rows and reports the bytes it freed', async () => {
    const scripted = new ScriptedAgent([buildEnvelope()], ['fresh.txt']);
    const outcome = await run({ pipeline: pipe([agentPhase('build')]), scripted });
    const before = h.tracer.phaseCheckpoints(outcome.runId);
    expect(before.length).toBeGreaterThan(0);
    const paths = before.map((c) => join(h.tracer.runDir(outcome.runId), c.payloadPath));
    const onDisk = paths.reduce((sum, p) => sum + statSync(p).size, 0);
    expect(onDisk).toBeGreaterThan(0);

    // A negative retention puts the cutoff in the future, so every finished
    // run is old enough.
    const swept = h.tracer.deleteRunsOlderThan(-1);
    expect(swept.runIds).toContain(outcome.runId);
    // Deleting the rows without the payloads would leave these unreachable on
    // disk while the report claimed nothing was freed.
    expect(swept.bytesReclaimed).toBe(onDisk);
    for (const path of paths) expect(existsSync(path)).toBe(false);
    expect(h.tracer.phaseCheckpoints(outcome.runId)).toEqual([]);
  });

  it('leaves a live run’s payloads and the rest of a deleted run’s directory alone', async () => {
    const finished = await run({ pipeline: pipe([agentPhase('build')]) });
    // Never finished, so retention must not touch it however old it is.
    h.tracer.startRun({
      runId: 'run_live',
      projectId: 'proj',
      pipeline: pipe([]),
      request: 'x',
      engineer: 'test',
      worktreePath: h.repo,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    const livePhase = h.tracer.queuePhase({
      runId: 'run_live',
      seq: 0,
      name: 'build',
      kind: 'agent',
      owner: 'builder',
      description: 'd',
    });
    const liveRow = h.tracer.recordPhaseCheckpoint(checkpointInput('run_live', livePhase));
    const livePayload = join(h.tracer.runDir('run_live'), liveRow.payloadPath);

    const swept = h.tracer.deleteRunsOlderThan(-1);

    expect(swept.runIds).toEqual([finished.runId]);
    expect(existsSync(livePayload)).toBe(true);
    expect(h.tracer.phaseCheckpoints('run_live')).toHaveLength(1);
    // Retention prunes checkpoint payloads, not the raw record beside them.
    expect(existsSync(join(h.tracer.runDir(finished.runId), 'request.md'))).toBe(true);
  });
});

describe('a run that is not isolated', () => {
  it('marks the checkpoint so a restore knows it targets the real checkout', async () => {
    const outcome = await run({
      pipeline: pipe([agentPhase('build')]),
      project: { isolation: false },
    });
    const [checkpoint] = h.tracer.phaseCheckpoints(outcome.runId);
    const payload = h.tracer.phaseCheckpoint(checkpoint!.checkpointId)!.payload;
    expect(payload.isolated).toBe(false);
    expect(payload.worktreePath).toBe(h.repo);
  });

  it('marks an isolated run’s checkpoint as isolated', async () => {
    const outcome = await run({ pipeline: pipe([agentPhase('build')]) });
    const [checkpoint] = h.tracer.phaseCheckpoints(outcome.runId);
    expect(h.tracer.phaseCheckpoint(checkpoint!.checkpointId)!.payload.isolated).toBe(true);
  });
});

describe('the envelope in effect at phase start', () => {
  it('names the envelope row, not just the phase that produced it', async () => {
    const scripted = new ScriptedAgent([buildEnvelope(), buildEnvelope()]);
    const outcome = await run({
      scripted,
      pipeline: pipe([agentPhase('plan'), agentPhase('build')]),
    });

    const build = h.tracer.phaseCheckpoints(outcome.runId).find((c) => c.phaseName === 'build')!;
    const payload = h.tracer.phaseCheckpoint(build.checkpointId)!.payload;
    const planEnvelope = h.tracer
      .envelopes(outcome.runId)
      .find(
        (e) => e.phaseId === h.tracer.phases(outcome.runId).find((p) => p.name === 'plan')!.phaseId,
      )!;

    expect(payload.envelopePhases).toEqual(['plan']);
    expect(payload.envelopeIds.plan).toBe(planEnvelope.envelopeId);
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
    const row = h.tracer.recordPhaseCheckpoint(
      checkpointInput('run_paths', phaseId, {
        phaseName: '../../escape me',
        phaseKind: 'code',
        headSha: 'deadbeef',
        worktreePath: '/tmp/nowhere',
        model: null,
        agent: null,
      }),
    );
    expect(row.payloadPath.startsWith('checkpoints/')).toBe(true);
    expect(row.payloadPath).not.toContain('..');
    const payload = h.tracer.readRunJson<PhaseCheckpointPayload>('run_paths', row.payloadPath);
    expect(payload!.phaseName).toBe('../../escape me');
  });
});
