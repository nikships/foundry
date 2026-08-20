/**
 * Temp directories that clean themselves up.
 *
 * Suites build real git repositories on disk rather than mocking git, so a
 * suite that forgets to remove its scratch dir leaks it until the next reboot:
 * `$TMPDIR` is per-user on macOS and nothing sweeps it. Left alone this reaches
 * thousands of directories, and with `core.fsmonitor` enabled each abandoned
 * repo also strands a `git fsmonitor--daemon` (8 IPC threads apiece) until the
 * process table is exhausted and unrelated commands start dying.
 *
 * `tempDir` records every path it hands out; the `afterAll` hook installed by
 * `tests/setup-tmp.ts` removes them when the file finishes. Vitest isolates
 * each test file in its own module registry, so the list below only ever holds
 * the directories belonging to the file currently running — a worker can never
 * delete a sibling's fixtures.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/** `mkdtempSync` under the OS temp dir, registered for automatic removal. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Removes every directory handed out by `tempDir`. Installed globally as an
 * `afterAll`; a suite that needs the disk reclaimed mid-run can call it early,
 * and a later `tempDir` simply starts a fresh list.
 */
export function cleanupTempDirs(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}
