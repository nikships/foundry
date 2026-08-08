/**
 * The live side of "Ask AI to find commands".
 *
 * Detection is not a run: it has no worktree, no pipeline, no phase and no
 * tracer, so it cannot borrow the executor's machinery. What it does need is
 * the thing a run has and a bare `await` does not — visible progress, a cancel
 * button, and a reason when nothing comes back.
 *
 * A session is therefore a small owned object rather than a promise: the click
 * starts it, the renderer subscribes to its progress by id, and cancelling
 * kills the child. An unawaited promise that rejects into a click handler is
 * exactly how this feature came to look like a button that does nothing.
 */

import { randomBytes } from 'node:crypto';
import type { AppSettings, CliVendor } from '@shared/types.js';
import { adapterFor } from '../cli/index.js';
import { OneShotClient } from '../droid/oneshot.js';
import { labelToolCall, toolKind, type ToolKind } from '../droid/events.js';
import type { DroidNotification, ToolUse } from '../droid/protocol.js';
import {
  DETECT_PROMPT,
  parseDetectReply,
  sniffCommands,
  type CommandCandidate,
  type RejectedCandidate,
} from './detect.js';
import { runCommand } from './commands.js';

/** One line in the live transcript the Project pane shows. */
export interface DetectionEntry {
  id: string;
  kind: 'text' | 'tool' | 'note' | 'error';
  text: string;
  /** Tool entries only: what kind of work it was, so the UI can icon it. */
  toolKind?: ToolKind;
  /** Tool entries only: set once the result arrives. */
  done?: boolean;
  failed?: boolean;
  at: number;
}

export type VerifyState = 'pending' | 'running' | 'pass' | 'fail';

/**
 * A proposal plus the evidence for it. Verification is streamed rather than
 * awaited as a batch, so a slow suite does not hide the commands already found.
 */
export interface DetectionProposal {
  name: string;
  argv: string[];
  source: string;
  verify: VerifyState;
  exitCode?: number | null;
  outputTail?: string;
  durationMs?: number;
  /** Set when the command could not be spawned at all, rather than failing. */
  notFound?: boolean;
}

export type DetectionStatus = 'running' | 'verifying' | 'done' | 'cancelled' | 'failed';

export interface DetectionState {
  detectionId: string;
  projectId: string;
  status: DetectionStatus;
  /** Which CLI and model actually ran, not which were requested. */
  cli: CliVendor;
  model: string;
  entries: DetectionEntry[];
  proposals: DetectionProposal[];
  rejected: RejectedCandidate[];
  rawReply: string;
  detail: string;
  startedAt: number;
  endedAt?: number;
}

const MAX_ENTRIES = 300;
const DETECT_TIMEOUT_MS = 300_000;
const VERIFY_TIMEOUT_MS = 300_000;

/** A spawn that failed because the binary is not on PATH, not because it ran. */
const NOT_FOUND = /ENOENT|could not spawn|No such file or directory|command not found/i;

function shortId(): string {
  return randomBytes(6).toString('hex');
}

export interface DetectSessionDeps {
  projectId: string;
  projectPath: string;
  existingCommands: string[];
  settings: AppSettings;
  /** Which CLI to drive, already resolved from the project's preference. */
  vendor: CliVendor;
  /** Model id, or `inherit` to let the CLI choose. */
  model: string;
  onChange: (state: DetectionState) => void;
}

export class DetectSession {
  readonly detectionId = `det_${shortId()}`;
  private readonly state: DetectionState;
  private client: OneShotClient | null = null;
  private cancelled = false;
  /** toolUseId → transcript entry, so a result closes the line it opened. */
  private readonly openTools = new Map<string, DetectionEntry>();

  constructor(private readonly deps: DetectSessionDeps) {
    this.state = {
      detectionId: this.detectionId,
      projectId: deps.projectId,
      status: 'running',
      cli: deps.vendor,
      model: deps.model,
      entries: [],
      proposals: [],
      rejected: [],
      rawReply: '',
      detail: 'starting',
      startedAt: Date.now(),
    };
  }

  snapshot(): DetectionState {
    // Cloned: the renderer receives this through structured clone and must
    // never share an array this session is still mutating.
    return {
      ...this.state,
      entries: [...this.state.entries],
      proposals: this.state.proposals.map((p) => ({ ...p })),
      rejected: [...this.state.rejected],
    };
  }

  private emit(): void {
    this.deps.onChange(this.snapshot());
  }

  private push(entry: Omit<DetectionEntry, 'id' | 'at'>): DetectionEntry {
    const full: DetectionEntry = { ...entry, id: shortId(), at: Date.now() };
    this.state.entries.push(full);
    // A long detection must not grow without bound; the tail is what matters.
    if (this.state.entries.length > MAX_ENTRIES) this.state.entries.shift();
    this.emit();
    return full;
  }

  cancel(): void {
    if (this.state.status === 'done' || this.state.status === 'failed') return;
    this.cancelled = true;
    this.client?.kill();
    this.state.status = 'cancelled';
    this.state.detail = 'cancelled';
    this.state.endedAt = Date.now();
    this.push({ kind: 'note', text: 'Cancelled.' });
  }

  /**
   * Runs the agent, then verifies what it proposed. Never rejects: a failure
   * becomes a `failed` state with a reason, because the caller is a click.
   */
  async run(): Promise<void> {
    try {
      await this.ask();
    } catch (e) {
      if (!this.cancelled) {
        this.state.status = 'failed';
        this.state.detail = (e as Error).message;
        this.push({ kind: 'error', text: (e as Error).message });
      }
    }
    if (this.cancelled) {
      this.emit();
      return;
    }
    if (this.state.status !== 'failed') await this.verify();
    if (!this.state.endedAt) this.state.endedAt = Date.now();
    this.emit();
  }

  private async ask(): Promise<void> {
    const { settings, vendor, model } = this.deps;
    const adapter = adapterFor(vendor);
    const cli = settings.clis[vendor];

    // Manifests are free and usually right, so they are given to the agent as
    // context to confirm or correct. They are never a reason to skip the agent:
    // "Ask AI" that quietly returned a manifest guess is the bug this replaces.
    const sniffed = await sniffCommands(this.deps.projectPath);
    if (sniffed.length) {
      this.push({
        kind: 'note',
        text: `Manifests suggest: ${sniffed.map((c) => `${c.name} = ${c.argv.join(' ')}`).join(', ')}`,
      });
    }

    this.push({
      kind: 'note',
      text: `Asking ${adapter.label}${model === 'inherit' ? '' : ` (${model})`}…`,
    });

    const normalise = adapter.stream?.();
    this.client = new OneShotClient({
      vendor,
      cliPath: cli.path,
      extraArgs: cli.extraArgs,
      cwd: this.deps.projectPath,
      // Discovery reads the repo and must never be able to change it. This runs
      // against the base checkout, not a worktree, because no run owns it.
      autonomy: 'low',
      model,
      reasoningEffort: model === 'inherit' ? 'off' : settings.defaultReasoningEffort,
      onStderr: (text) => {
        const trimmed = text.trim();
        // The policy-refusal retry reports itself here; surfacing it is the
        // difference between "no commands found" and "that model is blocked".
        if (trimmed) this.push({ kind: 'note', text: trimmed.slice(0, 500) });
      },
    });

    const turn = await this.client.send(
      this.prompt(sniffed),
      DETECT_TIMEOUT_MS,
      normalise ? (line) => this.absorb(normalise(line)) : undefined,
    );
    if (this.cancelled) return;

    const reply = parseDetectReply(turn.text);
    this.state.rawReply = reply.rawReply;
    this.state.rejected = reply.rejected;

    if (reply.parseError) {
      this.state.status = 'failed';
      this.state.detail = reply.parseError;
      this.push({ kind: 'error', text: reply.parseError });
      return;
    }

    this.state.proposals = reply.commands.map((c) => ({
      name: c.name,
      argv: c.argv,
      source: c.source,
      verify: 'pending' as const,
    }));

    for (const r of reply.rejected) {
      this.push({ kind: 'note', text: `Ignored a proposal: ${r.reason}` });
    }

    if (!reply.commands.length) {
      this.state.status = 'done';
      this.state.detail = reply.rejected.length
        ? `the agent answered, but none of its ${reply.rejected.length} proposal(s) were usable`
        : 'the agent found no verifiable command in this repo';
      return;
    }
    this.state.detail = `${reply.commands.length} proposed; verifying`;
  }

  /** Manifest findings ride along so the agent confirms rather than guesses. */
  private prompt(sniffed: CommandCandidate[]): string {
    const parts = [DETECT_PROMPT];
    if (sniffed.length) {
      parts.push(
        '',
        'Reading this repository’s manifests suggested the commands below. Confirm, correct, or replace them, and add any the manifests missed:',
        sniffed.map((c) => `- ${c.name}: ${c.argv.join(' ')} (from ${c.source})`).join('\n'),
      );
    }
    if (this.deps.existingCommands.length) {
      parts.push(
        '',
        `This project already has these command names configured: ${this.deps.existingCommands.join(', ')}. Proposing a better argv for one of them is useful; the human chooses whether to replace it.`,
      );
    }
    return parts.join('\n');
  }

  /** Folds the vendor's normalised notifications into transcript lines. */
  private absorb(notifications: DroidNotification[]): void {
    for (const n of notifications) {
      switch (n.type) {
        case 'assistant_text_delta': {
          const delta = (n as { textDelta?: string }).textDelta ?? '';
          if (!delta.trim()) break;
          const last = this.state.entries[this.state.entries.length - 1];
          // Vendors that emit per-token deltas would otherwise produce one
          // transcript line per token.
          if (last?.kind === 'text') {
            last.text += delta;
            this.emit();
          } else {
            this.push({ kind: 'text', text: delta });
          }
          break;
        }
        case 'tool_call': {
          const tool = (n as { toolUse?: ToolUse }).toolUse;
          if (!tool?.id || this.openTools.has(tool.id)) break;
          const entry = this.push({
            kind: 'tool',
            text: labelToolCall(tool),
            toolKind: toolKind(tool.name),
          });
          this.openTools.set(tool.id, entry);
          break;
        }
        case 'tool_result': {
          const r = n as { toolUseId?: string; isError?: boolean };
          const open = r.toolUseId ? this.openTools.get(r.toolUseId) : undefined;
          if (!open || !r.toolUseId) break;
          open.done = true;
          open.failed = !!r.isError;
          this.openTools.delete(r.toolUseId);
          this.emit();
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Running a proposal is the point: a command that passes here is evidence,
   * while a command merely typed into a field is a hope. Streamed one at a
   * time so the panel fills in rather than waiting on the slowest suite.
   */
  private async verify(): Promise<void> {
    if (!this.state.proposals.length) {
      if (this.state.status === 'running') this.state.status = 'done';
      return;
    }
    this.state.status = 'verifying';
    this.emit();

    for (const proposal of this.state.proposals) {
      if (this.cancelled) return;
      proposal.verify = 'running';
      this.emit();

      const result = await runCommand({
        argv: proposal.argv,
        cwd: this.deps.projectPath,
        timeoutMs: VERIFY_TIMEOUT_MS,
      });

      proposal.verify = result.passed ? 'pass' : 'fail';
      proposal.exitCode = result.exitCode;
      proposal.outputTail = result.outputTail;
      proposal.durationMs = result.durationMs;
      // A missing binary is not a failing command, and conflating the two is
      // what made every proposal look wrong under the GUI's stunted PATH.
      proposal.notFound = result.exitCode === null && NOT_FOUND.test(result.outputTail);
      this.emit();
    }

    if (this.cancelled) return;
    const passed = this.state.proposals.filter((p) => p.verify === 'pass').length;
    const missing = this.state.proposals.filter((p) => p.notFound).length;
    this.state.status = 'done';
    this.state.detail = missing
      ? `${this.state.proposals.length} proposed, ${passed} verified, ${missing} could not be run (binary not found on PATH)`
      : `${this.state.proposals.length} proposed, ${passed} verified by running`;
  }
}
