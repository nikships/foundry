/**
 * The PATH a child process is spawned with.
 *
 * A macOS app launched from the Dock inherits launchd's PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), where none of node, npm, cargo, go or uv
 * exist. Every project command and every agent CLI is spawned without a shell,
 * so a stunted PATH turns a correct command into "No such file or directory" —
 * which reads as a wrong command rather than a missing PATH, and is exactly the
 * failure that made command detection look broken.
 */

import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __setResolvedEnvForTest, resolvedEnv, spawnEnv } from '../src/main/system/env.js';
import { runCommand } from '../src/main/engine/commands.js';

afterEach(() => __setResolvedEnvForTest(null));

/** A directory holding one executable that exists nowhere on the real PATH. */
function binDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-bin-'));
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\necho found-me\n');
  chmodSync(file, 0o755);
  return dir;
}

describe('spawnEnv', () => {
  it('replaces PATH with the resolved one, and leaves everything else alone', () => {
    __setResolvedEnvForTest({ path: '/custom/bin', via: 'login-shell' });
    const env = spawnEnv();
    expect(env.PATH).toBe('/custom/bin');
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('lets a caller override any variable, including PATH', () => {
    __setResolvedEnvForTest({ path: '/custom/bin', via: 'login-shell' });
    expect(spawnEnv({ PATH: '/override' }).PATH).toBe('/override');
    expect(spawnEnv({ FOUNDRY_TEST: 'yes' }).FOUNDRY_TEST).toBe('yes');
  });

  it('falls back to the inherited PATH before resolution finishes, rather than throwing', () => {
    __setResolvedEnvForTest(null);
    expect(resolvedEnv().path).toBe(process.env.PATH ?? '');
    expect(() => spawnEnv()).not.toThrow();
  });
});

describe('runCommand under the resolved PATH', () => {
  it('finds a binary that is only on the resolved PATH', async () => {
    const dir = binDir('foundry-probe-tool');
    __setResolvedEnvForTest({ path: `${dir}:/usr/bin:/bin`, via: 'login-shell' });

    const result = await runCommand({
      argv: ['foundry-probe-tool'],
      cwd: tmpdir(),
      timeoutMs: 20_000,
    });
    expect(result.passed).toBe(true);
    expect(result.outputTail).toContain('found-me');
  });

  it('fails to spawn the same binary under a launchd-shaped PATH', async () => {
    // The regression this guards: with the GUI's PATH the command is correct
    // and still cannot run, which the UI must not report as a failing test.
    binDir('foundry-probe-tool');
    __setResolvedEnvForTest({ path: '/usr/bin:/bin:/usr/sbin:/sbin', via: 'fallback' });

    const result = await runCommand({
      argv: ['foundry-probe-tool'],
      cwd: tmpdir(),
      timeoutMs: 20_000,
    });
    expect(result.passed).toBe(false);
    // exitCode null (not a number) is what separates "never ran" from "ran and
    // failed"; the detection panel keys its PATH hint off exactly this.
    expect(result.exitCode).toBeNull();
    expect(result.outputTail).toMatch(/ENOENT|not found|No such file/i);
  });
});
