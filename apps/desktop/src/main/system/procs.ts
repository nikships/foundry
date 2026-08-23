/**
 * Child registry. Every process the engine spawns is registered here and in the
 * trace's `processes` table, because the kill path has to be able to find a
 * child from another app launch — and has to verify the recorded command still
 * matches the pid before signalling, so a recycled pid is never killed.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnEnv } from './env.js';

/** How long a SIGTERM is given to work before the tree is SIGKILLed. */
const TERMINATE_GRACE_MS = 3_000;

interface Entry {
  pid: number;
  runId: string;
  command: string;
  child: ChildProcess;
}

const registry = new Map<number, Entry>();

export function register(runId: string, child: ChildProcess, command: string): void {
  if (!child.pid) return;
  registry.set(child.pid, { pid: child.pid, runId, command, child });
  child.once('exit', () => {
    if (child.pid) registry.delete(child.pid);
  });
}

export function unregister(pid: number | undefined): void {
  if (pid) registry.delete(pid);
}

export function pidsForRun(runId: string): number[] {
  return [...registry.values()].filter((e) => e.runId === runId).map((e) => e.pid);
}

/** Children first, then the parent: killing a shell's parent orphans its tree. */
export function killTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of childPids(pid)) killTree(child, signal);
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone; the sweep will finalise its row.
  }
}

/**
 * SIGTERM the tree, then SIGKILL it if it will not go. Resolves true once the
 * pid is gone, false if it survived even the kill (a stopped or unkillable
 * process). Already-dead is true.
 *
 * `killTree` enumerates descendants with `pgrep -P` at signal time, so a
 * grandchild that reparented to launchd before the sweep ran is out of reach —
 * which is why the escalation is worth waiting for rather than fire-and-forget.
 */
export async function terminate(pid: number, graceMs = TERMINATE_GRACE_MS): Promise<boolean> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!isAlive(pid)) return true;
    killTree(pid, signal);
    const deadline = Date.now() + graceMs;
    while (isAlive(pid) && Date.now() < deadline) await sleep(50);
  }
  return !isAlive(pid);
}

export function childPids(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    // No children, or pgrep is unavailable.
    return [];
  }
}

export function killRun(runId: string): number {
  const pids = pidsForRun(runId);
  for (const pid of pids) killTree(pid);
  return pids.length;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A pid may have been recycled since the row was written, so the recorded
 * command has to still match before anything is signalled.
 */
export function commandMatches(pid: number, recorded: string): boolean {
  try {
    const live = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
    return !!live && live.includes(recorded.split(' ')[0] ?? recorded);
  } catch {
    return false;
  }
}

export function spawnTracked(input: {
  runId: string;
  argv: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
}): ChildProcess {
  const [cmd, ...args] = input.argv;
  if (!cmd) throw new Error('spawnTracked: empty argv');
  const child = spawn(cmd, args, {
    cwd: input.cwd,
    env: spawnEnv(input.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  });
  register(input.runId, child, input.argv.join(' '));
  return child;
}

export function killAll(): void {
  for (const entry of [...registry.values()]) killTree(entry.pid, 'SIGKILL');
  registry.clear();
}
