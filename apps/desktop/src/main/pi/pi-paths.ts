/**
 * Filesystem locations for pi state, without constructing a runtime.
 *
 * The Bridge writes `models.json` here at launch. Importing `runtime.ts` for
 * the path would load `ModelRuntime` (and the rest of the vendor package)
 * before a window exists. Keep the path math here so launch stays cheap.
 */
import { join } from 'node:path';

/** Where pi's auth and model files live, given Foundry's support directory. */
export function piStateDir(supportDir: string): string {
  return join(supportDir, 'pi');
}
