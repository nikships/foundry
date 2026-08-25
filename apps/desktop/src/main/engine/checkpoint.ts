/**
 * Durable phase-start capture: what the worktree looked like the moment before
 * a phase began, written to disk rather than held in memory.
 *
 * This is deliberately a parallel mechanism to `PhaseRewinder`, not a
 * replacement for it. The rewinder snapshots in memory and rewinds a live
 * session, so a kill or a crash takes its snapshot with it; a checkpoint is
 * written before the phase starts and survives the process that wrote it.
 *
 * Contents, not only hashes. A hash can prove a dirty tracked file drifted but
 * cannot put it back, and git only carries the committed version — so the
 * phase-start bytes of anything dirty or untracked exist nowhere else once the
 * phase has overwritten them. What does not fit the budget is recorded as
 * omitted and flags the checkpoint truncated, so a later restore refuses to
 * claim an exactness it cannot deliver.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PhaseCheckpointFile,
  PhaseCheckpointFileState,
  PhaseCheckpointOmission,
} from '@shared/types.js';
import { resolveRef, status, type StatusEntry } from './git.js';

/**
 * Per-file and whole-checkpoint content budgets.
 *
 * This runs before every phase, so the capture is scoped to what git already
 * reports as changed — never a tree walk — and bounded so one large artefact
 * in a dirty worktree cannot turn a checkpoint into a copy of the build output.
 */
export const CHECKPOINT_FILE_MAX_BYTES = 1024 * 1024;
export const CHECKPOINT_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

export interface CaptureLimits {
  fileMaxBytes?: number;
  totalMaxBytes?: number;
}

export interface PhaseStartCapture {
  headSha: string;
  files: PhaseCheckpointFile[];
  handoffFiles: string[];
  truncated: boolean;
  omittedPaths: string[];
  bytesStored: number;
}

/**
 * Everything `git status --porcelain` reports as changed, with the phase-start
 * bytes of whatever fits, plus the handoff files in effect.
 */
export async function capturePhaseStart(input: {
  cwd: string;
  handoffDir: string;
  limits?: CaptureLimits;
}): Promise<PhaseStartCapture> {
  const fileMax = input.limits?.fileMaxBytes ?? CHECKPOINT_FILE_MAX_BYTES;
  const totalMax = input.limits?.totalMaxBytes ?? CHECKPOINT_TOTAL_MAX_BYTES;

  const entries = await status(input.cwd);
  const files: PhaseCheckpointFile[] = [];
  const omittedPaths: string[] = [];
  let bytesStored = 0;

  for (const entry of entries) {
    const captured = captureFile(input.cwd, entry, {
      fileMaxBytes: fileMax,
      remainingBytes: totalMax - bytesStored,
    });
    files.push(captured);
    if (captured.omitted) omittedPaths.push(captured.path);
    bytesStored += captured.content ? captured.size : 0;
  }

  return {
    headSha: await resolveRef(input.cwd, 'HEAD'),
    files,
    handoffFiles: handoffFilesIn(input.cwd, input.handoffDir),
    truncated: omittedPaths.length > 0,
    omittedPaths,
    bytesStored,
  };
}

/**
 * A porcelain code's first column is the index, the second the worktree. A `D`
 * in either means the path is gone from disk; a `?` means git has never seen
 * it, so nothing but this checkpoint holds its content.
 */
export function fileStateFor(code: string): PhaseCheckpointFileState {
  if (code.includes('?')) return 'untracked';
  if (code.includes('D')) return 'deleted';
  return 'modified';
}

function captureFile(
  cwd: string,
  entry: StatusEntry,
  budget: { fileMaxBytes: number; remainingBytes: number },
): PhaseCheckpointFile {
  const state = fileStateFor(entry.code);
  const base = { path: entry.path, state } as const;

  // A deleted path's content is not lost: git still carries it at headSha, and
  // a restore checks it out from there. Nothing to keep, nothing to omit.
  if (state === 'deleted') return { ...base, contentHash: '', size: 0 };

  let buf: Buffer;
  try {
    const abs = join(cwd, entry.path);
    // A directory can appear as one untracked entry (git collapses an
    // untracked tree). Reading it would throw; naming it is still useful.
    if (statSync(abs).isDirectory()) {
      return { ...base, contentHash: '', size: 0, omitted: 'unreadable' };
    }
    buf = readFileSync(abs);
  } catch {
    // Unreadable through permissions or a race. The path is still recorded so
    // a restore knows it was dirty, and the omission makes the gap explicit.
    return { ...base, contentHash: '', size: 0, omitted: 'unreadable' };
  }

  const contentHash = createHash('sha256').update(buf).digest('hex');
  const size = buf.byteLength;
  const omitted = omissionFor(size, budget);
  if (omitted) return { ...base, contentHash, size, omitted };

  const encoding = isUtf8(buf) ? 'utf8' : 'base64';
  return { ...base, contentHash, size, content: buf.toString(encoding), encoding };
}

function omissionFor(
  size: number,
  budget: { fileMaxBytes: number; remainingBytes: number },
): PhaseCheckpointOmission | null {
  if (size > budget.fileMaxBytes) return 'too_large';
  if (size > budget.remainingBytes) return 'budget_exhausted';
  return null;
}

/**
 * Whether the bytes survive a utf8 round trip. Storing a binary file as utf8
 * would replace every invalid sequence with U+FFFD and hand a later restore a
 * corrupted file that still matches its recorded length.
 */
function isUtf8(buf: Buffer): boolean {
  return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

/** Handoff JSON present at phase start, worktree-relative and sorted. */
function handoffFilesIn(cwd: string, handoffDir: string): string[] {
  try {
    return readdirSync(join(cwd, handoffDir))
      .sort()
      .map((name) => join(handoffDir, name));
  } catch {
    // The directory is created before the first phase; a run whose worktree is
    // gone simply has no handoff files, which is not a capture failure.
    return [];
  }
}
