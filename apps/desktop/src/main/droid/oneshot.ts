/**
 * Fallback harness: `droid exec -o json --session-id {id}` per turn.
 *
 * Wired from the start because the RPC surface is the lowest-level and most
 * evolving thing Foundry depends on. Loses mid-turn tool visibility (one
 * spanning event per turn) but keeps sessions, envelopes, gates, boundaries,
 * and cost — same adapter contract as RPC.
 */

import { spawn } from 'node:child_process';
import type { AutonomyLevel, ReasoningEffort } from '@shared/types.js';
import type { TokenUsage } from './protocol.js';
import type { TurnResult } from './client.js';

export interface OneShotOptions {
  droidPath: string;
  cwd: string;
  autonomy: AutonomyLevel;
  model: string;
  reasoningEffort: ReasoningEffort;
  restrictTools?: string[];
  disabledTools?: string[];
  onStderr?: (text: string) => void;
}

interface OneShotResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  duration_ms?: number;
  num_turns?: number;
  usage?: TokenUsage;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export class OneShotClient {
  private sessionId: string | null = null;
  private lastPid: number | undefined;

  constructor(private readonly opts: OneShotOptions) {}

  get id(): string | null {
    return this.sessionId;
  }

  get pid(): number | undefined {
    return this.lastPid;
  }

  get alive(): boolean {
    return true;
  }

  adopt(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  async send(text: string, timeoutMs: number): Promise<TurnResult> {
    let { stdout, stderr, code, timedOut } = await this.exec(this.argsFor(text, true), timeoutMs);

    // Organization-forbidden models must not cost the turn: retry on droid's
    // default and report the substitution rather than failing the phase.
    if (code !== 0 && /blocked by organization policy|not allowed/i.test(stderr)) {
      this.opts.onStderr?.(
        `${this.opts.model} was refused by policy; this turn runs on droid's default model`,
      );
      ({ stdout, stderr, code, timedOut } = await this.exec(this.argsFor(text, false), timeoutMs));
    }

    if (stderr.trim()) this.opts.onStderr?.(stderr);
    if (timedOut) throw new Error(`one-shot turn timed out after ${timeoutMs}ms`);

    const parsed = this.parseResult(stdout);
    if (parsed?.session_id) this.sessionId = parsed.session_id;
    if (!parsed) {
      if (code !== 0) {
        throw new Error(
          `droid exec exited ${code}: ${stderr.slice(-1500) || stdout.slice(-1500)}`,
        );
      }
      return { text: stdout.trim(), usage: null, reason: 'completed', interrupted: false };
    }
    return {
      text: (parsed.result ?? '').trim(),
      usage: parsed.usage ?? null,
      reason: parsed.is_error ? 'error' : (parsed.subtype ?? 'completed'),
      interrupted: false,
    };
  }

  private argsFor(text: string, withModel: boolean): string[] {
    const args = [
      'exec',
      '--output-format',
      'json',
      '--cwd',
      this.opts.cwd,
      '--auto',
      this.opts.autonomy,
    ];
    if (withModel && this.opts.model && this.opts.model !== 'inherit') {
      args.push('-m', this.opts.model);
      if (this.opts.reasoningEffort !== 'off') args.push('-r', this.opts.reasoningEffort);
    }
    if (this.opts.restrictTools?.length) {
      args.push('--restrict-tools', this.opts.restrictTools.join(','));
    }
    if (this.opts.disabledTools?.length) {
      args.push('--disabled-tools', this.opts.disabledTools.join(','));
    }
    if (this.sessionId) args.push('--session-id', this.sessionId);
    args.push(text);
    return args;
  }

  private parseResult(stdout: string): OneShotResult | null {
    const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
    for (const line of lines.reverse()) {
      try {
        const parsed = JSON.parse(line) as OneShotResult;
        if (parsed.type === 'result' || parsed.result !== undefined) return parsed;
      } catch {
        // try previous JSON line
      }
    }
    return null;
  }

  private exec(args: string[], timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.droidPath, args, {
        cwd: this.opts.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.lastPid = child.pid;
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString();
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString();
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, code, timedOut });
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: `${stderr}${e.message}`, code: null, timedOut });
      });
    });
  }

  async close(): Promise<void> {
    // Each turn is its own process; nothing to keep alive.
  }

  kill(): void {
    if (!this.lastPid) return;
    try {
      process.kill(this.lastPid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
