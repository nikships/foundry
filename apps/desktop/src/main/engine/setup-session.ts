/**
 * One-click "Generate with AI" for the worktree bootstrap script.
 *
 * Mirrors `detect-session.ts`: owns the agent turn, streams progress,
 * and commits to a status detail rather than leaving the click to hang.
 */

import { randomBytes } from 'node:crypto';
import type { AppSettings, CliVendor } from '@shared/types.js';
import { adapterFor } from '../cli/index.js';
import { OneShotClient } from '../droid/oneshot.js';
import { labelToolCall, toolKind, type ToolKind } from '../droid/events.js';
import type { DroidNotification, ToolUse } from '../droid/protocol.js';
import {
  SETUP_PROMPT,
  SETUP_TOOLS,
  parseSetupReply,
  sniffSetupScript,
} from './setup.js';

export interface SetupEntry {
  id: string;
  kind: 'text' | 'tool' | 'note' | 'error';
  text: string;
  toolKind?: ToolKind;
  done?: boolean;
  failed?: boolean;
  at: number;
}

export type SetupStatus = 'running' | 'done' | 'cancelled' | 'failed';

export interface SetupState {
  setupId: string;
  projectId: string;
  status: SetupStatus;
  cli: CliVendor;
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
  vendor: CliVendor;
  model: string;
  onChange: (state: SetupState) => void;
}

export class SetupSession {
  readonly setupId = `setup_${shortId()}`;
  private readonly state: SetupState;
  private client: OneShotClient | null = null;
  private cancelled = false;
  private readonly openTools = new Map<string, SetupEntry>();

  constructor(private readonly deps: SetupSessionDeps) {
    this.state = {
      setupId: this.setupId,
      projectId: deps.projectId,
      status: 'running',
      cli: deps.vendor,
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
    this.client?.kill();
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
    const { settings, vendor, model } = this.deps;
    const adapter = adapterFor(vendor);
    const cli = settings.clis[vendor];

    const sniffed = await sniffSetupScript(this.deps.projectPath);
    if (sniffed.script) {
      this.push({
        kind: 'note',
        text: `Manifests suggest: ${sniffed.script.replace(/\n/g, ' && ')}`,
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
      restrictTools: SETUP_TOOLS,
      model,
      reasoningEffort: model === 'inherit' ? 'off' : settings.defaultReasoningEffort,
      onStderr: (text) => {
        const trimmed = text.trim();
        if (trimmed) this.push({ kind: 'note', text: trimmed.slice(0, 500) });
      },
    });

    const prompt = sniffed.script
      ? `${SETUP_PROMPT}\n\nManifests suggested this script; confirm, correct, or replace it:\n${sniffed.script}`
      : SETUP_PROMPT;

    const turn = await this.client.send(
      prompt,
      SETUP_TIMEOUT_MS,
      normalise ? (line) => this.absorb(normalise(line)) : undefined,
    );
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

  private absorb(notifications: DroidNotification[]): void {
    for (const n of notifications) {
      switch (n.type) {
        case 'assistant_text_delta': {
          const delta = (n as { textDelta?: string }).textDelta ?? '';
          if (!delta.trim()) break;
          const last = this.state.entries[this.state.entries.length - 1];
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
}
