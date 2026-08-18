/**
 * Live setup-script generation sessions. Same shape as `detections.ts` but
 * for the worktree bootstrap's one-click AI path.
 */

import type { OneShotFactory } from '../pi/oneshot.js';
import { SetupSession, type SetupState, type SetupSessionDeps } from './setup-session.js';

const KEEP_MS = 10 * 60_000;
const MAX_KEPT = 20;

export class Setups {
  private readonly sessions = new Map<string, SetupSession>();
  private readonly endedAt = new Map<string, number>();

  constructor(
    private readonly oneShot: OneShotFactory,
    private readonly onProgress: (state: SetupState) => void,
  ) {}

  start(deps: Omit<SetupSessionDeps, 'onChange' | 'oneShot'>): SetupSession {
    this.sweep();
    const session = new SetupSession({
      ...deps,
      oneShot: this.oneShot,
      onChange: (state) => {
        if (state.status !== 'running') {
          this.endedAt.set(state.setupId, Date.now());
        }
        this.onProgress(state);
      },
    });
    this.sessions.set(session.setupId, session);
    void session.run();
    return session;
  }

  get(setupId: string): SetupState | null {
    return this.sessions.get(setupId)?.snapshot() ?? null;
  }

  cancel(setupId: string): boolean {
    const session = this.sessions.get(setupId);
    if (!session) return false;
    session.cancel();
    return true;
  }

  cancelAll(): void {
    for (const s of this.sessions.values()) s.cancel();
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
    const finished = [...this.endedAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of finished.slice(0, this.sessions.size - MAX_KEPT)) {
      this.sessions.delete(id);
      this.endedAt.delete(id);
    }
  }
}
