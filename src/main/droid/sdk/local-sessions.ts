/**
 * Read-only view of droid's local session store (`~/.factory/sessions`),
 * via the SDK's own store reader — the same logic the droid CLI uses, so the
 * per-cwd directory layout and archived-session filtering stay droid's
 * problem, not ours. Smith uses this to resolve the session id a fresh spawn
 * just created (newest session for the project's cwd) so a later app launch
 * can `droid --resume` it.
 */

import { listSessions } from '@factory/droid-sdk/node';

export interface LocalDroidSession {
  id: string;
  createdTime: Date;
}

/** Sessions whose cwd matches `cwd`, newest first. */
export async function localDroidSessions(cwd: string, limit = 5): Promise<LocalDroidSession[]> {
  const sessions = await listSessions({ cwd, limit });
  return sessions.map((session) => ({ id: session.id, createdTime: session.createdTime }));
}
