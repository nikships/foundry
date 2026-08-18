/**
 * Folds a transport's event stream into trace rows.
 *
 * A transport re-emits text as deltas arrive, so a naive mapping writes a row
 * per token and buries the db. Folding keeps one spanning row per real tool
 * call, named readably ("bash: npm test"), closed on the result; text gets one
 * row per block, patched in place (throttled) so the Inspector shows a growing
 * paragraph instead of confetti.
 *
 * Every event also lands verbatim in the agent's `stream.jsonl`, the
 * full-fidelity raw record. The db row is the display-ready mirror and says so
 * when it truncated.
 *
 * This consumes `TransportEvent`, not a vendor's own notifications, so there is
 * exactly one place that knows what a trace row looks like.
 */

import type { UsageBreakdown } from '@shared/types.js';
import type { Tracer } from '../trace/tracer.js';
import type { TransportEvent, TurnUsage } from './transport.js';

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
  /** Injectable for tests; the throttle is wall-clock otherwise. */
  now?: () => number;
}

/** What kind of work a tool call is, so the UI can format without guessing. */
export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'progress' | 'envelope' | 'other';

export function toolKind(name: string): ToolKind {
  switch (name) {
    case 'bash':
      return 'command';
    case 'read':
      return 'read';
    case 'edit':
    case 'write':
      return 'edit';
    case 'grep':
    case 'find':
    case 'ls':
      return 'search';
    case 'report_progress':
      return 'progress';
    case 'submit_envelope':
    case 'read_phase_context':
      return 'envelope';
    default:
      return 'other';
  }
}

/** Human-readable label for a tool call so the trace reads like a build log. */
export function labelToolCall(tool: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };

  switch (tool) {
    case 'bash': {
      const command = pick('command');
      return command ? `bash: ${firstLine(command)}` : 'bash';
    }
    case 'read':
    case 'edit':
    case 'write':
    case 'ls': {
      const path = pick('path');
      return path ? `${tool}: ${short(path)}` : tool;
    }
    case 'grep':
    case 'find': {
      const pattern = pick('pattern');
      return pattern ? `${tool}: ${firstLine(pattern)}` : tool;
    }
    case 'report_progress': {
      const summary = pick('summary');
      return summary ? `progress: ${firstLine(summary)}` : 'progress';
    }
    default: {
      const summary = pick('summary', 'description', 'query', 'path', 'pattern');
      return summary ? `${tool}: ${firstLine(summary)}` : tool;
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
  return text.length > cap
    ? { text: text.slice(0, cap), truncated: true }
    : { text, truncated: false };
}

export function toUsageBreakdown(usage: TurnUsage | null | undefined): UsageBreakdown {
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      credits: 0,
      cost: 0,
      reported: false,
    };
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    thinkingTokens: usage.thinkingTokens,
    // Credits are a droid-only accounting unit; a Pi turn prices in dollars.
    credits: 0,
    cost: usage.cost,
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
  /** callId → the event row that spans that call. */
  private readonly openCalls = new Map<string, OpenCall>();
  /** messageId(:blockIndex) → the growing text row. */
  private readonly openTexts = new Map<string, OpenText>();
  private lastUsage: TurnUsage | null = null;
  /** Raw events, flushed to stream.jsonl at structural points. */
  private rawBuffer: string[] = [];

  constructor(private readonly ctx: FoldContext) {}

  get usage(): TurnUsage | null {
    return this.lastUsage;
  }

  private now(): number {
    return this.ctx.now?.() ?? Date.now();
  }

  absorb(event: TransportEvent): void {
    this.rawBuffer.push(JSON.stringify(event));
    switch (event.type) {
      case 'tool_call': {
        if (this.openCalls.has(event.callId)) return;
        const label = labelToolCall(event.tool, event.input);
        const eventId = this.ctx.tracer.event({
          runId: this.ctx.runId,
          phaseId: this.ctx.phaseId,
          type: 'tool_call',
          name: label,
          payload: {
            tool: event.tool,
            kind: toolKind(event.tool),
            toolUseId: event.callId,
            args: trimArgs(event.input),
          },
        });
        this.openCalls.set(event.callId, { eventId, label });
        this.flushRaw();
        return;
      }
      case 'tool_result': {
        const open = this.openCalls.get(event.callId);
        if (!open) return;
        this.openCalls.delete(event.callId);
        const result = capped(event.content, RESULT_CAP);
        this.ctx.tracer.endEvent(open.eventId, {
          result: result.text,
          ...(result.truncated ? { truncated: true } : {}),
          isError: event.isError,
        });
        this.flushRaw();
        return;
      }
      case 'thinking_delta': {
        this.growText(`thinking:${event.messageId}`, 'thinking', 'thinking', event.delta);
        return;
      }
      case 'thinking_end': {
        this.closeText(`thinking:${event.messageId}`);
        this.flushRaw();
        return;
      }
      case 'text_delta': {
        this.ctx.onText?.(event.delta);
        this.growText(
          `text:${event.messageId}:${event.blockIndex}`,
          'assistant_text',
          'assistant',
          event.delta,
        );
        return;
      }
      case 'text_end': {
        this.closeText(`text:${event.messageId}:${event.blockIndex}`);
        this.flushRaw();
        return;
      }
      case 'usage': {
        this.lastUsage = event.usage;
        this.flushRaw();
        return;
      }
    }
  }

  /**
   * Appends one delta to a text row, creating it on the first delta and
   * patching the row at most once per TEXT_FLUSH_MS. The full text always
   * lands on close, so a throttled-away delta is a display lag, never a gap.
   */
  private growText(
    key: string,
    type: 'thinking' | 'assistant_text',
    name: string,
    delta: string,
  ): void {
    const open = this.openTexts.get(key);
    if (!open) {
      // A whole block can arrive as one delta, so the cap applies from the
      // first write, not just to growth.
      const first = capped(delta, TEXT_CAP);
      const eventId = this.ctx.tracer.event({
        runId: this.ctx.runId,
        phaseId: this.ctx.phaseId,
        type,
        name,
        payload: { text: first.text, ...(first.truncated ? { truncated: true } : {}) },
      });
      this.openTexts.set(key, { eventId, text: delta, lastFlushAt: this.now() });
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
    for (const [key] of this.openTexts) this.closeText(key);
    this.flushRaw();
  }

  /**
   * The raw record: every event, verbatim, one JSONL line each. The db mirrors
   * it display-ready and capped; this file is where "show me everything"
   * bottoms out. Flushes are buffered to structural points so a fast delta
   * stream does not become a write syscall per token, and a failed append must
   * not abort a run.
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

function trimArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length > ARG_CAP) {
      out[key] = `${value.slice(0, ARG_CAP)}…`;
      out[`${key}Truncated`] = true;
    } else {
      out[key] = value;
    }
  }
  return out;
}
