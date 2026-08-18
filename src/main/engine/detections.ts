/**
 * Live detection sessions, keyed by id.
 *
 * Separate from `RunRegistry` on purpose: a detection has no worktree, no
 * branch, no trace and no merge, and giving it a fake run row would put rows in
 * the trace that no pipeline produced.
 *
 * Finished sessions are kept briefly so a panel reopened right after one ends
 * still finds its result, then dropped: this is a cache, not a history.
 */

import type { OneShotFactory } from '../pi/oneshot.js';
import { DetectSession, type DetectionState, type DetectSessionDeps } from './detect-session.js';

/** How long a finished detection stays readable. */
const KEEP_MS = 10 * 60_000;
/** Hard cap, so a session that never ends cannot accumulate forever. */
const MAX_KEPT = 20;

export class Detections {
  private readonly sessions = new Map<string, DetectSession>();
  private readonly endedAt = new Map<string, number>();

  constructor(
    private readonly oneShot: OneShotFactory,
    private readonly onProgress: (state: DetectionState) => void,
  ) {}

  start(deps: Omit<DetectSessionDeps, 'onChange' | 'oneShot'>): DetectSession {
    this.sweep();
    const session = new DetectSession({
      ...deps,
      oneShot: this.oneShot,
      onChange: (state) => {
        if (state.status !== 'running' && state.status !== 'verifying') {
          this.endedAt.set(state.detectionId, Date.now());
        }
        this.onProgress(state);
      },
    });
    this.sessions.set(session.detectionId, session);
    // Deliberately not awaited: the caller is an IPC handler answering a click,
    // and the turn it starts can take minutes. `run()` never rejects, so there
    // is no unhandled rejection to leak here.
    void session.run();
    return session;
  }

  get(detectionId: string): DetectionState | null {
    return this.sessions.get(detectionId)?.snapshot() ?? null;
  }

  cancel(detectionId: string): boolean {
    const session = this.sessions.get(detectionId);
    if (!session) return false;
    session.cancel();
    return true;
  }

  /** Cancels everything in flight; called when the app is quitting. */
  cancelAll(): void {
    for (const session of this.sessions.values()) session.cancel();
    this.sessions.clear();
    this.endedAt.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, at] of this.endedAt) {
      if (now - at < KEEP_MS) continue;
      this.sessions.delete(id);
      this.endedAt.delete(id);
    }
    if (this.sessions.size <= MAX_KEPT) return;
    // Oldest finished first; a live session is never evicted.
    const finished = [...this.endedAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of finished.slice(0, this.sessions.size - MAX_KEPT)) {
      this.sessions.delete(id);
      this.endedAt.delete(id);
    }
  }
}
