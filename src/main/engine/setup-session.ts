/**
 * One-click "Generate with AI" for the worktree bootstrap script.
 *
 * Mirrors `detect-session.ts`: owns the agent turn, streams progress,
 * and commits to a status detail rather than leaving the click to hang.
 */

import { randomBytes } from 'node:crypto';
import type { AppSettings, TranscriptToolKind } from '@shared/types.js';
import type { OneShotFactory, OneShotSession } from '../pi/oneshot.js';
import { foldTranscript } from '../pi/transcript.js';
import { SETUP_PROMPT, parseSetupReply, sniffSetupScript } from './setup.js';

export interface SetupEntry {
  id: string;
  kind: 'text' | 'tool' | 'note' | 'error';
  text: string;
  toolKind?: TranscriptToolKind;
  done?: boolean;
  failed?: boolean;
  at: number;
}

export type SetupStatus = 'running' | 'done' | 'cancelled' | 'failed';

export interface SetupState {
  setupId: string;
  projectId: string;
  status: SetupStatus;
  /** The model that actually ran, not the one that was requested. */
  model: string;
  entries: SetupEntry[];
  script: string;
  rawReply: string;
  detail: string;
  startedAt: number;
  endedAt?: number;
}

const SETUP_TIMEOUT_MS = 300_000;
const MAX_ENTRIES = 300;

function shortId(): string {
  return randomBytes(6).toString('hex');
}

export interface SetupSessionDeps {
  projectId: string;
  projectPath: string;
  settings: AppSettings;
  model: string;
  /** How the turn is opened. Injected so a test drives one with no model. */
  oneShot: OneShotFactory;
  onChange: (state: SetupState) => void;
}

export class SetupSession {
  readonly setupId = `setup_${shortId()}`;
  private readonly state: SetupState;
  private session: OneShotSession | null = null;
  private cancelled = false;

  constructor(private readonly deps: SetupSessionDeps) {
    this.state = {
      setupId: this.setupId,
      projectId: deps.projectId,
      status: 'running',
      model: deps.model,
      entries: [],
      script: '',
      rawReply: '',
      detail: 'starting',
      startedAt: Date.now(),
    };
  }

  snapshot(): SetupState {
    return {
      ...this.state,
      entries: [...this.state.entries],
    };
  }

  private emit(): void {
    this.deps.onChange(this.snapshot());
  }

  private push(entry: Omit<SetupEntry, 'id' | 'at'>): SetupEntry {
    const full: SetupEntry = { ...entry, id: shortId(), at: Date.now() };
    this.state.entries.push(full);
    if (this.state.entries.length > MAX_ENTRIES) this.state.entries.shift();
    this.emit();
    return full;
  }

  cancel(): void {
    if (this.state.status === 'done' || this.state.status === 'failed') return;
    this.cancelled = true;
    this.session?.abort();
    this.state.status = 'cancelled';
    this.state.detail = 'cancelled';
    this.state.endedAt = Date.now();
    this.push({ kind: 'note', text: 'Cancelled.' });
  }

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
    if (!this.state.endedAt) this.state.endedAt = Date.now();
    this.emit();
  }

  private async ask(): Promise<void> {
    const { settings, model } = this.deps;

    const sniffed = await sniffSetupScript(this.deps.projectPath);
    if (sniffed.script) {
      this.push({
        kind: 'note',
        text: `Manifests suggest: ${sniffed.script.replace(/\n/g, ' && ')}`,
      });
    }

    this.push({
      kind: 'note',
      text: `Asking the agent${model === 'inherit' ? '' : ` (${model})`}…`,
    });

    // Reads the operator's own checkout to propose a script; it never runs one,
    // so the session is opened without a tool that could.
    this.session = this.deps.oneShot({
      cwd: this.deps.projectPath,
      access: 'read',
      model,
      reasoningEffort: model === 'inherit' ? 'off' : settings.defaultReasoningEffort,
      onEvent: (event) => this.absorb(event),
      onWarning: (warning) => this.push({ kind: 'note', text: warning.slice(0, 500) }),
    });

    const prompt = sniffed.script
      ? `${SETUP_PROMPT}\n\nManifests suggested this script; confirm, correct, or replace it:\n${sniffed.script}`
      : SETUP_PROMPT;

    const turn = await this.session.send(prompt, SETUP_TIMEOUT_MS);
    if (this.cancelled) return;

    const parsed = parseSetupReply(turn.text);
    this.state.rawReply = parsed.rawReply;

    if (parsed.parseError) {
      this.state.status = 'failed';
      this.state.detail = parsed.parseError;
      this.push({ kind: 'error', text: parsed.parseError });
      return;
    }

    this.state.script = parsed.script;
    this.state.status = 'done';
    this.state.detail = parsed.script
      ? 'ready — review before it runs on every new worktree'
      : 'no install step needed for this repo';
  }

  private readonly absorb = foldTranscript<SetupEntry>({
    push: (row) => this.push(row),
    flush: () => this.emit(),
    last: () => this.state.entries[this.state.entries.length - 1] ?? null,
  });
}
