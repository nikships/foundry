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

import { execFileSync } from 'node:child_process';
import { writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempDir } from '../../helpers/tmp.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveEnv,
  resolvedEnv,
  setResolvedEnvForTest,
  spawnEnv,
} from '../../../src/main/system/env.js';
import { runCommand } from '../../../src/main/engine/commands.js';

const originalPath = process.env.PATH;
const originalShell = process.env.SHELL;

afterEach(() => {
  setResolvedEnvForTest(null);
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
});

/** A directory holding one executable that exists nowhere on the real PATH. */
function binDir(name: string): string {
  const dir = tempDir('foundry-bin-');
  const file = join(dir, name);
  writeFileSync(file, '#!/bin/sh\necho found-me\n');
  chmodSync(file, 0o755);
  return dir;
}

describe('spawnEnv', () => {
  it('replaces PATH with the resolved one, and leaves everything else alone', () => {
    setResolvedEnvForTest({ path: '/custom/bin', via: 'login-shell' });
    const env = spawnEnv();
    expect(env.PATH).toBe('/custom/bin');
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('lets a caller override any variable, including PATH', () => {
    setResolvedEnvForTest({ path: '/custom/bin', via: 'login-shell' });
    expect(spawnEnv({ PATH: '/override' }).PATH).toBe('/override');
    expect(spawnEnv({ FOUNDRY_TEST: 'yes' }).FOUNDRY_TEST).toBe('yes');
  });

  it('carries no credential overlay, because no credential is the app’s to hand out', () => {
    // Provider credentials live in pi's own store and the Bridge's auth
    // directory. A spawn overlay would put one in the environment of every
    // child the app starts.
    setResolvedEnvForTest({ path: '/custom/bin', via: 'login-shell' });
    expect(spawnEnv().FACTORY_API_KEY).toBe(process.env.FACTORY_API_KEY);
  });

  it('strips the in-process Tavily key so no child inherits it', () => {
    // The key is exported into process.env for the in-process pi extension;
    // it is not the business of any spawned child.
    setResolvedEnvForTest({ path: '/custom/bin', via: 'login-shell' });
    process.env.TAVILY_API_KEY = 'tvly-in-process-only';
    try {
      expect(spawnEnv().TAVILY_API_KEY).toBeUndefined();
      // An explicit override still wins, as it does for PATH.
      expect(spawnEnv({ TAVILY_API_KEY: 'explicit' }).TAVILY_API_KEY).toBe('explicit');
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });

  it('falls back to the inherited PATH before resolution finishes, rather than throwing', () => {
    setResolvedEnvForTest(null);
    expect(resolvedEnv().path).toBe(process.env.PATH ?? '');
    expect(() => spawnEnv()).not.toThrow();
  });
});

describe('resolveEnv', () => {
  it('installs the login-shell PATH into the process used by in-process agent tools', async () => {
    const dir = tempDir('foundry-shell-');
    const shell = join(dir, 'login-shell');
    const toolDir = binDir('agent-only-tool');
    writeFileSync(
      shell,
      `#!/bin/sh\nprintf '%s' '__FOUNDRY_PATH_BEGIN__${toolDir}:/usr/bin:/bin__FOUNDRY_PATH_END__'\n`,
    );
    chmodSync(shell, 0o755);
    process.env.SHELL = shell;
    process.env.PATH = '/usr/bin:/bin';

    const env = await resolveEnv();

    expect(env.via).toBe('login-shell');
    expect(env.path.split(':')).toContain(toolDir);
    expect(process.env.PATH).toBe(env.path);
    expect(execFileSync('/bin/bash', ['-c', 'agent-only-tool'], { encoding: 'utf8' }).trim()).toBe(
      'found-me',
    );
  });
});

describe('runCommand under the resolved PATH', () => {
  it('finds a binary that is only on the resolved PATH', async () => {
    const dir = binDir('foundry-probe-tool');
    setResolvedEnvForTest({ path: `${dir}:/usr/bin:/bin`, via: 'login-shell' });

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
    setResolvedEnvForTest({ path: '/usr/bin:/bin:/usr/sbin:/sbin', via: 'fallback' });

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
