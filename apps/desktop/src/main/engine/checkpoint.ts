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
 * phase has overwritten them. Size is not a reason to drop any of it: the
 * capture is scoped to what git already reports as changed, never a tree walk,
 * and a checkpoint that silently skipped the one large file a phase was about
 * to overwrite would be worth less than the bytes it saved. Only a path that
 * genuinely cannot be read is recorded as omitted, and that flags the
 * checkpoint truncated so a later restore refuses to claim an exactness it
 * cannot deliver.
 */

import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { PhaseCheckpointFile, PhaseCheckpointFileState } from '@shared/types.js';
import { resolveRef, statusPorcelain, type PorcelainEntry } from './git.js';

export interface PhaseStartCapture {
  headSha: string;
  files: PhaseCheckpointFile[];
  handoffFiles: string[];
  truncated: boolean;
  omittedPaths: string[];
  bytesStored: number;
}

/**
 * Everything git reports as changed, with its phase-start bytes, plus the
 * handoff files in effect.
 *
 * `truncated` covers both shortfalls a reader must not distinguish between: a
 * path whose content could not be read, and a dirty set that could not be
 * fully enumerated. Either one means the record cannot reproduce phase start.
 */
export async function capturePhaseStart(input: {
  cwd: string;
  handoffDir: string;
}): Promise<PhaseStartCapture> {
  const listing = await statusPorcelain(input.cwd);
  const files: PhaseCheckpointFile[] = [];
  const omittedPaths: string[] = [];
  let bytesStored = 0;

  for (const entry of expandRenames(listing.entries)) {
    const captured = await captureFile(input.cwd, entry);
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

async function captureFile(cwd: string, entry: CaptureEntry): Promise<PhaseCheckpointFile> {
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

  const abs = join(cwd, entry.path);

  // One handle, stat-ed and read through that same handle, so the bytes hashed
  // are the bytes measured: checking the path and then opening it separately
  // describes two different files if anything moves in between. A directory
  // can appear as one untracked entry (git collapses an untracked tree), and
  // opening it succeeds on macOS while reading it does not, so the stat is
  // still what rules it out. The size is kept before the read because it is
  // the only thing that can say how much is missing on a path the read then
  // fails on.
  let handle: FileHandle;
  try {
    handle = await open(abs, 'r');
  } catch {
    // Unreadable through permissions or a race. The path is still recorded so
    // a restore knows it was dirty, and the omission makes the gap explicit.
    return { ...base, contentHash: '', size: 0, omitted: 'unreadable' };
  }

  // Read off the threadpool rather than synchronously. Nothing is skipped for
  // size any more, so a dirty 800 MB build artefact is now something this
  // reads in full — synchronously that would park the main process for as long
  // as the disk took, stalling IPC and the renderer's poll, before every
  // phase. The caller still awaits the whole capture before the phase starts,
  // so the record is complete when the phase begins.
  let size = 0;
  let buf: Buffer;
  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) return { ...base, contentHash: '', size: 0, omitted: 'unreadable' };
    size = stat.size;
    buf = await handle.readFile();
  } catch {
    return { ...base, contentHash: '', size, omitted: 'unreadable' };
  } finally {
    await handle.close().catch(() => {
      // A handle that cannot be closed does not invalidate what was read.
    });
  }

  // Node's validator rather than a utf8 round trip: the round trip allocated a
  // whole string and a second buffer to answer a question about bytes, which
  // on an unbounded capture is three copies of a large file in memory at once.
  const encoding = isUtf8(buf) ? 'utf8' : 'base64';
  return {
    ...base,
    contentHash: createHash('sha256').update(buf).digest('hex'),
    size: buf.byteLength,
    content: buf.toString(encoding),
    encoding,
  };
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
