/**
 * Folds droid's notification stream into trace rows.
 *
 * Droid re-emits `tool_call` for the same toolUseId as arguments stream in, so
 * a naive mapping writes several rows for one call. Folding keeps one spanning
 * row per real call, named readably ("bash: bun test"), closed on the result.
 */

import type { UsageBreakdown } from '@shared/types.js';
import type { DroidNotification, TokenUsage, ToolUse } from './protocol.js';
import type { Tracer } from '../trace/tracer.js';

const RESULT_TAIL = 2000;
const ARG_TAIL = 600;

export interface FoldContext {
  tracer: Tracer;
  runId: string;
  phaseId: string;
  agent: string;
  /** Live "agent is typing" tail: a ring buffer, never stored. */
  onText?: (text: string) => void;
  onUsage?: (usage: TokenUsage) => void;
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

export class EventFolder {
  /** toolUseId → the event row that spans that call. */
  private readonly openCalls = new Map<string, { eventId: string; label: string }>();
  private lastUsage: TokenUsage | null = null;

  constructor(private readonly ctx: FoldContext) {}

  get usage(): TokenUsage | null {
    return this.lastUsage;
  }

  absorb(n: DroidNotification): void {
    switch (n.type) {
      case 'tool_call': {
        const tool = (n as { toolUse?: ToolUse }).toolUse;
        if (!tool?.id) return;
        const label = labelToolCall(tool);
        const existing = this.openCalls.get(tool.id);
        if (existing) {
          // Arguments arrive incrementally; keep the row open, sharpen the name.
          if (label !== existing.label && Object.keys(tool.input ?? {}).length) {
            this.ctx.tracer.renameEvent(existing.eventId, label, { args: trimArgs(tool.input) });
            existing.label = label;
          }
          return;
        }
        const eventId = this.ctx.tracer.event({
          runId: this.ctx.runId,
          phaseId: this.ctx.phaseId,
          type: 'tool_call',
          name: label,
          payload: { tool: tool.name, toolUseId: tool.id, args: trimArgs(tool.input) },
        });
        this.openCalls.set(tool.id, { eventId, label });
        return;
      }
      case 'tool_result': {
        const r = n as { toolUseId?: string; content?: string; isError?: boolean };
        if (!r.toolUseId) return;
        const open = this.openCalls.get(r.toolUseId);
        if (!open) return;
        this.openCalls.delete(r.toolUseId);
        this.ctx.tracer.endEvent(open.eventId, {
          result: (r.content ?? '').slice(0, RESULT_TAIL),
          isError: !!r.isError,
        });
        return;
      }
      case 'assistant_text_delta': {
        const d = (n as { textDelta?: string }).textDelta;
        if (d) this.ctx.onText?.(d);
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
        return;
      }
      default:
        return;
    }
  }

  /** A turn that dies mid-tool must not leave a row that never ends. */
  closeDangling(note: string): void {
    for (const open of this.openCalls.values()) {
      this.ctx.tracer.endEvent(open.eventId, { result: note, isError: true });
    }
    this.openCalls.clear();
  }
}

function trimArgs(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === 'string' && v.length > ARG_TAIL ? `${v.slice(0, ARG_TAIL)}…` : v;
  }
  return out;
}
