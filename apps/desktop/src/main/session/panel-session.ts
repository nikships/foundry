/**
 * The live side of a one-shot panel: detection, setup-script generation, and
 * the readiness remediator.
 *
 * None of those is a run. There is no worktree to merge, no phase to fail, no
 * tracer row. What they need — and what a bare `await` does not give them — is
 * visible progress and a cancel button while the turn runs.
 *
 * A session is therefore a small owned object rather than a promise: the click
 * starts it, the renderer subscribes by id, and cancelling kills the child.
 * This module owns the parts that used to be copied three times: the entries
 * ring, status/detail/timestamps, cancel/abort, transcript fold, and snapshot
 * clone. Feature-specific ask-and-parse lives in the caller.
 *
 * Dependencies are in-process only (an injected `OneShotFactory`). No git, no
 * sqlite.
 */

import { randomBytes } from 'node:crypto';
import type { PanelEntry, PanelStateCore, ReasoningEffort } from '@shared/types.js';
import type { OneShotFactory, OneShotResult, OneShotSession } from '../pi/oneshot.js';
import { foldTranscript } from '../pi/transcript.js';
import type { OutputFormat, TransportEvent } from '../pi/transport.js';

/** A long turn must not grow without bound; the tail is what the panel shows. */
export const PANEL_MAX_ENTRIES = 300;

export function shortId(bytes = 6): string {
  return randomBytes(bytes).toString('hex');
}

export interface PanelSessionHooks<TState extends PanelStateCore> {
  onChange: (state: TState) => void;
  now?: () => number;
  /**
   * Feature-specific clone. Entries are cloned by the session after this
   * returns, so the hook can skip them.
   */
  clone: (state: TState) => TState;
  isTerminal: (state: TState) => boolean;
  applyCancel: (state: TState) => void;
  applyFail: (state: TState, message: string) => void;
}

export interface AskTurn {
  oneShot: OneShotFactory;
  cwd: string;
  access: 'read' | 'write';
  model: string;
  reasoningEffort: ReasoningEffort;
  prompt: string;
  /** Standing rules, installed as the system prompt. */
  systemPrompt?: string;
  /** Optional schema-bound `submit_result` answer channel. */
  outputFormat?: OutputFormat;
  textCap?: number;
}

export class PanelSession<TState extends PanelStateCore> {
  private oneshot: OneShotSession | null = null;
  private _cancelled = false;

  constructor(
    readonly state: TState,
    private readonly hooks: PanelSessionHooks<TState>,
  ) {}

  get cancelled(): boolean {
    return this._cancelled;
  }

  now(): number {
    return (this.hooks.now ?? Date.now)();
  }

  snapshot(): TState {
    // Cloned: the renderer receives this through structured clone and must
    // never share an array this session is still mutating.
    const cloned = this.hooks.clone(this.state);
    cloned.entries = this.state.entries.map((entry) => ({ ...entry }));
    return cloned;
  }

  emit(): void {
    this.hooks.onChange(this.snapshot());
  }

  push(entry: Omit<PanelEntry, 'id' | 'at'>): PanelEntry {
    const full: PanelEntry = { ...entry, id: shortId(), at: this.now() };
    this.state.entries.push(full);
    if (this.state.entries.length > PANEL_MAX_ENTRIES) this.state.entries.shift();
    this.emit();
    return full;
  }

  last(): PanelEntry | null {
    return this.state.entries[this.state.entries.length - 1] ?? null;
  }

  /** Folds the session's events into transcript lines. */
  absorb(textCap?: number): (event: TransportEvent) => void {
    return foldTranscript<PanelEntry>({
      push: (row) => this.push(row),
      flush: () => this.emit(),
      last: () => this.last(),
      textCap,
    });
  }

  bind(session: OneShotSession): void {
    this.oneshot = session;
  }

  isTerminal(): boolean {
    return this.hooks.isTerminal(this.state);
  }

  /**
   * Marks the session cancelled without applying the cancel status. Skip and
   * retry need the flag so in-flight work stops, but they settle their own
   * phase.
   */
  noteCancelled(): void {
    this._cancelled = true;
    this.oneshot?.abort();
  }

  clearCancelled(): void {
    this._cancelled = false;
  }

  cancel(): void {
    if (this.hooks.isTerminal(this.state)) return;
    this._cancelled = true;
    this.oneshot?.abort();
    this.hooks.applyCancel(this.state);
    this.state.endedAt = this.now();
    this.push({ kind: 'note', text: 'Cancelled.' });
  }

  fail(message: string): void {
    if (this._cancelled) return;
    this.hooks.applyFail(this.state, message);
    this.push({ kind: 'error', text: message });
  }

  finish(): void {
    if (!this.state.endedAt) this.state.endedAt = this.now();
    this.emit();
  }

  /**
   * Opens a one-shot, binds it for cancel, and sends the prompt. Returns null
   * when the operator cancelled during the turn.
   */
  async ask(input: AskTurn): Promise<OneShotResult | null> {
    const session = input.oneShot({
      cwd: input.cwd,
      access: input.access,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      onEvent: this.absorb(input.textCap),
      onWarning: (warning) => {
        // A model substitution reports itself here; surfacing it is the
        // difference between "nothing found" and "that model is blocked".
        this.push({ kind: 'note', text: warning.slice(0, 500) });
      },
      ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
      ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    });
    this.bind(session);
    const turn = await session.send(input.prompt);
    if (this._cancelled) return null;
    return turn;
  }
}
