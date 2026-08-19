/**
 * `terminate()` is the kill the relaunch sweep and the Bridge manager both use,
 * and its two properties are the ones a fire-and-forget signal cannot offer: it
 * escalates to SIGKILL when SIGTERM is ignored, and it answers whether the pid
 * is actually gone. A sweep that closed a row on the strength of a signal it
 * never confirmed would forget a process still holding a port.
 *
 * Real children rather than a mocked `process.kill`: signal disposition is the
 * behaviour under test, and a fake would only assert that a function was
 * called.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { childPids, isAlive, terminate } from '../src/main/system/procs.js';

const children: ChildProcess[] = [];

afterEach(() => {
  while (children.length) {
    const pid = children.pop()?.pid;
    try {
      if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

function run(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(child);
  return child;
}

/**
 * A pid exists the moment `spawn` returns, but the script has not run yet — a
 * signal sent in that window hits a process that has installed no handler, and
 * a test asserting on signal disposition would be measuring node's startup. So
 * the child announces itself on stdout once it is actually ready.
 */
async function ready(child: ChildProcess): Promise<number> {
  const pid = child.pid;
  if (!pid) throw new Error('child never got a pid');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child never reported ready')), 10_000);
    child.stdout?.once('data', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return pid;
}

describe('terminate', () => {
  it('is true for a pid that was already gone, so a stale row still closes', async () => {
    const child = run("console.log('ready'); process.exit(0);");
    const pid = await ready(child);
    const deadline = Date.now() + 5_000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(20);

    expect(await terminate(pid)).toBe(true);
  }, 20_000);

  it('takes SIGTERM for the answer when the child honours it', async () => {
    const child = run("console.log('ready'); setInterval(() => {}, 1000);");
    const pid = await ready(child);

    expect(await terminate(pid)).toBe(true);
    expect(isAlive(pid)).toBe(false);
  }, 20_000);

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    // A proxy wedged mid-request, or any child that installed a handler and
    // then failed to exit: SIGTERM alone would leave it holding its port.
    const child = run(
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
    );
    const pid = await ready(child);

    const started = Date.now();
    expect(await terminate(pid, 300)).toBe(true);
    expect(isAlive(pid)).toBe(false);
    // It waited out the grace period rather than skipping straight to the kill.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  }, 20_000);

  it('kills a descendant before its parent, so a tree leaves nothing behind', async () => {
    // `killTree` enumerates with `pgrep -P` at signal time, which is what
    // reaches a grandchild that is still attached to the process it spawned.
    const parent = run(
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); console.log('ready'); setInterval(() => {}, 1000);",
    );
    const parentPid = await ready(parent);

    const deadline = Date.now() + 5_000;
    let kids: number[] = [];
    while (!kids.length && Date.now() < deadline) {
      kids = childPids(parentPid);
      if (!kids.length) await sleep(20);
    }
    expect(kids).toHaveLength(1);
    const childPid = kids[0] as number;

    expect(await terminate(parentPid)).toBe(true);
    const gone = Date.now() + 5_000;
    while (isAlive(childPid) && Date.now() < gone) await sleep(20);
    expect(isAlive(childPid)).toBe(false);
    expect(isAlive(parentPid)).toBe(false);
  }, 20_000);
});
