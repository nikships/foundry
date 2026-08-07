/**
 * Folds droid's notification stream into trace rows.
 *
 * Droid re-emits `tool_call` for the same toolUseId as arguments stream in, so
 * a naive mapping writes several rows for one call. Folding keeps one spanning
 * row per real call, named readably ("bash: bun test"), closed on the result.
 *
 * Text gets the same treatment: one row per thinking or assistant block,
 * patched in place as deltas arrive (throttled, because a delta per token
 * would bury the db), so the Inspector shows a growing paragraph instead of
 * confetti. Every notification also lands in the agent's stream.jsonl, the
 * full-fidelity raw record; the db row is the display-ready mirror and says so
 * when it truncated.
 *
 * One folder serves every transport: the one-shot adapters normalise their
 * vendor's stream into this same notification shape, so there is exactly one
 * place that knows what a trace row looks like.
 */

import type { UsageBreakdown } from '@shared/types.js';
import type { DroidNotification, TokenUsage, ToolUse } from './protocol.js';
import type { Tracer } from '../trace/tracer.js';

/** Inline caps. Beyond them the row says `truncated` and stream.jsonl has all. */
const RESULT_CAP = 32_000;
const ARG_CAP = 16_000;
const TEXT_CAP = 64_000;
/** At most one db write per text block per this window; deltas keep arriving. */
const TEXT_FLUSH_MS = 250;

export interface FoldContext {
  tracer: Tracer;
  runId: string;
  phaseId: string;
  agent: string;
  /** Live "agent is typing" tail: a ring buffer, never stored. */
  onText?: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
  /** Injectable for tests; the throttle is wall-clock otherwise. */
  now?: () => number;
}

/** What kind of work a tool call is, so the UI can format without guessing. */
export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'other';

export function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Execute':
      return 'command';
    case 'Read':
      return 'read';
    case 'Create':
    case 'Edit':
    case 'ApplyPatch':
    case 'MultiEdit':
      return 'edit';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'search';
    default:
      return 'other';
  }
}

/** Human-readable label for a tool call so the trace reads like a build log. */
export function labelToolCall(tool: ToolUse): string {
  const input = (tool.input ?? {}) as Record<string, unknown>;
  const name = tool.name;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };

  switch (name) {
    case 'Execute': {
      const cmd = pick('command');
      return cmd ? `bash: ${firstLine(cmd)}` : 'bash';
    }
    case 'Read': {
      const p = pick('file_path', 'path');
      return p ? `read: ${short(p)}` : 'read';
    }
    case 'Create':
    case 'Edit':
    case 'ApplyPatch': {
      const p = pick('file_path', 'path');
      return p ? `${name.toLowerCase()}: ${short(p)}` : name.toLowerCase();
    }
    case 'Grep': {
      const q = pick('pattern');
      return q ? `grep: ${firstLine(q)}` : 'grep';
    }
    case 'Glob': {
      const q = pick('patterns', 'pattern');
      return q ? `glob: ${firstLine(q)}` : 'glob';
    }
    case 'LS': {
      const p = pick('directory_path', 'path');
      return p ? `ls: ${short(p)}` : 'ls';
    }
    default: {
      const summary = pick('summary', 'description');
      return summary ? `${name}: ${firstLine(summary)}` : name;
    }
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function short(path: string): string {
  const parts = path.split('/');
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : path;
}

/** A capped string plus the flag that says the cap bit. */
function capped(text: string, cap: number): { text: string; truncated: boolean } {
  return text.length > cap ? { text: text.slice(0, cap), truncated: true } : { text, truncated: false };
}

export function toUsageBreakdown(usage: TokenUsage | null | undefined): UsageBreakdown {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      credits: 0,
      reported: false,
    };
  }
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    thinkingTokens: usage.thinkingTokens ?? 0,
    credits: usage.factoryCredits ?? 0,
    reported: true,
  };
}

interface OpenCall {
  eventId: string;
  label: string;
}

interface OpenText {
  eventId: string;
  text: string;
  /** When the row was last patched; deltas between flushes stay in memory. */
  lastFlushAt: number;
}

export class EventFolder {
  /** toolUseId → the event row that spans that call. */
  private readonly openCalls = new Map<string, OpenCall>();
  /** messageId(:blockIndex) → the growing text row. */
  private readonly openTexts = new Map<string, OpenText>();
  private lastUsage: TokenUsage | null = null;
  /** Raw notifications, flushed to stream.jsonl at structural points. */
  private rawBuffer: string[] = [];

  constructor(private readonly ctx: FoldContext) {}

  get usage(): TokenUsage | null {
    return this.lastUsage;
  }

  /** One-shot adapters normalise a whole line at once; this absorbs the batch. */
  absorbAll(notifications: DroidNotification[]): void {
    for (const n of notifications) this.absorb(n);
  }

  private now(): number {
    return this.ctx.now?.() ?? Date.now();
  }

  absorb(n: DroidNotification): void {
    this.rawBuffer.push(JSON.stringify(n));
    switch (n.type) {
      case 'tool_call': {
        const tool = (n as { toolUse?: ToolUse }).toolUse;
        if (!tool?.id) return;
        const label = labelToolCall(tool);
        const existing = this.openCalls.get(tool.id);
        if (existing) {
          // Arguments arrive incrementally; keep the row open, sharpen the name.
          if (label !== existing.label && Object.keys(tool.input ?? {}).length) {
            this.ctx.tracer.renameEvent(existing.eventId, label, {
              args: trimArgs(tool.input),
              kind: toolKind(tool.name),
            });
            existing.label = label;
          }
          return;
        }
        const eventId = this.ctx.tracer.event({
          runId: this.ctx.runId,
          phaseId: this.ctx.phaseId,
          type: 'tool_call',
          name: label,
          payload: {
            tool: tool.name,
            kind: toolKind(tool.name),
            toolUseId: tool.id,
            args: trimArgs(tool.input),
          },
        });
        this.openCalls.set(tool.id, { eventId, label });
        this.flushRaw();
        return;
      }
      case 'tool_result': {
        const r = n as { toolUseId?: string; content?: string; isError?: boolean };
        if (!r.toolUseId) return;
        const open = this.openCalls.get(r.toolUseId);
        if (!open) return;
        this.openCalls.delete(r.toolUseId);
        const result = capped(r.content ?? '', RESULT_CAP);
        this.ctx.tracer.endEvent(open.eventId, {
          result: result.text,
          ...(result.truncated ? { truncated: true } : {}),
          isError: !!r.isError,
        });
        this.flushRaw();
        return;
      }
      case 'tool_execution_phase_changed': {
        const p = n as { toolUseId?: string; phase?: string };
        const open = p.toolUseId ? this.openCalls.get(p.toolUseId) : undefined;
        if (open && p.phase) this.ctx.tracer.patchEvent(open.eventId, { execPhase: p.phase });
        return;
      }
      case 'thinking_text_delta': {
        const d = n as { messageId?: string; textDelta?: string };
        if (d.messageId && d.textDelta) {
          this.growText(`thinking:${d.messageId}`, 'thinking', 'thinking', d.textDelta);
        }
        return;
      }
      case 'thinking_text_complete': {
        const c = n as { messageId?: string };
        if (c.messageId) this.closeText(`thinking:${c.messageId}`);
        this.flushRaw();
        return;
      }
      case 'assistant_text_delta': {
        const d = n as { messageId?: string; blockIndex?: number; textDelta?: string };
        if (d.textDelta) this.ctx.onText?.(d.textDelta);
        if (d.messageId !== undefined && d.textDelta) {
          this.growText(`text:${d.messageId}:${d.blockIndex ?? 0}`, 'assistant_text', 'assistant', d.textDelta);
        }
        return;
      }
      case 'assistant_text_complete': {
        const c = n as { messageId?: string; blockIndex?: number };
        if (c.messageId !== undefined) this.closeText(`text:${c.messageId}:${c.blockIndex ?? 0}`);
        this.flushRaw();
        return;
      }
      case 'session_token_usage_changed': {
        const u = (n as { tokenUsage?: TokenUsage }).tokenUsage;
        if (u) {
          this.lastUsage = u;
          this.ctx.onUsage?.(u);
        }
        return;
      }
      case 'agent_turn_completed': {
        const done = n as { cumulativeTokenUsage?: TokenUsage; tokenUsage?: TokenUsage };
        this.lastUsage = done.cumulativeTokenUsage ?? done.tokenUsage ?? this.lastUsage;
        this.flushRaw();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Appends one delta to a text row, creating it on the first delta and
   * patching the row at most once per TEXT_FLUSH_MS. The full text always
   * lands on close, so a throttled-away delta is a display lag, never a gap.
   */
  private growText(key: string, type: 'thinking' | 'assistant_text', name: string, delta: string): void {
    let open = this.openTexts.get(key);
    if (!open) {
      // A whole message can arrive as one delta (the one-shot normalisers do
      // this), so the cap applies from the first write, not just to growth.
      const first = capped(delta, TEXT_CAP);
      const eventId = this.ctx.tracer.event({
        runId: this.ctx.runId,
        phaseId: this.ctx.phaseId,
        type,
        name,
        payload: { text: first.text, ...(first.truncated ? { truncated: true } : {}) },
      });
      open = { eventId, text: delta, lastFlushAt: this.now() };
      this.openTexts.set(key, open);
      return;
    }
    open.text += delta;
    if (this.now() - open.lastFlushAt < TEXT_FLUSH_MS) return;
    open.lastFlushAt = this.now();
    const text = capped(open.text, TEXT_CAP);
    this.ctx.tracer.patchEvent(open.eventId, {
      text: text.text,
      ...(text.truncated ? { truncated: true } : {}),
    });
  }

  private closeText(key: string): void {
    const open = this.openTexts.get(key);
    if (!open) return;
    this.openTexts.delete(key);
    const text = capped(open.text, TEXT_CAP);
    this.ctx.tracer.endEvent(open.eventId, {
      text: text.text,
      ...(text.truncated ? { truncated: true } : {}),
    });
  }

  /** A turn that dies mid-tool must not leave a row that never ends. */
  closeDangling(note: string): void {
    for (const open of this.openCalls.values()) {
      this.ctx.tracer.endEvent(open.eventId, { result: note, isError: true });
    }
    this.openCalls.clear();
    for (const [key] of this.openTexts) {
      this.closeText(key);
    }
    this.flushRaw();
  }

  /**
   * The raw record: every notification, verbatim, one JSONL line each. The db
   * mirrors it display-ready and capped; this file is where "show me
   * everything" bottoms out. Flushes are buffered to structural points so a
   * fast delta stream does not become a write syscall per token, and a failed
   * append must not abort a run.
   */
  private flushRaw(): void {
    if (!this.rawBuffer.length) return;
    const lines = `${this.rawBuffer.join('\n')}\n`;
    this.rawBuffer = [];
    try {
      this.ctx.tracer.appendRunFile(this.ctx.runId, `${this.ctx.agent}/stream.jsonl`, lines);
    } catch {
      // The db is the queryable mirror; a failed file append must not abort a run.
    }
  }
}

function trimArgs(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > ARG_CAP) {
      out[k] = `${v.slice(0, ARG_CAP)}…`;
      out[`${k}Truncated`] = true;
    } else {
      out[k] = v;
    }
  }
  return out;
}
