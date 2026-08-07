/**
 * The one-shot harness: one child process per turn, session carried across them
 * by the vendor's own session id.
 *
 * Wired from the start because the RPC surface is the lowest-level and most
 * evolving thing Foundry depends on. Loses mid-turn tool visibility (one
 * spanning event per turn) but keeps sessions, envelopes, gates, boundaries,
 * and cost, which is the same adapter contract as RPC.
 *
 * Since multi-CLI support this is also the **only** path for every vendor but
 * droid: the argv and the parse both come from `cli/`, so this file owns process
 * mechanics (spawn, timeout, kill, stderr) and knows nothing about any CLI's
 * flags. A vendor is added without touching it.
 */

import { spawn } from 'node:child_process';
import type { AutonomyLevel, ReasoningEffort } from '@shared/types.js';
import { adapterFor, type CliAdapter, type CliVendor } from '../cli/index.js';
import type { TokenUsage } from './protocol.js';
import type { TurnResult } from './client.js';

export interface OneShotOptions {
  /** Which CLI this session drives. */
  vendor: CliVendor;
  /** Path to that CLI's binary. */
  cliPath: string;
  cwd: string;
  autonomy: AutonomyLevel;
  model: string;
  reasoningEffort: ReasoningEffort;
  restrictTools?: string[];
  disabledTools?: string[];
  /** Operator-supplied flags for this vendor, appended to every turn. */
  extraArgs?: string[];
  onStderr?: (text: string) => void;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/** Whether a failure is a model the operator's plan or org will not run. */
const POLICY_REFUSAL = /blocked by organization policy|not allowed|model_not_found|unknown model/i;

export class OneShotClient {
  private sessionId: string | null = null;
  private lastPid: number | undefined;
  private readonly adapter: CliAdapter;

  constructor(private readonly opts: OneShotOptions) {
    this.adapter = adapterFor(opts.vendor);
  }

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

  /**
   * `onStreamLine` receives each complete stdout line that parses as JSON, as
   * it arrives rather than at exit. Only wired when the vendor's adapter has a
   * stream normaliser; what the listener does with a line is its own business.
   */
  async send(
    text: string,
    timeoutMs: number,
    onStreamLine?: (line: unknown) => void,
  ): Promise<TurnResult> {
    let { stdout, stderr, code, timedOut } = await this.exec(
      this.argsFor(text, true),
      timeoutMs,
      onStreamLine,
    );

    // A model the org forbids must not cost the turn: retry on the CLI's own
    // default and report the substitution rather than failing the phase.
    if (code !== 0 && POLICY_REFUSAL.test(stderr)) {
      this.opts.onStderr?.(
        `${this.opts.model} was refused; this turn runs on ${this.adapter.label}'s default model`,
      );
      ({ stdout, stderr, code, timedOut } = await this.exec(
        this.argsFor(text, false),
        timeoutMs,
        onStreamLine,
      ));
    }

    this.reportStderr(stderr);
    if (timedOut) throw new Error(`one-shot turn timed out after ${timeoutMs}ms`);

    const parsed = this.adapter.parse({ stdout, stderr, code });
    if (parsed?.sessionId) this.sessionId = parsed.sessionId;
    if (!parsed) {
      // Nothing parseable. A non-zero exit is the real error; a clean exit that
      // printed only prose is still an answer, so it is passed through.
      if (code !== 0) {
        throw new Error(
          `${this.adapter.binary} exited ${code}: ${stderr.slice(-1500) || stdout.slice(-1500)}`,
        );
      }
      return { text: stdout.trim(), usage: null, reason: 'completed', interrupted: false };
    }
    return {
      text: parsed.text,
      usage: parsed.usage as TokenUsage | null,
      reason: parsed.reason,
      interrupted: false,
    };
  }

  /**
   * Warnings a CLI prints on every successful run are dropped: a green phase
   * that files an error every time teaches the reader to skip the trace.
   */
  private reportStderr(stderr: string): void {
    const noisy = this.adapter.noisyStderr;
    const kept = noisy
      ? stderr
          .split('\n')
          .filter((line) => line.trim() && !noisy.test(line))
          .join('\n')
      : stderr;
    if (kept.trim()) this.opts.onStderr?.(kept);
  }

  private argsFor(text: string, withModel: boolean): string[] {
    return this.adapter.turn({
      prompt: text,
      cwd: this.opts.cwd,
      autonomy: this.opts.autonomy,
      // Dropping the model is how the policy retry asks for the CLI's default,
      // and `inherit` is already the value every adapter reads that way.
      model: withModel ? this.opts.model : 'inherit',
      reasoningEffort: withModel ? this.opts.reasoningEffort : 'off',
      sessionId: this.sessionId,
      restrictTools: this.opts.restrictTools,
      disabledTools: this.opts.disabledTools,
      extraArgs: this.opts.extraArgs,
    }).argv;
  }

  private exec(
    args: string[],
    timeoutMs: number,
    onStreamLine?: (line: unknown) => void,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.cliPath, args, {
        cwd: this.opts.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.lastPid = child.pid;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let lineBuffer = '';

      const dispatchLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        try {
          onStreamLine?.(JSON.parse(trimmed));
        } catch {
          // A partial or interleaved line is not fatal; parse() sees the whole
          // stdout at exit either way, so a missed line costs one live row.
        }
      };

      child.stdout?.on('data', (c: Buffer) => {
        const text = c.toString();
        stdout += text;
        if (!onStreamLine) return;
        lineBuffer += text;
        let idx: number;
        while ((idx = lineBuffer.indexOf('\n')) >= 0) {
          dispatchLine(lineBuffer.slice(0, idx));
          lineBuffer = lineBuffer.slice(idx + 1);
        }
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
        // A final line with no trailing newline still carries a JSON object.
        if (lineBuffer.trim()) dispatchLine(lineBuffer);
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
