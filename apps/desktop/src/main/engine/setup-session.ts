/**
 * One-click "Generate with AI" for the worktree bootstrap script.
 *
 * A thin ask-and-parse strategy on PanelSession: owns the prompt, the sniff,
 * and the parse. Progress, cancel, and the transcript live in the shared
 * session.
 */

import type { AppSettings } from '@shared/types.js';
import type { SetupState } from '@shared/ipc-contract.js';
import { modelLabel } from '@shared/model-label.js';
import type { OneShotFactory } from '../pi/oneshot.js';
import {
  PanelSession,
  createPanelRegistry,
  shortId,
  type PanelRegistry,
} from '../session/index.js';
import { SETUP_PROMPT, parseSetupReply, sniffSetupScript } from './setup.js';

export type { SetupState };

export interface SetupSessionDeps {
  projectId: string;
  projectPath: string;
  settings: AppSettings;
  model: string;
  /** How the turn is opened. Injected so a test drives one with no model. */
  oneShot: OneShotFactory;
  onChange: (state: SetupState) => void;
}

export type SetupStart = Omit<SetupSessionDeps, 'onChange' | 'oneShot'>;

export class SetupSession {
  readonly setupId = `setup_${shortId()}`;
  private readonly panel: PanelSession<SetupState>;

  constructor(private readonly deps: SetupSessionDeps) {
    this.panel = new PanelSession<SetupState>(
      {
        setupId: this.setupId,
        projectId: deps.projectId,
        status: 'running',
        model: deps.model,
        entries: [],
        script: '',
        rawReply: '',
        detail: 'starting',
        startedAt: Date.now(),
      },
      {
        onChange: deps.onChange,
        clone: (state) => ({ ...state }),
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

  snapshot(): SetupState {
    return this.panel.snapshot();
  }

  cancel(): void {
    this.panel.cancel();
  }

  async run(): Promise<void> {
    try {
      await this.ask();
    } catch (e) {
      this.panel.fail((e as Error).message);
    }
    this.panel.finish();
  }

  private async ask(): Promise<void> {
    const { settings, model } = this.deps;

    const sniffed = await sniffSetupScript(this.deps.projectPath);
    if (sniffed.script) {
      this.panel.push({
        kind: 'note',
        text: `Manifests suggest: ${sniffed.script.replace(/\n/g, ' && ')}`,
      });
    }

    this.panel.push({
      kind: 'note',
      text: `Asking the agent${model === 'inherit' ? '' : ` (${modelLabel(model)})`}…`,
    });

    // Reads the operator's own checkout to propose a script; it never runs one,
    // so the session is opened without a tool that could.
    const prompt = sniffed.script
      ? `Manifests suggested this script; confirm, correct, or replace it:\n${sniffed.script}`
      : 'Propose the worktree bootstrap script for this repository.';

    const turn = await this.panel.ask({
      oneShot: this.deps.oneShot,
      cwd: this.deps.projectPath,
      access: 'read',
      model,
      reasoningEffort: settings.helperReasoningEffort,
      systemPrompt: SETUP_PROMPT,
      prompt,
    });
    if (!turn) return;

    const parsed = parseSetupReply(turn.text);
    const state = this.panel.state;
    state.rawReply = parsed.rawReply;

    if (parsed.parseError) {
      this.panel.fail(parsed.parseError);
      return;
    }

    state.script = parsed.script;
    state.status = 'done';
    state.detail = parsed.script
      ? 'ready — review before it runs on every new worktree'
      : 'no install step needed for this repo';
  }
}

export function createSetups(
  oneShot: OneShotFactory,
  onProgress: (state: SetupState) => void,
): PanelRegistry<SetupStart, SetupState> {
  return createPanelRegistry({
    create: (deps, onChange) => new SetupSession({ ...deps, oneShot, onChange }),
    idOf: (session) => session.setupId,
    snapshot: (session) => session.snapshot(),
    isLive: (state) => state.status === 'running',
    run: (session) => session.run(),
    onProgress,
  });
}
