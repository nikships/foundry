/**
 * Reading back the documents a phase actually wrote.
 *
 * A document phase's envelope names its output in `artifacts`; the envelope is
 * the claim and the file is the work. The `artifacts_exist` gate already
 * proved the path was there when the phase ended, so this is the same evidence
 * a gate looked at, read for a person instead of a check.
 *
 * Every path is resolved against the run's own worktree and refused if it
 * leaves it. A merged run has no worktree left, so it falls back to the
 * project checkout the merge landed in — the same file, at the same relative
 * path, which is the whole point of merging it.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { EnvelopeRow, PhaseRow, RunRow } from '@shared/types.js';
import type {
  RunArtifactFile,
  RunArtifactReason,
  RunArtifactResult,
} from '@shared/ipc-contract.js';

/** One document's ceiling. A plan is prose; anything larger is not being read. */
const FILE_CAP = 512 * 1024;

/** Envelopes declare a handful of paths; a longer list is a runaway agent. */
const MAX_FILES = 24;

export interface ArtifactTracer {
  phase(phaseId: string): PhaseRow | null;
  run(runId: string): RunRow | null;
  envelopes(runId: string): EnvelopeRow[];
}

export interface ArtifactScope {
  tracer: ArtifactTracer;
  /**
   * The project checkout, used only when the run's worktree is gone. A merged
   * run's artifacts live there; a discarded one's are gone either way, and the
   * read simply misses rather than reporting a file from another run.
   */
  projectPath?: string;
}

/**
 * The paths a phase declared, newest valid envelope first.
 *
 * A phase re-entered through `feedbackTo` leaves several rows on one
 * `phase_id`, so the last valid one is what the run finished with. An invalid
 * envelope is not a claim at all and is skipped.
 */
function declaredPaths(envelopes: EnvelopeRow[], phaseId: string): string[] {
  let latest: string[] = [];
  for (const envelope of envelopes) {
    if (envelope.phaseId !== phaseId || !envelope.valid) continue;
    const value = envelope.payload.artifacts;
    if (Array.isArray(value)) {
      latest = value.filter(
        (entry): entry is string => typeof entry === 'string' && !!entry.trim(),
      );
    }
  }
  return latest;
}

/**
 * `root`-relative path resolved to an absolute one, or null when it escapes.
 *
 * String math alone cannot see a symlink, and an artifact path comes from a
 * model: the leaf must not be a link, and what the path resolves through must
 * land back inside the root.
 */
function insideRoot(root: string, relPath: string): string | null {
  if (isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) return null;
  const abs = resolve(root, relPath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (lstatOrNull(abs)?.isSymbolicLink()) return null;
  const realRoot = realOrNull(root);
  const realAbs = realOrNull(abs);
  if (!realRoot || !realAbs) return null;
  const realRel = relative(realRoot, realAbs);
  if (realRel.startsWith('..') || isAbsolute(realRel)) return null;
  return join(root, rel);
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** A document, or why this path did not produce one. */
function readOne(root: string, relPath: string): RunArtifactFile | RunArtifactReason {
  const abs = insideRoot(root, relPath);
  if (!abs) return 'not_found';
  const stat = statOrNull(abs);
  if (!stat) return 'not_found';
  // A phase may legitimately declare a directory it filled; there is no single
  // document to render for it, so it reports rather than being read.
  if (!stat.isFile()) return 'not_text';
  try {
    const buffer = readFileSync(abs);
    const head = buffer.subarray(0, Math.min(buffer.length, FILE_CAP));
    // A NUL in the first block is the cheap, reliable binary tell; a rendered
    // binary is noise, and the operator wants to know that rather than see it.
    if (head.includes(0)) return 'not_text';
    return {
      path: relPath,
      content: head.toString('utf8'),
      bytes: stat.size,
      truncated: buffer.length > head.length,
    };
  } catch {
    return 'unreadable';
  }
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function only(reason: RunArtifactReason): RunArtifactResult {
  return { files: [], missing: [], reason };
}

/**
 * The documents one phase declared, read from disk.
 *
 * Always answers. Nothing readable carries a single reason; a partial read
 * carries the files it got plus one `missing` entry per path it did not, so
 * the operator can tell "the agent never wrote it" from "the worktree is
 * gone".
 */
export function readPhaseArtifacts(scope: ArtifactScope, phaseId: string): RunArtifactResult {
  const phase = scope.tracer.phase(phaseId);
  if (!phase) return only('run_not_found');
  const run = scope.tracer.run(phase.runId);
  if (!run) return only('run_not_found');

  const paths = declaredPaths(scope.tracer.envelopes(phase.runId), phaseId);
  if (!paths.length) return only('no_artifacts');

  const root = artifactRoot(run, scope.projectPath);
  if (!root) return only('worktree_gone');

  const files: RunArtifactFile[] = [];
  const missing: { path: string; reason: RunArtifactReason }[] = [];
  for (const relPath of paths.slice(0, MAX_FILES)) {
    const result = readOne(root, relPath);
    if (typeof result === 'string') missing.push({ path: relPath, reason: result });
    else files.push(result);
  }
  return { files, missing, root, ...(files.length ? {} : { reason: 'not_found' }) };
}

/**
 * Where a run's declared paths resolve from.
 *
 * The worktree while it exists, then the project checkout for a merged run.
 * An unmerged run whose worktree was discarded gets nothing: its files were
 * never landed, and reading the checkout would show whatever is at that path
 * now and call it this run's output.
 */
function artifactRoot(run: RunRow, projectPath: string | undefined): string | null {
  if (run.worktreePath && existsSync(run.worktreePath)) return run.worktreePath;
  if (run.merged && projectPath && existsSync(projectPath)) return projectPath;
  return null;
}
