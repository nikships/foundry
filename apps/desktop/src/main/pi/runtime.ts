/**
 * The one `ModelRuntime` the app runs agents on.
 *
 * Pi's default runtime reads and writes `~/.pi/agent` — the user's own pi
 * install. Foundry must never touch it: an app that silently rewrote a
 * developer's credentials or model catalog would be a bug you only find after
 * it has already happened. Every path here is pinned under Foundry's own
 * Application Support directory, so the two installs cannot see each other.
 *
 * Building a runtime restores catalogs and checks credentials, which is work
 * worth doing once rather than per phase, so it is memoized per base directory.
 * The promise itself is cached: two runs starting at once must not both build.
 */

import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { registerDirectProviders } from './direct-providers.js';
import { piStateDir } from './pi-paths.js';

export { piStateDir } from './pi-paths.js';

const runtimes = new Map<string, Promise<ModelRuntime>>();

/**
 * The runtime for this support directory, built at most once.
 *
 * A failed build is not cached: a runtime that could not restore its catalog
 * once (offline, a half-written file) should be retried by the next run rather
 * than poisoning every run until restart.
 */
export function modelRuntime(supportDir: string): Promise<ModelRuntime> {
  const dir = piStateDir(supportDir);
  const cached = runtimes.get(dir);
  if (cached) return cached;

  const building = create(dir).catch((err: unknown) => {
    runtimes.delete(dir);
    throw err;
  });
  runtimes.set(dir, building);
  return building;
}

async function create(dir: string): Promise<ModelRuntime> {
  mkdirSync(dir, { recursive: true });
  const runtime = await ModelRuntime.create({
    authPath: join(dir, 'auth.json'),
    modelsPath: join(dir, 'models.json'),
    modelsStorePath: join(dir, 'models-store.json'),
  });
  // Before the runtime is handed out, so no caller can look for a provider
  // Foundry adds and find it missing. Registration stores no credential: these
  // providers stay unavailable until a key is saved for one.
  registerDirectProviders(runtime);
  return runtime;
}

/** Drops the memoized runtimes. Tests use this to isolate; nothing else should. */
export function resetModelRuntimes(): void {
  runtimes.clear();
}
