/**
 * Registers the temp-directory sweep for every suite. Wired through
 * `setupFiles` in `vitest.config.ts` so a new suite inherits cleanup by using
 * `tempDir` rather than by remembering to add a hook.
 */

import { afterAll } from 'vitest';
import { cleanupTempDirs } from './tmp.js';

afterAll(() => {
  cleanupTempDirs();
});
