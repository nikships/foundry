/**
 * Code phases: a known command is a subprocess, never an agent. The captured
 * record is deliberately raw — every runner formats failures differently and a
 * generic parser would be confidently wrong — but the tail rides along so a
 * failure can travel back to an agent that cannot open a log file.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { CommandResult } from '@shared/types.js';
import { register, unregister, killTree } from '../system/procs.js';

const TAIL_CHARS = 4000;

export interface RunCommandInput {
  argv: string[];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  name?: string;
  /** Registers the child so a run-level kill can reach it. */
  runId?: string;
  onPid?: (pid: number, command: string) => void;
}

function failedResult(
  name: string,
  command: string,
  started: number,
  outputTail: string,
): CommandResult {
  return {
    name,
    command,
    exitCode: null,
    passed: false,
    durationMs: Date.now() - started,
    outputTail,
    timedOut: false,
  };
}

export async function runCommand(input: RunCommandInput): Promise<CommandResult> {
  const [cmd, ...args] = input.argv;
  const command = input.argv.join(' ');
  const name = input.name ?? cmd ?? 'command';
  const started = Date.now();

  if (!cmd) {
    return {
      name,
      command,
      exitCode: null,
      passed: false,
      durationMs: 0,
      outputTail: 'no command given',
      timedOut: false,
    };
  }

  return await new Promise<CommandResult>((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolvePromise(
        failedResult(name, command, started, `could not spawn: ${(e as Error).message}`),
      );
      return;
    }

    if (input.runId && child.pid) register(input.runId, child, command);
    if (child.pid) input.onPid?.(child.pid, command);

    let output = '';
    const append = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > TAIL_CHARS * 4) output = output.slice(-TAIL_CHARS * 2);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    let timedOut = false;
    const timer = input.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid, 'SIGKILL');
        }, input.timeoutMs)
      : null;

    const settle = (exitCode: number | null, errText?: string): void => {
      if (timer) clearTimeout(timer);
      unregister(child.pid);
      const tail = (errText ? `${errText}\n${output}` : output).slice(-TAIL_CHARS);
      resolvePromise({
        name,
        command,
        exitCode,
        passed: exitCode === 0 && !timedOut,
        durationMs: Date.now() - started,
        outputTail: timedOut ? `${tail}\n[timed out after ${input.timeoutMs}ms]` : tail,
        timedOut,
      });
    };

    child.on('error', (e) => settle(null, e.message));
    child.on('close', (code) => settle(code));
  });
}

export const BUILTIN_ARGV: Record<string, (args: { message?: string }) => string[]> = {
  git_commit: ({ message }) => ['git', 'commit', '-m', message?.trim() || 'foundry: run changes'],
  git_status: () => ['git', 'status', '--porcelain'],
  noop: () => ['true'],
};
