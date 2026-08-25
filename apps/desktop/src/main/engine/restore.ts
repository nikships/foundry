/**
 * Restoring a terminal run to a durable phase checkpoint.
 *
 * Split 1 writes the record; this module is what puts it back. The
 * choreography lives here rather than in a router because
 * `src/main/ipc/AGENTS.md` declares routers logic-free, and it is deliberately
 * a sibling of `settle.ts`: landing a run and rewinding one are the two
 * operator actions that move git under a run, and both belong in the engine.
 *
 * Two entry points:
 *   - `listRestorableCheckpoints` — every checkpoint a run recorded, labelled
 *     for a picker, each with whether it can be restored exactly and why not.
 *   - `restoreRun` — put the worktree back to one checkpoint and stop.
 *
 * Three rules hold here and nowhere else:
 *   - **Nothing starts.** A restore restores and returns. Continue stays a
 *     separate, deliberate act, so the operator reviews the tree first.
 *   - **Nothing is deleted from history.** Phase rows, envelopes, transcripts,
 *     and earlier checkpoints survive; a restore only adds an event. The
 *     commits a reset moves off stay reachable through the branch's reflog.
 *   - **Exactness is never claimed.** A checkpoint that recorded a hash but
 *     not the bytes can detect that a path drifted and cannot put it back, so
 *     a restore either refuses or names what it left alone.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  PhaseCheckpointFile,
  PhaseCheckpointPayload,
  PhaseCheckpointRow,
  RestorableCheckpoint,
  RestorableCheckpointList,
  RestoreRecord,
  RestoreRefusal,
  RestoreResult,
  RestoreRunInput,
  RunRow,
  RunStatus,
} from '@shared/types.js';
import { RESTORE_REFUSAL_COPY } from '@shared/types.js';
import type { EventInput } from '../trace/tracer.js';
import {
  commitsAhead,
  currentBranch,
  refExists,
  resetHardTo,
  resolveRef,
  revertPath,
  status,
} from './git.js';

/** The Tracer surface a restore needs, so a test can drive it without one. */
export interface RestoreTracer {
  run(runId: string): RunRow | null;
  phaseCheckpoints(runId: string): PhaseCheckpointRow[];
  phaseCheckpoint(
    checkpointId: string,
  ): { row: PhaseCheckpointRow; payload: PhaseCheckpointPayload } | null;
  event(input: EventInput): string;
  clearAgentSessionId(runId: string, agent: string): string | null;
}

export interface RestoreScope {
  tracer: RestoreTracer;
  /** Whether the run is executing right now, which `runs.status` alone can lag. */
  isLive?: (runId: string) => boolean;
  /** Called after a restore writes the tracer, so the run list refreshes. */
  notifyRuns?: () => void;
}

/** Statuses a restore is offered for. A run still working cannot be rewound. */
const TERMINAL: readonly RunStatus[] = ['killed', 'failed', 'rejected'];

/** How many dropped commits a confirmation names before it stops listing them. */
const DROPPED_COMMIT_CAP = 20;

export async function listRestorableCheckpoints(
  scope: RestoreScope,
  runId: string,
): Promise<RestorableCheckpointList> {
  const { tracer } = scope;
  const eligibility = runEligibility(scope, runId);
  const rows = tracer.phaseCheckpoints(runId);
  const refusal = eligibility.ok ? (rows.length ? null : 'no_checkpoints') : eligibility.refusal;

  // The worktree is what makes "how many commits since" answerable, and a run
  // whose worktree is gone still has readable checkpoints — they are simply
  // not restorable, which the row's own blocker says.
  const cwd = eligibility.ok ? eligibility.run.worktreePath : null;
  const head = cwd ? await resolveRef(cwd, 'HEAD') : '';

  const checkpoints: RestorableCheckpoint[] = [];
  for (const row of rows) {
    checkpoints.push(await describeCheckpoint(tracer, row, cwd, head));
  }

  return {
    runId,
    refusal,
    detail: refusal ? RESTORE_REFUSAL_COPY[refusal] : '',
    checkpoints,
  };
}

export async function restoreRun(
  scope: RestoreScope,
  input: RestoreRunInput,
): Promise<RestoreResult> {
  const { tracer } = scope;
  const eligibility = runEligibility(scope, input.runId);
  if (!eligibility.ok) return refuse(eligibility.refusal);
  const run = eligibility.run;
  const cwd = run.worktreePath;

  const loaded = tracer.phaseCheckpoint(input.checkpointId);
  if (!loaded || loaded.row.runId !== input.runId) {
    // A row that exists but whose payload is gone reads as null from the
    // Tracer, so the two cases are separated by asking for the row alone.
    const known = tracer
      .phaseCheckpoints(input.runId)
      .some((r) => r.checkpointId === input.checkpointId);
    return refuse(known ? 'checkpoint_payload_missing' : 'checkpoint_not_found');
  }

  const { row, payload } = loaded;
  if (!row.headSha) return refuse('checkpoint_head_missing');
  if (!(await refExists(cwd, `${row.headSha}^{commit}`))) {
    return refuse('checkpoint_commit_missing');
  }
  if (row.truncated && !input.acceptPartial) {
    return refuse('partial_not_accepted', omittedSuffix(payload.omittedPaths));
  }
  if (run.branch && (await currentBranch(cwd)) !== run.branch) {
    return refuse('branch_mismatch');
  }

  const previousHeadSha = await resolveRef(cwd, 'HEAD');
  const droppedCommits = await commitsAhead(cwd, row.headSha, 'HEAD', DROPPED_COMMIT_CAP);
  if (!(await resetHardTo(cwd, row.headSha)).ok) return refuse('reset_failed');

  const applied = await applyPayload(cwd, payload);
  const previousSessionId = payload.agent
    ? tracer.clearAgentSessionId(input.runId, payload.agent)
    : null;

  const restored: RestoreRecord = {
    checkpointId: row.checkpointId,
    phaseId: row.phaseId,
    phaseName: row.phaseName,
    generation: row.generation,
    previousHeadSha,
    headSha: row.headSha,
    droppedCommits,
    filesRestored: applied.filesRestored,
    filesRemoved: applied.filesRemoved,
    omittedPaths: applied.omittedPaths,
    partial: applied.omittedPaths.length > 0,
    freshSessionAgent: payload.agent,
    previousSessionId,
    fromStatus: run.status,
  };

  tracer.event({
    runId: input.runId,
    phaseId: row.phaseId,
    type: 'log',
    name: 'restore',
    payload: {
      ...restored,
      // Null on a phase whose session had not opened yet, which is not an
      // error: there is no leaf to rewind to and the next Continue opens a
      // fresh session regardless, because the pointer above is now clear.
      leafMessageId: payload.leafMessageId,
      acceptedPartial: !!input.acceptPartial,
    },
  });
  scope.notifyRuns?.();

  return { ok: true, detail: confirmation(restored), restored };
}

// ── eligibility ─────────────────────────────────────────────────────────────

type Eligibility =
  { ok: true; run: RunRow & { worktreePath: string } } | { ok: false; refusal: RestoreRefusal };

/**
 * Whether this run may be restored at all, independent of any checkpoint.
 *
 * `isLive` is asked as well as the status because a crash can leave a `running`
 * row behind while nothing is executing, and a live executor can be mid-phase
 * before its status has settled. Either answer alone would refuse or allow a
 * case the other one gets right.
 */
function runEligibility(scope: RestoreScope, runId: string): Eligibility {
  const run = scope.tracer.run(runId);
  if (!run) return { ok: false, refusal: 'run_not_found' };
  if (run.status === 'running' || scope.isLive?.(runId)) {
    return { ok: false, refusal: 'run_running' };
  }
  if (!TERMINAL.includes(run.status)) return { ok: false, refusal: 'run_not_terminal' };
  if (run.merged) return { ok: false, refusal: 'run_merged' };
  if (!run.worktreePath || !existsSync(run.worktreePath)) {
    return { ok: false, refusal: 'worktree_missing' };
  }
  return { ok: true, run: { ...run, worktreePath: run.worktreePath } };
}

async function describeCheckpoint(
  tracer: RestoreTracer,
  row: PhaseCheckpointRow,
  cwd: string | null,
  head: string,
): Promise<RestorableCheckpoint> {
  const loaded = tracer.phaseCheckpoint(row.checkpointId);
  const blocker = checkpointBlocker(row, !!loaded);
  const base: RestorableCheckpoint = {
    checkpointId: row.checkpointId,
    runId: row.runId,
    phaseId: row.phaseId,
    phaseName: row.phaseName,
    phaseKind: row.phaseKind,
    generation: row.generation,
    createdAt: row.createdAt,
    headSha: row.headSha,
    model: row.model,
    agent: row.agent,
    fileCount: row.fileCount,
    untrackedCount: row.untrackedCount,
    bytesStored: row.bytesStored,
    // A truncated record can still put most of the tree back; only a missing
    // payload or a missing HEAD leaves nothing to restore from at all.
    restorable: !!loaded && !!row.headSha,
    exactRestorePossible: row.exactRestorePossible && !!loaded,
    ...(blocker ? { blocker } : {}),
    omittedPaths: loaded?.payload.omittedPaths ?? [],
    commitsSince: 0,
    commitsSinceShas: [],
  };
  if (!cwd || !row.headSha || head === row.headSha) return base;

  const shas = await commitsAhead(cwd, row.headSha, 'HEAD', DROPPED_COMMIT_CAP);
  return { ...base, commitsSince: shas.length, commitsSinceShas: shas };
}

function checkpointBlocker(
  row: PhaseCheckpointRow,
  payloadPresent: boolean,
): RestoreRefusal | null {
  if (!payloadPresent) return 'checkpoint_payload_missing';
  if (!row.headSha) return 'checkpoint_head_missing';
  if (row.truncated) return 'partial_not_accepted';
  return null;
}

// ── applying a payload to the worktree ──────────────────────────────────────

interface Applied {
  filesRestored: number;
  filesRemoved: number;
  omittedPaths: string[];
}

/**
 * Puts the worktree back to what the checkpoint recorded, in three passes.
 *
 * The reset has already returned the tracked tree to the phase-start commit,
 * which leaves exactly two kinds of drift: paths that exist now and did not
 * then, and paths whose phase-start bytes differed from the commit. The first
 * pass removes the former, the second writes the latter, and anything the
 * record could not hold is named rather than guessed at.
 */
async function applyPayload(cwd: string, payload: PhaseCheckpointPayload): Promise<Applied> {
  const recorded = new Set(payload.files.map((file) => file.path));
  let filesRemoved = 0;
  for (const entry of await status(cwd)) {
    if (recorded.has(entry.path)) continue;
    if (await revertPath(cwd, entry.path)) filesRemoved += 1;
  }

  let filesRestored = 0;
  const omittedPaths: string[] = [];
  for (const file of payload.files) {
    const outcome = applyFile(cwd, file);
    if (outcome === 'restored') filesRestored += 1;
    if (outcome === 'omitted') omittedPaths.push(file.path);
  }
  return { filesRestored, filesRemoved, omittedPaths };
}

type FileOutcome = 'restored' | 'omitted';

function applyFile(cwd: string, file: PhaseCheckpointFile): FileOutcome {
  const abs = insideWorktree(cwd, file.path);
  // Paths come from this worktree's own `git status`, so an escaping one means
  // the payload was edited. Restoring it would write outside the run.
  if (!abs) return 'omitted';

  // A path deleted at phase start is carried by the commit, so the reset put
  // it back; matching the record means taking it away again.
  if (file.state === 'deleted') {
    rmSync(abs, { force: true });
    return 'restored';
  }
  // Recorded without its bytes: the hash proves it had drifted and cannot
  // reproduce it. Whatever the reset left is kept, and the path is named.
  if (file.content === undefined) return 'omitted';

  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.from(file.content, file.encoding ?? 'utf8'));
  return 'restored';
}

/** Absolute path for a worktree-relative one, or null when it escapes. */
function insideWorktree(cwd: string, relPath: string): string | null {
  if (isAbsolute(relPath)) return null;
  const abs = resolve(cwd, relPath);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith('..')) return null;
  return join(cwd, rel);
}

// ── operator-facing copy ────────────────────────────────────────────────────

function refuse(refusal: RestoreRefusal, suffix = ''): RestoreResult {
  return { ok: false, refusal, detail: `${RESTORE_REFUSAL_COPY[refusal]}${suffix}` };
}

function omittedSuffix(paths: string[]): string {
  if (!paths.length) return '';
  return ` — these paths cannot be put back: ${paths.join(', ')}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * One sentence naming everything the operator can no longer see for
 * themselves: the phase, the commit, and the commits the branch no longer
 * carries. A reset that moved work off has to say so.
 */
function confirmation(record: RestoreRecord): string {
  const parts = [
    `Restored “${record.phaseName}” (attempt ${record.generation}) to ${record.headSha.slice(0, 8)}`,
  ];
  if (record.droppedCommits.length) {
    const moved = plural(record.droppedCommits.length, 'commit');
    parts.push(
      `${moved} moved off ${record.previousHeadSha.slice(0, 8)} (still reachable via git reflog: ${record.droppedCommits.join(', ')})`,
    );
  }
  parts.push(`${plural(record.filesRestored, 'file')} put back`);
  if (record.filesRemoved) parts.push(`${record.filesRemoved} removed`);
  if (record.partial) {
    parts.push(
      `${plural(record.omittedPaths.length, 'path')} left as they are: ${record.omittedPaths.join(', ')}`,
    );
  }
  if (record.freshSessionAgent) {
    parts.push(`${record.freshSessionAgent} continues in a new session`);
  }
  return `${parts.join('; ')}.`;
}
