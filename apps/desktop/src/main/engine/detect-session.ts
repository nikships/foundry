/**
 * "Ask AI to find commands" as a thin ask-and-parse strategy on PanelSession.
 *
 * Detection is not a run: it has no worktree, no pipeline, no phase and no
 * tracer. The shared session owns progress, cancel, and the transcript; this
 * file only sniffs manifests, asks, parses, and verifies each proposal by
 * running it.
 */

import type { AppSettings } from '@shared/types.js';
import type { DetectionProposal, DetectionState } from '@shared/ipc-contract.js';
import { modelLabel } from '@shared/model-label.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import {
  PanelSession,
  createPanelRegistry,
  shortId,
  PANEL_TIMEOUT_MS,
  type PanelRegistry,
} from '../session/index.js';
import { DETECT_PROMPT, parseDetectReply, sniffCommands, type CommandCandidate } from './detect.js';
import { runCommand } from './commands.js';

export type { DetectionProposal, DetectionState };
export type DetectionStatus = DetectionState['status'];
export type VerifyState = DetectionProposal['verify'];

const VERIFY_TIMEOUT_MS = 300_000;

/** A spawn that failed because the binary is not on PATH, not because it ran. */
const NOT_FOUND = /ENOENT|could not spawn|No such file or directory|command not found/i;

export interface DetectSessionDeps {
  projectId: string;
  projectPath: string;
  existingCommands: string[];
  settings: AppSettings;
  /** Model id, or `inherit` to let this install choose. */
  model: string;
  /** How the turn is opened. Injected so a test drives one with no model. */
  oneShot: OneShotFactory;
  onChange: (state: DetectionState) => void;
}

export type DetectStart = Omit<DetectSessionDeps, 'onChange' | 'oneShot'>;

export class DetectSession {
  readonly detectionId = `det_${shortId()}`;
  private readonly panel: PanelSession<DetectionState>;

  constructor(private readonly deps: DetectSessionDeps) {
    this.panel = new PanelSession<DetectionState>(
      {
        detectionId: this.detectionId,
        projectId: deps.projectId,
        status: 'running',
        model: deps.model,
        entries: [],
        proposals: [],
        rejected: [],
        rawReply: '',
        detail: 'starting',
        startedAt: Date.now(),
      },
      {
        onChange: deps.onChange,
        clone: (state) => ({
          ...state,
          proposals: state.proposals.map((proposal) => ({ ...proposal })),
          rejected: [...state.rejected],
        }),
        isTerminal: (state) => state.status === 'done' || state.status === 'failed',
        applyCancel: (state) => {
          state.status = 'cancelled';
          state.detail = 'cancelled';
        },
        applyFail: (state, message) => {
          state.status = 'failed';
          state.detail = message;
        },
      },
    );
  }

  snapshot(): DetectionState {
    return this.panel.snapshot();
  }

  cancel(): void {
    this.panel.cancel();
  }

  /**
   * Runs the agent, then verifies what it proposed. Never rejects: a failure
   * becomes a `failed` state with a reason, because the caller is a click.
   */
  async run(): Promise<void> {
    try {
      await this.ask();
    } catch (e) {
      this.panel.fail((e as Error).message);
    }
    if (this.panel.cancelled) {
      this.panel.emit();
      return;
    }
    if (this.panel.state.status !== 'failed') await this.verify();
    this.panel.finish();
  }

  private async ask(): Promise<void> {
    const { settings, model } = this.deps;

    // Manifests are free and usually right, so they are given to the agent as
    // context to confirm or correct. They are never a reason to skip the agent:
    // "Ask AI" that quietly returned a manifest guess is the bug this replaces.
    const sniffed = await sniffCommands(this.deps.projectPath);
    if (sniffed.length) {
      this.panel.push({
        kind: 'note',
        text: `Manifests suggest: ${sniffed.map((c) => `${c.name} = ${c.argv.join(' ')}`).join(', ')}`,
      });
    }

    this.panel.push({
      kind: 'note',
      text: `Asking the agent${model === 'inherit' ? '' : ` (${modelLabel(model)})`}…`,
    });

    // Detection runs against the operator's own checkout, where nothing would
    // revert a write, so the session is opened with no tool that could make one.
    const turn = await this.panel.ask({
      oneShot: this.deps.oneShot,
      cwd: this.deps.projectPath,
      access: 'read',
      model,
      reasoningEffort: model === 'inherit' ? 'off' : settings.defaultReasoningEffort,
      systemPrompt: DETECT_PROMPT,
      prompt: this.prompt(sniffed),
      timeoutMs: PANEL_TIMEOUT_MS,
    });
    if (!turn) return;

    const reply = parseDetectReply(turn.text);
    const state = this.panel.state;
    state.rawReply = reply.rawReply;
    state.rejected = reply.rejected;

    if (reply.parseError) {
      this.panel.fail(reply.parseError);
      return;
    }

    state.proposals = reply.commands.map((c) => ({
      name: c.name,
      argv: c.argv,
      source: c.source,
      verify: 'pending' as const,
    }));

    for (const rejected of reply.rejected) {
      this.panel.push({ kind: 'note', text: `Ignored a proposal: ${rejected.reason}` });
    }

    if (!reply.commands.length) {
      state.status = 'done';
      state.detail = reply.rejected.length
        ? `the agent answered, but none of its ${reply.rejected.length} proposal(s) were usable`
        : 'the agent found no verifiable command in this repo';
      return;
    }
    state.detail = `${reply.commands.length} proposed; verifying`;
  }

  /** Manifest findings ride along so the agent confirms rather than guesses. */
  private prompt(sniffed: CommandCandidate[]): string {
    const parts = ['Inspect this repository and report the verification commands.'];
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

  /**
   * Running a proposal is the point: a command that passes here is evidence,
   * while a command merely typed into a field is a hope. Streamed one at a
   * time so the panel fills in rather than waiting on the slowest suite.
   */
  private async verify(): Promise<void> {
    const state = this.panel.state;
    if (!state.proposals.length) {
      if (state.status === 'running') state.status = 'done';
      return;
    }
    state.status = 'verifying';
    this.panel.emit();

    for (const proposal of state.proposals) {
      if (this.panel.cancelled) return;
      proposal.verify = 'running';
      this.panel.emit();

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
      this.panel.emit();
    }

    if (this.panel.cancelled) return;
    const passed = state.proposals.filter((p) => p.verify === 'pass').length;
    const missing = state.proposals.filter((p) => p.notFound).length;
    state.status = 'done';
    state.detail = missing
      ? `${state.proposals.length} proposed, ${passed} verified, ${missing} could not be run (binary not found on PATH)`
      : `${state.proposals.length} proposed, ${passed} verified by running`;
  }
}

export function createDetections(
  oneShot: OneShotFactory,
  onProgress: (state: DetectionState) => void,
): PanelRegistry<DetectStart, DetectionState> {
  return createPanelRegistry({
    create: (deps, onChange) => new DetectSession({ ...deps, oneShot, onChange }),
    idOf: (session) => session.detectionId,
    snapshot: (session) => session.snapshot(),
    isLive: (state) => state.status === 'running' || state.status === 'verifying',
    run: (session) => session.run(),
    onProgress,
  });
}
