/**
 * One phase's correction rollback: snapshot, rewind, restore, re-snapshot.
 *
 * The invariant "transport restores dirty-at-start files, Foundry restores
 * the rest, then re-snapshot the baseline and re-pin the anchor" lives here
 * and nowhere else. The agent runner only asks `rewindIfDue` before a retry.
 */

import { join } from 'node:path';
import type { RewindOutcome } from '../pi/transport.js';
import { restoreToPhaseStart, snapshot, type Snapshot } from './boundary.js';

/**
 * The session surface rewind needs. Structural so a test can drive the
 * ordering without constructing a live `AgentSession`.
 */
export interface RewindableSession {
  readonly canRewind: boolean;
  readonly lastUserMessageId: string | null;
  rewind(input: { messageId: string; paths: string[] }): Promise<RewindOutcome | null>;
}

/** Counts the rewind path leaves on a correction event when it ran. */
export interface RewindTrace extends RewindOutcome {
  worktreeRestoredCount?: number;
  worktreeCleanedCount?: number;
}

export class PhaseRewinder {
  private anchorMessageId: string | null = null;

  private constructor(
    private readonly cwd: string,
    private readonly session: RewindableSession,
    private readonly rewindAfterCorrections: number,
    private before: Snapshot,
  ) {}

  static async create(
    cwd: string,
    session: RewindableSession,
    rewindAfterCorrections: number,
  ): Promise<PhaseRewinder> {
    return new PhaseRewinder(cwd, session, rewindAfterCorrections, await snapshot(cwd));
  }

  /** The boundary baseline. Replaced after a successful rewind. */
  baseline(): Snapshot {
    return this.before;
  }

  /**
   * The first user-message id of the phase is the rewind anchor: getRewindInfo
   * at that id describes files as they were at phase start.
   */
  noteAnchor(): void {
    if (this.anchorMessageId) return;
    const id = this.session.lastUserMessageId;
    if (id) this.anchorMessageId = id;
  }

  /**
   * On the Nth correction, rewind instead of only appending. Failure is
   * non-fatal: the caller still sends the append-style correction prompt.
   * Rewind consumes the correction attempt — it never extends budgets.
   */
  async rewindIfDue(correctionIndex: number): Promise<RewindTrace | null> {
    if (this.rewindAfterCorrections <= 0 || correctionIndex < this.rewindAfterCorrections) {
      return null;
    }
    if (!this.session.canRewind) return null;
    const messageId = this.anchorMessageId ?? this.session.lastUserMessageId;
    if (!messageId) return null;

    const outcome = await this.session.rewind({
      messageId,
      paths: pathsForRewind(this.cwd, this.before),
    });
    if (!outcome) return null;

    // Transport rewind restores dirty-at-start files only. Foundry then puts
    // clean-at-start tracked deletions and new untracked files back too.
    const worktree = await restoreToPhaseStart(this.cwd, this.before);

    // Files are back to phase-start content: the retry's boundary baseline is
    // the restored tree, not the corrupted intermediate.
    this.before = await snapshot(this.cwd);
    // Successor conversation still carries the anchor message id.
    this.anchorMessageId = messageId;
    return {
      ...outcome,
      worktreeRestoredCount: worktree.restored,
      worktreeCleanedCount: worktree.cleaned,
    };
  }
}

/**
 * Snapshot paths are worktree-relative; a transport may report the same file
 * as a cwd-relative or absolute path. Emit both so `AgentSession.rewind` can
 * match on a plain path list without knowing how the snapshot was formatted.
 */
function pathsForRewind(cwd: string, snap: Snapshot): string[] {
  const paths = new Set<string>();
  for (const file of snap.files) {
    const rel = stripWorktreePrefix(file.path, cwd);
    if (!rel) continue;
    paths.add(rel);
    paths.add(join(cwd, rel).replace(/\\/g, '/'));
  }
  return [...paths];
}

function stripWorktreePrefix(path: string, worktree: string): string {
  const normalised = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const root = worktree.replace(/\\/g, '/').replace(/\/$/, '');
  if (normalised === root) return '';
  if (normalised.startsWith(`${root}/`)) return normalised.slice(root.length + 1);
  return normalised;
}
