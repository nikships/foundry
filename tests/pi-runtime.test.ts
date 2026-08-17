/**
 * Where the agent runtime keeps its state.
 *
 * The runtime's own default is the user's install (`~/.pi/agent`), which holds
 * their credentials and model catalog. Foundry writing there would be a bug you
 * only find after it has already overwritten something, so every path is pinned
 * under Foundry's Application Support directory and this suite is what keeps it
 * that way: it runs a real `ModelRuntime.create` against a temp directory and
 * asserts nothing appeared in the user's home.
 *
 * The memoization is tested for the same reason it exists: building a runtime
 * restores catalogs and checks credentials, so two phases must not each do it,
 * and a build that failed must not be the answer every later run gets.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './tmp.js';
import { modelRuntime, piStateDir, resetModelRuntimes } from '../src/main/pi/runtime.js';

afterEach(() => {
  resetModelRuntimes();
});

/** What the user's own agent install looks like, so a stray write is visible. */
function homeStateSnapshot(): string[] {
  const dir = join(homedir(), '.pi');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

describe('where the runtime keeps its state', () => {
  it('puts every path under Foundry’s support directory', () => {
    expect(piStateDir('/tmp/support')).toBe('/tmp/support/pi');
    // Not the user's home, under any circumstance.
    expect(piStateDir('/tmp/support')).not.toContain(homedir());
  });

  it('creates its own directory and writes nothing into the user’s ~/.pi', async () => {
    const before = homeStateSnapshot();
    const support = tempDir('foundry-pi-runtime-');

    await modelRuntime(support);

    expect(existsSync(join(support, 'pi'))).toBe(true);
    // The user's install is untouched: same entries before and after, including
    // the case where they have no install at all.
    expect(homeStateSnapshot()).toEqual(before);
  });

  it('builds one runtime per support directory rather than one per caller', async () => {
    const support = tempDir('foundry-pi-runtime-');
    const [first, second] = await Promise.all([modelRuntime(support), modelRuntime(support)]);
    // Two phases starting at once must not both restore the catalog.
    expect(second).toBe(first);
    expect(await modelRuntime(support)).toBe(first);
  });

  it('keeps two support directories on separate runtimes', async () => {
    const one = tempDir('foundry-pi-runtime-a-');
    const two = tempDir('foundry-pi-runtime-b-');
    expect(await modelRuntime(one)).not.toBe(await modelRuntime(two));
    expect(existsSync(join(one, 'pi'))).toBe(true);
    expect(existsSync(join(two, 'pi'))).toBe(true);
  });

  it('does not cache a failed build, so a transient failure is retried', async () => {
    const support = tempDir('foundry-pi-runtime-');
    // A file where the state directory belongs is how a half-written install
    // presents itself: mkdir fails, and the next run must get a fresh attempt
    // rather than the first run's rejection forever.
    const state = join(support, 'pi');
    writeFileSync(state, 'not a directory');
    await expect(modelRuntime(support)).rejects.toThrow();

    rmSync(state);
    mkdirSync(state, { recursive: true });
    await expect(modelRuntime(support)).resolves.toBeDefined();
  });

  it('forgets its runtimes when reset, so a test cannot inherit another’s', async () => {
    const support = tempDir('foundry-pi-runtime-');
    const first = await modelRuntime(support);
    resetModelRuntimes();
    expect(await modelRuntime(support)).not.toBe(first);
  });
});
