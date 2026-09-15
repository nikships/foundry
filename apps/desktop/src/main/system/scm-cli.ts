/**
 * Shared exec helpers for forge CLIs (`gh` / `glab`). Both wrap an operator
 * binary via execFile (full stdout, not runCommand's 4000-char tail) so JSON
 * payloads parse whole.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnEnv } from './env.js';

const exec = promisify(execFile);

export interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface RunCliOptions {
  timeoutMs?: number;
  envExtras?: Record<string, string>;
}

export async function runCli(
  bin: string,
  cwd: string,
  args: string[],
  opts: RunCliOptions = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await exec(bin, args, {
      cwd,
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: spawnEnv({ NO_COLOR: '1', ...(opts.envExtras ?? {}) }),
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

/** CLIs pad stderr; the first non-blank line is the reason. */
export function firstLine(result: CliResult): string {
  return (
    (result.stderr || result.stdout)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  );
}

export function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Created resources print their URL as the last https line on stdout. */
export function createdUrl(stdout: string): string | undefined {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('https://'))
    .pop();
}

export function numberFromUrl(url: string | undefined, pattern: RegExp): number | undefined {
  const parsed = Number(url && pattern.exec(url)?.[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}
