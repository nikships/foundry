/**
 * Shared per-suite setup, wired through `setupFiles` in `vitest.config.ts`:
 * environment hardening plus the temp-directory sweep, so a new suite
 * inherits both by using `tempDir` rather than by remembering to add a hook.
 */

// Engine suites build real git scratch repos under `tempDir` and commit with
// test identities (`test@foundry.local`). Amp orbs force SSH commit signing
// system-wide (`/etc/gitconfig` → `amp-sign-commit`), and that helper only
// holds a key for the Amp-managed identity, so every scratch commit fails
// with "No signing key is available for this commit". Ignoring the system
// git config keeps the scratch repos hermetic; identity and signing for real
// checkouts are untouched. Engine-spawned git inherits this process env
// (`spawnEnv()` spreads `process.env`).
process.env.GIT_CONFIG_NOSYSTEM = '1';

import { afterAll } from 'vitest';
import { cleanupTempDirs } from './tmp.js';

afterAll(() => {
  cleanupTempDirs();
});
