/**
 * Live panel sessions, keyed by id.
 *
 * Separate from `RunRegistry` on purpose: a panel session has no worktree, no
 * branch, no trace and no merge, and giving it a fake run row would put rows in
 * the trace that no pipeline produced.
 *
 * Finished sessions are kept briefly so a panel reopened right after one ends
 * still finds its result, then dropped: this is a cache, not a history.
 */

export const SESSION_KEEP_MS = 10 * 60_000;
/** Hard cap, so a session that never ends cannot accumulate forever. */
export const SESSION_MAX_KEPT = 20;

export interface Cancellable {
  cancel(): void;
}

export class SessionRegistry<T extends Cancellable> {
  private readonly sessions = new Map<string, T>();
  private readonly endedAt = new Map<string, number>();
  private readonly keepMs: number;
  private readonly maxKept: number;
  private readonly now: () => number;

  constructor(opts?: { keepMs?: number; maxKept?: number; now?: () => number }) {
    this.keepMs = opts?.keepMs ?? SESSION_KEEP_MS;
    this.maxKept = opts?.maxKept ?? SESSION_MAX_KEPT;
    this.now = opts?.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  add(id: string, session: T): void {
    this.sweep();
    this.sessions.set(id, session);
    // A replacement for this id is live again; an old endedAt would let sweep
    // evict it while it is still running.
    this.endedAt.delete(id);
  }

  markEnded(id: string): void {
    this.endedAt.set(id, this.now());
  }

  /** A session that resumed work must not be swept as finished. */
  markLive(id: string): void {
    this.endedAt.delete(id);
  }

  get(id: string): T | undefined {
    return this.sessions.get(id);
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
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

  sweep(): void {
    const now = this.now();
    for (const [id, at] of this.endedAt) {
      if (now - at < this.keepMs) continue;
      this.sessions.delete(id);
      this.endedAt.delete(id);
    }
    if (this.sessions.size <= this.maxKept) return;
    // Oldest finished first; a live session is never evicted.
    const finished = [...this.endedAt.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of finished.slice(0, this.sessions.size - this.maxKept)) {
      this.sessions.delete(id);
      this.endedAt.delete(id);
    }
  }
}

/**
 * The public surface every panel registry exposes: start a turn, read it,
 * cancel it, and — where the feature supports one — send a follow-up message
 * to a session it still retains. Everything else stays internal.
 */
export interface PanelRegistry<TStart, TState> {
  start(deps: TStart): string;
  get(id: string): TState | null;
  cancel(id: string): boolean;
  cancelAll(): void;
  /** Returns the refusal reason, or null when the session took the message. */
  message(id: string, text: string): string | null;
}

export function createPanelRegistry<TSession extends Cancellable, TStart, TState>(opts: {
  create: (deps: TStart, onChange: (state: TState) => void) => TSession;
  idOf: (session: TSession) => string;
  snapshot: (session: TSession) => TState;
  isLive: (state: TState) => boolean;
  run: (session: TSession) => Promise<void>;
  onProgress: (state: TState) => void;
  /** Feature-specific follow-up; absent means the panel takes no messages. */
  message?: (session: TSession, text: string) => string | null;
  keepMs?: number;
  maxKept?: number;
  now?: () => number;
}): PanelRegistry<TStart, TState> {
  const registry = new SessionRegistry<TSession>({
    keepMs: opts.keepMs,
    maxKept: opts.maxKept,
    now: opts.now,
  });
  return {
    start(deps) {
      const session = opts.create(deps, (state) => {
        // A finished session may resume on a follow-up message, so liveness is
        // re-read on every change rather than latched by the first finish.
        if (opts.isLive(state)) registry.markLive(opts.idOf(session));
        else registry.markEnded(opts.idOf(session));
        opts.onProgress(state);
      });
      registry.add(opts.idOf(session), session);
      // Deliberately not awaited: the caller is an IPC handler answering a
      // click, and the turn it starts can take minutes. `run()` never rejects,
      // so there is no unhandled rejection to leak here.
      void opts.run(session);
      return opts.idOf(session);
    },
    get(id) {
      const session = registry.get(id);
      return session ? opts.snapshot(session) : null;
    },
    cancel(id) {
      return registry.cancel(id);
    },
    cancelAll() {
      registry.cancelAll();
    },
    message(id, text) {
      if (!opts.message) return 'this panel does not take messages';
      const session = registry.get(id);
      if (!session) return 'session not found';
      return opts.message(session, text);
    },
  };
}
