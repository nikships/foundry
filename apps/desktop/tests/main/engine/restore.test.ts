/**
 * Restoring a terminal run to a durable phase checkpoint. Real git repos, real
 * SQLite, the scripted transport standing in for a model — never a network,
 * never a mocked git.
 *
 * The properties under test are the ones an operator has to be able to trust:
 * the tree really goes back (tracked reverts, recorded untracked files return,
 * HEAD moves), the history of what happened does not, and every refusal says
 * something different and true.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, projectDbPath, projectRunsDir, type Db } from '../../../src/main/trace/db.js';
import { Tracer } from '../../../src/main/trace/tracer.js';
import { Executor, type ExecutorDeps } from '../../../src/main/engine/executor.js';
import {
  listRestorableCheckpoints,
  restoreRun,
  type RestoreScope,
} from '../../../src/main/engine/restore.js';
import { defaultProject } from '../../../src/main/store/projects.js';
import type {
  AgentDef,
  CommandSpec,
  PhaseCheckpointFile,
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
  const dir = tempDir('foundry-restore-');
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
    description: 'restore pipeline',
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
  const support = tempDir('foundry-restore-support-');
  const db = openDb(projectDbPath(support, repo));
  h = {
    repo,
    support,
    db,
    tracer: new Tracer(db, projectRunsDir(support, repo)),
    project: { ...defaultProject(repo), mergePolicy: 'never' },
  };
});

/** The engine scope under test, with nothing live and notifications counted. */
function scope(over: Partial<RestoreScope> = {}): RestoreScope & { notified: () => number } {
  let notifications = 0;
  const built: RestoreScope = {
    tracer: h.tracer,
    isLive: () => false,
    notifyRuns: () => {
      notifications += 1;
    },
    ...over,
  };
  return { ...built, notified: () => notifications };
}

interface RunInput {
  pipeline: PipelineDef;
  agents?: AgentDef[];
  scripted?: ScriptedAgent;
  project?: Partial<ProjectDef>;
  runId?: string;
}

function executorFor(input: RunInput, runId: string, scripted: ScriptedAgent): Executor {
  const deps: ExecutorDeps = {
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
  };
  return new Executor(deps);
}

async function run(input: RunInput): Promise<{ status: string; runId: string }> {
  const runId = input.runId ?? `run_${Math.random().toString(36).slice(2, 8)}`;
  const scripted = input.scripted ?? new ScriptedAgent([buildEnvelope()]);
  const outcome = await executorFor(input, runId, scripted).run();
  return { status: outcome.status, runId };
}

function worktreeOf(runId: string): string {
  const path = h.tracer.run(runId)!.worktreePath;
  if (!path) throw new Error(`run ${runId} has no worktree`);
  return path;
}

function headOf(cwd: string): string {
  return sh(cwd, ['git', 'rev-parse', 'HEAD']).trim();
}

function checkpointFor(runId: string, phaseName: string, generation = 1) {
  const row = h.tracer
    .phaseCheckpoints(runId)
    .find((c) => c.phaseName === phaseName && c.generation === generation);
  if (!row) throw new Error(`no checkpoint for ${phaseName} generation ${generation}`);
  return row;
}

/**
 * Records a fresh generation of an existing checkpoint with a different file
 * list, which is how a test builds a payload the capture code would not
 * produce on this machine (invalid UTF-8, a path that is now a directory).
 * Nothing is rewritten: the original generation stays readable beside it.
 */
function rerecord(
  runId: string,
  phaseName: string,
  files: PhaseCheckpointFile[],
  over: { truncated?: boolean; omittedPaths?: string[] } = {},
): string {
  const checkpoint = checkpointFor(runId, phaseName);
  const payload = h.tracer.phaseCheckpoint(checkpoint.checkpointId)!.payload;
  return h.tracer.recordPhaseCheckpoint({
    runId,
    phaseId: checkpoint.phaseId,
    phaseName: checkpoint.phaseName,
    phaseKind: checkpoint.phaseKind,
    headSha: checkpoint.headSha,
    branch: payload.branch,
    worktreePath: payload.worktreePath,
    isolated: payload.isolated,
    model: checkpoint.model,
    agent: checkpoint.agent,
    agentSessionId: checkpoint.agentSessionId,
    leafMessageId: checkpoint.leafMessageId,
    handoffFiles: payload.handoffFiles,
    envelopePhases: payload.envelopePhases,
    files,
    truncated: over.truncated ?? false,
    omittedPaths: over.omittedPaths ?? [],
    bytesStored: 0,
  }).checkpointId;
}

function recordedFile(
  path: string,
  content: Buffer,
  state: PhaseCheckpointFile['state'] = 'untracked',
): PhaseCheckpointFile {
  const encoding = Buffer.from(content.toString('utf8'), 'utf8').equals(content)
    ? ('utf8' as const)
    : ('base64' as const);
  return {
    path,
    state,
    contentHash: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
    content: content.toString(encoding),
    encoding,
  };
}

/**
 * A rejected run whose `build` checkpoint holds a dirty tracked file and an
 * untracked one, so a restore has something only the checkpoint can put back.
 */
async function rejectedRunWithDirtyCheckpoint(): Promise<{ runId: string; worktree: string }> {
  const outcome = await run({
    // The build phase never yields a parseable envelope, so the run ends
    // `rejected` with its worktree intact and its session still persisted.
    scripted: new ScriptedAgent(['prose, not JSON']),
    pipeline: pipe([
      codePhase('dirty', {
        argv: ['sh', '-c', 'printf "phase-start\\n" > tracked.txt && printf "kept\\n" > extra.txt'],
      }),
      agentPhase('build'),
    ]),
  });
  expect(outcome.status).toBe('rejected');
  return { runId: outcome.runId, worktree: worktreeOf(outcome.runId) };
}

describe('restoring a terminal run to a checkpoint', () => {
  it('puts tracked modifications, recorded untracked files, and HEAD back', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');

    // The mess a killed or failed attempt leaves: a tracked file overwritten,
    // a recorded untracked file deleted, and a new file that never belonged.
    writeFileSync(join(worktree, 'tracked.txt'), 'clobbered by the dead attempt\n');
    rmSync(join(worktree, 'extra.txt'));
    writeFileSync(join(worktree, 'junk.txt'), 'left behind\n');

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(worktree, 'tracked.txt'), 'utf8')).toBe('phase-start\n');
    expect(readFileSync(join(worktree, 'extra.txt'), 'utf8')).toBe('kept\n');
    expect(existsSync(join(worktree, 'junk.txt'))).toBe(false);
    expect(headOf(worktree)).toBe(checkpoint.headSha);
    expect(result.restored!.partial).toBe(false);
    expect(result.restored!.omittedPaths).toEqual([]);
  });

  it('resets the run branch to the checkpoint commit and names the commits it moved off', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');

    writeFileSync(join(worktree, 'committed-after.txt'), 'work committed after the checkpoint\n');
    sh(worktree, ['git', 'add', '-A']);
    sh(worktree, ['git', 'commit', '-qm', 'after the checkpoint']);
    const dropped = headOf(worktree);

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.ok).toBe(true);
    expect(headOf(worktree)).toBe(checkpoint.headSha);
    expect(result.restored!.previousHeadSha).toBe(dropped);
    expect(result.restored!.droppedCommits).toHaveLength(1);
    expect(dropped.startsWith(result.restored!.droppedCommits[0]!)).toBe(true);
    // Moved off the branch, not deleted: the commit is still reachable.
    expect(sh(worktree, ['git', 'cat-file', '-t', dropped]).trim()).toBe('commit');
    expect(result.detail).toContain('moved off');
    expect(result.detail).toContain('reflog');
  });

  it('works inside the run worktree only, never the base checkout', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    writeFileSync(join(h.repo, 'operator-edit.txt'), 'the operator is mid-thought\n');
    const baseHead = headOf(h.repo);

    const result = await restoreRun(scope(), {
      runId,
      checkpointId: checkpointFor(runId, 'build').checkpointId,
    });

    expect(result.ok).toBe(true);
    expect(worktree.startsWith(join(h.repo, '.foundry-worktrees'))).toBe(true);
    expect(readFileSync(join(h.repo, 'operator-edit.txt'), 'utf8')).toBe(
      'the operator is mid-thought\n',
    );
    expect(headOf(h.repo)).toBe(baseHead);
  });

  it('leaves the phase rows, transcript, and earlier checkpoints as they were', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const phasesBefore = h.tracer.phases(runId);
    const eventsBefore = h.tracer.eventsAfter(runId, 0, 1000);
    const checkpointsBefore = h.tracer.phaseCheckpoints(runId);

    await restoreRun(scope(), { runId, checkpointId: checkpointFor(runId, 'build').checkpointId });

    expect(h.tracer.phases(runId)).toEqual(phasesBefore);
    expect(h.tracer.phaseCheckpoints(runId)).toEqual(checkpointsBefore);
    const after = h.tracer.eventsAfter(runId, 0, 1000);
    // Additive: every earlier event survives and the restore appends one.
    expect(after.slice(0, eventsBefore.length)).toEqual(eventsBefore);
    const restore = after.find((e) => e.name === 'restore')!;
    expect(restore.type).toBe('log');
    expect(restore.payload.fromStatus).toBe('rejected');
    expect(restore.payload.phaseName).toBe('build');
  });

  it('does not start the run: status, live state, and phase statuses are untouched', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const statusesBefore = h.tracer.phases(runId).map((p) => p.status);

    await restoreRun(scope(), { runId, checkpointId: checkpointFor(runId, 'build').checkpointId });

    const run = h.tracer.run(runId)!;
    expect(run.status).toBe('rejected');
    expect(run.endedAt).toBeTruthy();
    expect(h.tracer.phases(runId).map((p) => p.status)).toEqual(statusesBefore);
  });

  it('notifies the run list once, because the tracer was written', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const s = scope();
    await restoreRun(s, { runId, checkpointId: checkpointFor(runId, 'build').checkpointId });
    expect(s.notified()).toBe(1);
  });
});

describe('the session a restore leaves behind', () => {
  it('drops the agent’s session pointer so the next Continue opens a new one', async () => {
    const pipeline = pipe([agentPhase('build')]);
    // Three unparseable turns exhaust the envelope budget and reject the run
    // with its session alive; the fourth answers the continued attempt.
    const scripted = new ScriptedAgent(['no', 'still no', 'nope', buildEnvelope()]);
    const first = await run({ pipeline, scripted });
    expect(first.status).toBe('rejected');

    const before = h.tracer.agentSessions(first.runId)[0]!;
    expect(before.agentSessionId).toBe('s1');

    const result = await restoreRun(scope(), {
      runId: first.runId,
      checkpointId: checkpointFor(first.runId, 'build').checkpointId,
    });

    expect(result.restored!.freshSessions).toEqual([{ agent: 'builder', previousSessionId: 's1' }]);
    // The row survives — it is the evidence of what was abandoned — and only
    // the pointer to the runtime conversation is gone.
    const cleared = h.tracer.agentSessions(first.runId)[0]!;
    expect(cleared.agent).toBe('builder');
    expect(cleared.model).toBe(before.model);
    expect(cleared.agentSessionId).toBeNull();

    const continued = await executorFor({ pipeline }, first.runId, scripted).resume();
    expect(continued.status).toBe('accepted');
    // A reopen would have prompted `s1` again; this is a new conversation.
    expect(scripted.turnRequests.at(-1)!.sessionId).toBe('s2');
  });

  it('accepts a checkpoint whose phase had no session open yet', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const build = checkpointFor(runId, 'build');
    // The first entry into a phase has no leaf: nothing had been sent. That is
    // not an error, and a restore must not treat it as one.
    expect(build.leafMessageId).toBeNull();

    const result = await restoreRun(scope(), { runId, checkpointId: build.checkpointId });
    expect(result.ok).toBe(true);
    const restore = h.tracer.eventsAfter(runId, 0, 1000).find((e) => e.name === 'restore')!;
    expect(restore.payload.leafMessageId).toBeNull();
  });

  it('drops the pointer of a later phase’s agent, not only the restored phase’s', async () => {
    // `dirty` is a code phase and precedes `build`. Restoring to it must still
    // clear `builder`: the tree has moved out from under that conversation,
    // and a Continue resumes from `build`, which would otherwise reopen the
    // session the restore was performed to escape.
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    expect(h.tracer.agentSessions(runId)[0]!.agentSessionId).toBe('s1');

    const result = await restoreRun(scope(), {
      runId,
      checkpointId: checkpointFor(runId, 'dirty').checkpointId,
    });

    expect(result.ok).toBe(true);
    expect(result.restored!.freshSessions).toEqual([{ agent: 'builder', previousSessionId: 's1' }]);
    expect(h.tracer.agentSessions(runId)[0]!.agentSessionId).toBeNull();
  });

  it('reports no fresh sessions for a run that never opened one', async () => {
    const outcome = await run({
      pipeline: pipe([codePhase('touch', { argv: ['sh', '-c', 'printf x > only.txt && false'] })]),
    });
    expect(outcome.status).toBe('rejected');

    const result = await restoreRun(scope(), {
      runId: outcome.runId,
      checkpointId: checkpointFor(outcome.runId, 'touch').checkpointId,
    });

    expect(result.ok).toBe(true);
    expect(result.restored!.freshSessions).toEqual([]);
    expect(result.detail).not.toContain('new session');
  });
});

describe('a later attempt at the same phase', () => {
  it('is its own restore target, and restoring one leaves the other readable', async () => {
    // The check passes only once fix.txt exists, so the first pass routes
    // feedback back into `build` and enters it a second time.
    writeFileSync(join(h.repo, 'check.sh'), '#!/bin/sh\ntest -f fix.txt\n');
    sh(h.repo, ['chmod', '+x', 'check.sh']);
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

    // An accepted run with `mergePolicy: never` keeps its worktree, but it is
    // not terminal in the restorable sense, so the list says why.
    const accepted = await listRestorableCheckpoints(scope(), outcome.runId);
    expect(accepted.refusal).toBe('run_not_terminal');
    expect(accepted.checkpoints.filter((c) => c.phaseName === 'build')).toHaveLength(2);
    expect(
      accepted.checkpoints.filter((c) => c.phaseName === 'build').map((c) => c.generation),
    ).toEqual([1, 2]);
  });
});

describe('the list of restorable checkpoints', () => {
  it('labels every recorded checkpoint for a picker', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const listed = await listRestorableCheckpoints(scope(), runId);

    expect(listed.runId).toBe(runId);
    expect(listed.refusal).toBeNull();
    expect(listed.detail).toBe('');
    expect(listed.checkpoints.map((c) => c.phaseName)).toEqual(['dirty', 'build']);
    for (const checkpoint of listed.checkpoints) {
      expect(checkpoint.generation).toBe(1);
      expect(checkpoint.createdAt).toBeTruthy();
      expect(checkpoint.headSha).toMatch(/^[0-9a-f]{40}$/);
      expect(checkpoint.restorable).toBe(true);
      expect(checkpoint.exactRestorePossible).toBe(true);
      expect(checkpoint.blocker).toBeUndefined();
      expect(checkpoint.omittedPaths).toEqual([]);
      expect(checkpoint.commitsSince).toBe(0);
    }
    const build = listed.checkpoints.find((c) => c.phaseName === 'build')!;
    expect(build.phaseKind).toBe('agent');
    expect(build.agent).toBe('builder');
    expect(build.model).toBe('scripted/model');
    // tracked.txt modified plus extra.txt untracked, as the code phase left it.
    expect(build.fileCount).toBe(2);
    expect(build.untrackedCount).toBe(1);
    expect(listed.checkpoints.find((c) => c.phaseName === 'dirty')!.agent).toBeNull();
  });

  it('counts the commits a restore to each checkpoint would move off', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    writeFileSync(join(worktree, 'later.txt'), 'later\n');
    sh(worktree, ['git', 'add', '-A']);
    sh(worktree, ['git', 'commit', '-qm', 'later work']);

    const listed = await listRestorableCheckpoints(scope(), runId);
    for (const checkpoint of listed.checkpoints) {
      expect(checkpoint.commitsSince).toBe(1);
      expect(checkpoint.commitsSinceShas).toHaveLength(1);
    }
  });

  it('answers with an empty list for a run recorded before checkpoints shipped', async () => {
    h.tracer.startRun({
      runId: 'run_before_checkpoints',
      projectId: h.project.id,
      pipeline: pipe([]),
      request: 'x',
      engineer: 'test',
      worktreePath: h.repo,
      branch: null,
      baseRef: 'main',
      mode: 'pi',
    });
    h.tracer.finishRun('run_before_checkpoints', 'failed', 'stopped');

    const listed = await listRestorableCheckpoints(scope(), 'run_before_checkpoints');
    expect(listed.checkpoints).toEqual([]);
    expect(listed.refusal).toBe('no_checkpoints');
    expect(listed.detail).toBe(
      'this run recorded no phase checkpoints, so there is nothing to restore to',
    );
  });

  it('still lists a merged run’s checkpoints, with the reason they cannot be used', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    h.tracer.setMerged(runId, true);

    const listed = await listRestorableCheckpoints(scope(), runId);
    expect(listed.refusal).toBe('run_merged');
    expect(listed.checkpoints).toHaveLength(2);
  });
});

describe('what a restore refuses, and why', () => {
  it('refuses a run that is not in the trace', async () => {
    const result = await restoreRun(scope(), { runId: 'run_nothing', checkpointId: 'cp_nothing' });
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('run_not_found');
    expect(result.detail).toBe('this run is no longer in the trace');
  });

  it('refuses a run that is still running', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const checkpointId = checkpointFor(runId, 'build').checkpointId;
    h.tracer.reopenRun(runId);

    const result = await restoreRun(scope(), { runId, checkpointId });
    expect(result.refusal).toBe('run_running');
    expect(result.detail).toBe('this run is still running — stop it before restoring a checkpoint');
    expect((await listRestorableCheckpoints(scope(), runId)).refusal).toBe('run_running');
  });

  it('refuses a run a live executor still holds, whatever the row says', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const result = await restoreRun(scope({ isLive: () => true }), {
      runId,
      checkpointId: checkpointFor(runId, 'build').checkpointId,
    });
    expect(result.refusal).toBe('run_running');
  });

  it('refuses an accepted run, which is not a stop to rewind from', async () => {
    const outcome = await run({ pipeline: pipe([agentPhase('build')]) });
    expect(outcome.status).toBe('accepted');
    const result = await restoreRun(scope(), {
      runId: outcome.runId,
      checkpointId: checkpointFor(outcome.runId, 'build').checkpointId,
    });
    expect(result.refusal).toBe('run_not_terminal');
    expect(result.detail).toBe('only a killed, failed, or rejected run can be restored');
  });

  it('refuses a merged run', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const checkpointId = checkpointFor(runId, 'build').checkpointId;
    h.tracer.setMerged(runId, true);

    const result = await restoreRun(scope(), { runId, checkpointId });
    expect(result.refusal).toBe('run_merged');
    expect(result.detail).toBe('a merged run cannot be restored');
  });

  it('refuses when the worktree is gone', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpointId = checkpointFor(runId, 'build').checkpointId;
    sh(h.repo, ['git', 'worktree', 'remove', '--force', worktree]);
    expect(existsSync(worktree)).toBe(false);

    const result = await restoreRun(scope(), { runId, checkpointId });
    expect(result.refusal).toBe('worktree_missing');
    expect(result.detail).toBe('this run’s worktree is gone, so there is nowhere to restore into');
  });

  it('refuses a target this run never recorded', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const result = await restoreRun(scope(), { runId, checkpointId: 'cp_not_a_thing' });
    expect(result.refusal).toBe('checkpoint_not_found');
    expect(result.detail).toBe('that checkpoint is not one this run recorded');
  });

  it('refuses a checkpoint whose payload file has been pruned away', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    rmSync(join(h.tracer.runDir(runId), checkpoint.payloadPath));

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });
    expect(result.refusal).toBe('checkpoint_payload_missing');
    expect(result.detail).toBe('that checkpoint’s recorded contents are no longer on disk');

    // The row carries presence, so the picker says so without opening it.
    const listed = await listRestorableCheckpoints(scope(), runId);
    const listedBuild = listed.checkpoints.find((c) => c.phaseName === 'build')!;
    expect(listedBuild.restorable).toBe(false);
    expect(listedBuild.blocker).toBe('checkpoint_payload_missing');
  });

  it('refuses a payload that is present but no longer parses, at restore time', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    h.tracer.writeRunFile(runId, checkpoint.payloadPath, 'not json');

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });
    expect(result.refusal).toBe('checkpoint_payload_missing');

    // The list reads the index and does not open payloads: a checkpoint now
    // holds the dirty set uncapped, so proving every row parses would mean
    // reading a phase's entire worktree drift per row just to draw a picker.
    // Presence is what the row can answer cheaply; a corrupt payload is caught
    // where it matters, on the restore itself, with the same reason.
    const listed = await listRestorableCheckpoints(scope(), runId);
    const listedBuild = listed.checkpoints.find((c) => c.phaseName === 'build')!;
    expect(listedBuild.restorable).toBe(true);
    expect(listedBuild.blocker).toBeUndefined();
  });

  it('refuses when the commit the phase started from is not in this worktree', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    const payload = h.tracer.phaseCheckpoint(checkpoint.checkpointId)!.payload;
    // A sha this repo has never held stands in for history that is gone.
    h.tracer.writeRunFile(
      runId,
      checkpoint.payloadPath,
      JSON.stringify({ ...payload, headSha: 'f'.repeat(40) }),
    );
    h.db
      .prepare('UPDATE phase_checkpoints SET head_sha = ? WHERE checkpoint_id = ?')
      .run('f'.repeat(40), checkpoint.checkpointId);

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });
    expect(result.refusal).toBe('checkpoint_commit_missing');
    // Nothing moved: a refusal is not a half restore.
    expect(headOf(worktree)).toBe(checkpoint.headSha);
  });
});

describe('a truncated checkpoint', () => {
  /**
   * Records the run's `build` checkpoint again with one path's content
   * withheld, exactly as a path the capture could not read leaves it, so the
   * row is truncated and its payload names what cannot be reproduced.
   */
  function truncate(runId: string): string {
    const payload = h.tracer.phaseCheckpoint(checkpointFor(runId, 'build').checkpointId)!.payload;
    return rerecord(
      runId,
      'build',
      payload.files.map((file) =>
        file.path === 'tracked.txt'
          ? { ...file, content: undefined, encoding: undefined, omitted: 'unreadable' as const }
          : file,
      ),
      { truncated: true, omittedPaths: ['tracked.txt'] },
    );
  }

  it('refuses an exact restore rather than silently partially restoring', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpointId = truncate(runId);
    writeFileSync(join(worktree, 'tracked.txt'), 'clobbered\n');

    const result = await restoreRun(scope(), { runId, checkpointId });

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('partial_not_accepted');
    expect(result.detail).toContain('a partial restore has to be accepted explicitly');
    // The refusal names the paths, so a confirmation can quote them.
    expect(result.detail).toContain('tracked.txt');
    // Nothing was touched, so the refusal cost the operator nothing.
    expect(readFileSync(join(worktree, 'tracked.txt'), 'utf8')).toBe('clobbered\n');
  });

  it('names the omitted paths and the blocker in the list', async () => {
    const { runId } = await rejectedRunWithDirtyCheckpoint();
    const checkpointId = truncate(runId);

    const listed = await listRestorableCheckpoints(scope(), runId);
    const truncated = listed.checkpoints.find((c) => c.checkpointId === checkpointId)!;
    expect(truncated.generation).toBe(2);
    // A record that cannot be exact can still put most of the tree back.
    expect(truncated.restorable).toBe(true);
    expect(truncated.exactRestorePossible).toBe(false);
    expect(truncated.blocker).toBe('partial_not_accepted');
    expect(truncated.omittedPaths).toEqual(['tracked.txt']);
  });

  it('restores what it can once a partial restore is accepted, and says what it left', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpointId = truncate(runId);
    writeFileSync(join(worktree, 'tracked.txt'), 'clobbered\n');
    rmSync(join(worktree, 'extra.txt'));

    const result = await restoreRun(scope(), { runId, checkpointId, acceptPartial: true });

    expect(result.ok).toBe(true);
    expect(result.restored!.partial).toBe(true);
    expect(result.restored!.omittedPaths).toEqual(['tracked.txt']);
    expect(result.detail).toContain('tracked.txt');
    // The path with recorded bytes is back; the omitted one is whatever the
    // reset to the checkpoint commit left, never a fabricated version.
    expect(readFileSync(join(worktree, 'extra.txt'), 'utf8')).toBe('kept\n');
    expect(readFileSync(join(worktree, 'tracked.txt'), 'utf8')).toBe('committed\n');
  });
});

describe('the branch a restore is willing to move', () => {
  it('refuses when the worktree stands on another branch, and moves nothing', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    // A later commit means a reset would be observable if the guard failed.
    writeFileSync(join(worktree, 'after.txt'), 'after\n');
    sh(worktree, ['git', 'add', '-A']);
    sh(worktree, ['git', 'commit', '-qm', 'after the checkpoint']);
    const before = headOf(worktree);
    sh(worktree, ['git', 'checkout', '-qb', 'someone-elses-branch']);

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('branch_mismatch');
    expect(result.detail).toBe(
      'this run’s worktree is no longer on its own branch, so a reset would move another ref',
    );
    expect(headOf(worktree)).toBe(before);
    expect(sh(worktree, ['git', 'branch', '--show-current']).trim()).toBe('someone-elses-branch');
    // A refusal before the reset writes nothing.
    expect(h.tracer.eventsAfter(runId, 0, 1000).some((e) => e.name === 'restore')).toBe(false);
  });

  it('refuses a detached HEAD, where no branch would move at all', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    writeFileSync(join(worktree, 'after.txt'), 'after\n');
    sh(worktree, ['git', 'add', '-A']);
    sh(worktree, ['git', 'commit', '-qm', 'after the checkpoint']);
    const before = headOf(worktree);
    sh(worktree, ['git', 'checkout', '-q', '--detach', 'HEAD']);

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.refusal).toBe('branch_mismatch');
    expect(headOf(worktree)).toBe(before);
  });

  it('refuses a run row that records no branch, where the target ref is unknown', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    const before = headOf(worktree);
    h.db.prepare('UPDATE runs SET branch = NULL WHERE run_id = ?').run(runId);

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.refusal).toBe('branch_mismatch');
    expect(headOf(worktree)).toBe(before);
  });

  it('refuses when git will not move the branch, and says so', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    writeFileSync(join(worktree, 'after.txt'), 'after\n');
    sh(worktree, ['git', 'add', '-A']);
    sh(worktree, ['git', 'commit', '-qm', 'after the checkpoint']);
    const before = headOf(worktree);
    // A stale lock is exactly what a crashed git leaves behind, and it makes
    // `reset --hard` fail for a reason nothing in this module controls.
    const gitDir = sh(worktree, ['git', 'rev-parse', '--absolute-git-dir']).trim();
    writeFileSync(join(gitDir, 'index.lock'), '');

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('reset_failed');
    expect(result.detail).toBe(
      'git refused to move the run branch back to the checkpoint’s commit',
    );
    expect(headOf(worktree)).toBe(before);
    expect(h.tracer.eventsAfter(runId, 0, 1000).some((e) => e.name === 'restore')).toBe(false);
    rmSync(join(gitDir, 'index.lock'));
  });

  it('refuses a run that never had a worktree, so a restore cannot reach a live checkout', async () => {
    // A non-isolated run's checkpoint records the operator's own checkout and
    // its uncommitted work (`isolated: false`), which is a materially
    // different thing to put back. Two independent guards already refuse it —
    // the run row carries no worktree and no branch — and this pins that,
    // because the checkpoint payload alone would happily name a path to write.
    const outcome = await run({
      project: { isolation: false },
      pipeline: pipe([codePhase('touch', { argv: ['sh', '-c', 'printf x > only.txt && false'] })]),
    });
    expect(outcome.status).toBe('rejected');
    const row = h.tracer.run(outcome.runId)!;
    expect(row.worktreePath).toBeNull();

    const checkpoint = checkpointFor(outcome.runId, 'touch');
    expect(h.tracer.phaseCheckpoint(checkpoint.checkpointId)!.payload.isolated).toBe(false);

    const result = await restoreRun(scope(), {
      runId: outcome.runId,
      checkpointId: checkpoint.checkpointId,
    });
    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('worktree_missing');
    // The operator's checkout keeps the work the phase left in it.
    expect(readFileSync(join(h.repo, 'only.txt'), 'utf8')).toBe('x');
  });

  it('refuses a checkpoint that never recorded the commit its phase started from', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    const before = headOf(worktree);
    h.db
      .prepare('UPDATE phase_checkpoints SET head_sha = ? WHERE checkpoint_id = ?')
      .run('', checkpoint.checkpointId);

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.refusal).toBe('checkpoint_head_missing');
    expect(result.detail).toBe('that checkpoint never recorded the commit its phase started from');
    expect(headOf(worktree)).toBe(before);

    const listed = await listRestorableCheckpoints(scope(), runId);
    const build = listed.checkpoints.find((c) => c.checkpointId === checkpoint.checkpointId)!;
    expect(build.restorable).toBe(false);
    expect(build.blocker).toBe('checkpoint_head_missing');
  });
});

describe('a checkpoint holding bytes that are not text', () => {
  it('puts a binary file back byte for byte', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    // Invalid UTF-8 on purpose: a utf8 round trip would replace 0x80–0xFF
    // with U+FFFD and hand back a file that still matches its recorded length.
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0x7f, 0xc3, 0x28]);
    const checkpointId = rerecord(runId, 'build', [recordedFile('logo.bin', bytes)]);

    writeFileSync(join(worktree, 'logo.bin'), 'clobbered by the dead attempt\n');
    const result = await restoreRun(scope(), { runId, checkpointId });

    expect(result.ok).toBe(true);
    expect(result.restored!.omittedPaths).toEqual([]);
    expect(readFileSync(join(worktree, 'logo.bin')).equals(bytes)).toBe(true);
  });
});

describe('a payload that cannot be applied as recorded', () => {
  it('never writes through a symlink, so the base checkout stays untouched', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    // The escape a capture records honestly: an untracked symlink pointing at
    // a file in the base checkout. Capture stores the *target's* bytes under
    // the link's path, and `reset --hard` does not remove an untracked link,
    // so a writer that trusts the path writes straight into the base repo.
    const target = join(h.repo, 'precious.txt');
    writeFileSync(target, 'PRECIOUS\n');
    const link = join(worktree, 'escape.txt');
    symlinkSync('../../precious.txt', link);
    expect(readFileSync(link, 'utf8')).toBe('PRECIOUS\n');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const checkpointId = rerecord(
      runId,
      'build',
      [recordedFile('escape.txt', Buffer.from('CLOBBERED\n'))],
      {},
    );

    const result = await restoreRun(scope(), { runId, checkpointId, acceptPartial: true });

    expect(result.ok).toBe(true);
    // The link survives the reset, so the guard is the only thing between the
    // restore and the base file.
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('PRECIOUS\n');
    expect(result.restored!.omittedPaths).toEqual(['escape.txt']);
    expect(result.restored!.filesRestored).toBe(0);
  });

  it('does not delete through a symlink either', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const target = join(h.repo, 'precious.txt');
    writeFileSync(target, 'PRECIOUS\n');
    symlinkSync('../../precious.txt', join(worktree, 'escape.txt'));

    // `deleted` means "phase start did not have this path", so a restore
    // removes it. Through a link that would remove the base file.
    const checkpointId = rerecord(runId, 'build', [
      { path: 'escape.txt', state: 'deleted', contentHash: '', size: 0 },
    ]);

    const result = await restoreRun(scope(), { runId, checkpointId, acceptPartial: true });

    expect(result.ok).toBe(true);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('PRECIOUS\n');
    expect(result.restored!.omittedPaths).toEqual(['escape.txt']);
  });

  it('writes a file back over a directory the dead attempt left standing', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpointId = rerecord(runId, 'build', [
      recordedFile('foo', Buffer.from('phase-start file\n')),
    ]);
    // `git clean -fd -- foo/bar` removes the file and leaves `foo` a directory,
    // so the write that follows would fail with EISDIR.
    mkdirSync(join(worktree, 'foo'), { recursive: true });
    writeFileSync(join(worktree, 'foo', 'bar'), 'the phase replaced a file with a tree\n');

    const result = await restoreRun(scope(), { runId, checkpointId });

    expect(result.ok).toBe(true);
    expect(result.restored!.omittedPaths).toEqual([]);
    expect(readFileSync(join(worktree, 'foo'), 'utf8')).toBe('phase-start file\n');
  });

  /**
   * A payload that cannot be applied whole: it records `a` as a file and
   * `a/b` beneath it, so whichever order the passes run in, one of the two
   * cannot exist. Recording `a` is what keeps the first pass from simply
   * cleaning the obstruction away.
   */
  function selfContradictingPayload(runId: string): string {
    return rerecord(runId, 'build', [
      recordedFile('a', Buffer.from('a is a file\n')),
      recordedFile('a/b', Buffer.from('nested\n')),
      recordedFile('fine.txt', Buffer.from('written anyway\n')),
    ]);
  }

  it('counts a path it cannot write as omitted, and still records the restore', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpointId = selfContradictingPayload(runId);

    const result = await restoreRun(scope(), { runId, checkpointId, acceptPartial: true });

    expect(result.ok).toBe(true);
    expect(result.restored!.omittedPaths).toEqual(['a/b']);
    expect(result.restored!.filesRestored).toBe(2);
    // The pass kept going after the throw rather than abandoning the tree.
    expect(readFileSync(join(worktree, 'a'), 'utf8')).toBe('a is a file\n');
    expect(readFileSync(join(worktree, 'fine.txt'), 'utf8')).toBe('written anyway\n');
    // The event is the operator's only record of the pre-restore HEAD, so a
    // partial apply must not cost them it.
    const restore = h.tracer.eventsAfter(runId, 0, 1000).find((e) => e.name === 'restore')!;
    expect(restore.payload.previousHeadSha).toBe(result.restored!.previousHeadSha);
    expect(restore.payload.omittedPaths).toEqual(['a/b']);
  });

  it('reports a partial apply as a refusal when the caller did not accept one', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    // The row is not truncated, so the pre-check at the top passes; the
    // omission only appears while applying.
    const checkpointId = selfContradictingPayload(runId);
    const checkpoint = h.tracer.phaseCheckpoint(checkpointId)!.row;

    const result = await restoreRun(scope(), { runId, checkpointId });

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('partial_not_accepted');
    expect(result.detail).toContain('a/b');
    // The reset happened, so the refusal reports it rather than pretending it
    // did not, and the record travels with the answer.
    expect(result.detail).toContain('the worktree was already reset');
    expect(result.restored!.omittedPaths).toEqual(['a/b']);
    expect(headOf(worktree)).toBe(checkpoint.headSha);
    const restore = h.tracer.eventsAfter(runId, 0, 1000).find((e) => e.name === 'restore')!;
    expect(restore.payload.accepted).toBe(false);
  });

  /**
   * Makes `git status` alone fail, which is the "git refused" half of what
   * `statusPorcelain` reports as un-enumerable. Every other git command the
   * restore runs — branch, rev-parse, reset — is unaffected, so this isolates
   * the listing rather than breaking the repository.
   */
  function breakStatusListing(worktree: string): void {
    sh(worktree, ['git', 'config', 'status.showUntrackedFiles', 'not-a-mode']);
  }

  it('is partial when the drift to revert could not be listed in full', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    // The capture side already refuses to call a short list the whole dirty
    // set; the revert pass has to be just as honest, because reverting a
    // subset and reporting a whole restore is the answer it must not give.
    breakStatusListing(worktree);

    const result = await restoreRun(scope(), {
      runId,
      checkpointId: checkpoint.checkpointId,
      acceptPartial: true,
    });

    expect(result.ok).toBe(true);
    // Nothing is named — that is the point: the paths that were missed cannot
    // be listed, so `partial` carries the warning on its own.
    expect(result.restored!.omittedPaths).toEqual([]);
    expect(result.restored!.driftEnumerated).toBe(false);
    expect(result.restored!.partial).toBe(true);
    expect(result.detail).toContain('could not be listed in full');
    // The reset still happened and is still recorded.
    expect(headOf(worktree)).toBe(checkpoint.headSha);
  });

  it('refuses the un-enumerated case too when a partial restore was not accepted', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    breakStatusListing(worktree);

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.ok).toBe(false);
    expect(result.refusal).toBe('partial_not_accepted');
    expect(result.detail).toContain('could not be listed in full');
    expect(result.detail).toContain('the worktree was already reset');
    const restore = h.tracer.eventsAfter(runId, 0, 1000).find((e) => e.name === 'restore')!;
    expect(restore.payload.driftEnumerated).toBe(false);
  });
});

describe('the commits a restore moves off', () => {
  it('counts every one of them, even past the cap it quotes', async () => {
    const { runId, worktree } = await rejectedRunWithDirtyCheckpoint();
    const checkpoint = checkpointFor(runId, 'build');
    // One past the 20-sha listing cap: the confirmation must say 21, not 20.
    for (let i = 0; i < 21; i++) {
      writeFileSync(join(worktree, `c${i}.txt`), `${i}\n`);
      sh(worktree, ['git', 'add', '-A']);
      sh(worktree, ['git', 'commit', '-qm', `commit ${i}`]);
    }

    const result = await restoreRun(scope(), { runId, checkpointId: checkpoint.checkpointId });

    expect(result.ok).toBe(true);
    expect(result.restored!.droppedCommitCount).toBe(21);
    expect(result.restored!.droppedCommits).toHaveLength(20);
    expect(result.detail).toContain('21 commits moved off');
    // The quoted list is visibly incomplete rather than passing as the whole.
    expect(result.detail).toContain(', …)');
  });
});
