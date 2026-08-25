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
import { resolveRef, statusPorcelain, type PorcelainEntry } from './git.js';

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
 * Everything git reports as changed, with the phase-start bytes of whatever
 * fits, plus the handoff files in effect.
 *
 * `truncated` covers both shortfalls a reader must not distinguish between: a
 * path whose content did not fit, and a dirty set that could not be fully
 * enumerated. Either one means the record cannot reproduce phase start.
 */
export async function capturePhaseStart(input: {
  cwd: string;
  handoffDir: string;
  limits?: CaptureLimits;
}): Promise<PhaseStartCapture> {
  const fileMax = input.limits?.fileMaxBytes ?? CHECKPOINT_FILE_MAX_BYTES;
  const totalMax = input.limits?.totalMaxBytes ?? CHECKPOINT_TOTAL_MAX_BYTES;

  const listing = await statusPorcelain(input.cwd);
  const files: PhaseCheckpointFile[] = [];
  const omittedPaths: string[] = [];
  let bytesStored = 0;

  for (const entry of expandRenames(listing.entries)) {
    const captured = captureFile(input.cwd, entry, {
      fileMaxBytes: fileMax,
      remainingBytes: totalMax - bytesStored,
    });
    files.push(captured);
    if (captured.omitted) omittedPaths.push(captured.path);
    // The encoded string is what the payload actually carries, so base64 is
    // charged at its stored length rather than at the raw byte count.
    bytesStored += captured.content?.length ?? 0;
  }

  return {
    headSha: await resolveRef(input.cwd, 'HEAD'),
    files,
    handoffFiles: handoffFilesIn(input.cwd, input.handoffDir),
    truncated: listing.truncated || omittedPaths.length > 0,
    omittedPaths,
    bytesStored,
  };
}

/**
 * A rename is two facts, and git reports it as one record.
 *
 * `R  a.txt -> b.txt` says the destination exists and the source does not, but
 * a record naming only `b.txt` loses the second half: a restore that puts the
 * tree back from `headSha` resurrects `a.txt`, leaving both files where phase
 * start had one. So the source is emitted as its own absent entry, and the
 * destination points back at it.
 */
function expandRenames(entries: PorcelainEntry[]): CaptureEntry[] {
  const out: CaptureEntry[] = [];
  for (const entry of entries) {
    if (!entry.origPath) {
      out.push({ path: entry.path, code: entry.code });
      continue;
    }
    // A copy leaves its source in place; only a rename removes it.
    if (entry.code.includes('R')) {
      out.push({ path: entry.origPath, code: entry.code, forceState: 'deleted' });
    }
    out.push({ path: entry.path, code: entry.code, renamedFrom: entry.origPath });
  }
  return out;
}

interface CaptureEntry {
  path: string;
  code: string;
  /** Set for a rename source, whose state the destination's code does not describe. */
  forceState?: PhaseCheckpointFileState;
  renamedFrom?: string;
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
  entry: CaptureEntry,
  budget: { fileMaxBytes: number; remainingBytes: number },
): PhaseCheckpointFile {
  const state = entry.forceState ?? fileStateFor(entry.code);
  const base = {
    path: entry.path,
    state,
    ...(entry.renamedFrom ? { renamedFrom: entry.renamedFrom } : {}),
  };

  // `deleted` means the path was absent from disk when the phase began, so
  // putting it back means ensuring it is absent again — there is no content to
  // keep. Note this is *not* "git has it at headSha": `AD` and `RD` records
  // name paths that HEAD does not carry at all.
  if (state === 'deleted') return { ...base, contentHash: '', size: 0 };

  let size: number;
  try {
    const abs = join(cwd, entry.path);
    const stat = statSync(abs);
    // A directory can appear as one untracked entry (git collapses an
    // untracked tree). Reading it would throw; naming it is still useful.
    if (stat.isDirectory()) return { ...base, contentHash: '', size: 0, omitted: 'unreadable' };
    size = stat.size;
  } catch {
    // Unreadable through permissions or a race. The path is still recorded so
    // a restore knows it was dirty, and the omission makes the gap explicit.
    return { ...base, contentHash: '', size: 0, omitted: 'unreadable' };
  }

  // The size check precedes the read on purpose. This runs before every phase
  // in the main process, synchronously: reading an 800 MB untracked artefact
  // just to hash it and discard it as `too_large` would block the event loop,
  // stalling IPC and the renderer's poll. An omitted file has no stored
  // content, so it has no hash either.
  const omitted = omissionFor(size, budget);
  if (omitted) return { ...base, contentHash: '', size, omitted };

  let buf: Buffer;
  try {
    buf = readFileSync(join(cwd, entry.path));
  } catch {
    return { ...base, contentHash: '', size, omitted: 'unreadable' };
  }

  const encoding = isUtf8(buf) ? 'utf8' : 'base64';
  const content = buf.toString(encoding);
  // Re-check against the encoded length: base64 is a third larger than the
  // bytes it came from, and the payload carries the string.
  if (content.length > budget.remainingBytes) {
    return {
      ...base,
      contentHash: '',
      size: buf.byteLength,
      omitted: 'budget_exhausted',
    };
  }
  return {
    ...base,
    contentHash: createHash('sha256').update(buf).digest('hex'),
    size: buf.byteLength,
    content,
    encoding,
  };
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
