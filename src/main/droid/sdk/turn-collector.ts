/**
 * Per-turn facts the SDK's own result does not carry: the committed assistant
 * text (which survives an error turn where `result.text` empties) and droid's
 * raw completion reason, which the trace records rather than the SDK subtype.
 */

import type { DroidNotification, TokenUsage } from '../protocol.js';

export class TurnCollector {
  private committed = '';
  private lastUsage: TokenUsage | null = null;
  private lastReason: string | null = null;

  get text(): string {
    return this.committed;
  }

  get usage(): TokenUsage | null {
    return this.lastUsage;
  }

  get reason(): string | null {
    return this.lastReason;
  }

  absorb(n: DroidNotification): void {
    switch (n.type) {
      case 'create_message': {
        const message = (
          n as { message?: { role?: string; content?: { type: string; text?: string }[] } }
        ).message;
        if (message?.role !== 'assistant') return;
        const joined = (message.content ?? [])
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text as string)
          .join('\n');
        if (joined.trim()) this.committed = joined;
        return;
      }
      case 'session_token_usage_changed':
        this.lastUsage = (n as { tokenUsage?: TokenUsage }).tokenUsage ?? this.lastUsage;
        return;
      case 'agent_turn_completed': {
        const done = n as {
          reason?: string;
          tokenUsage?: TokenUsage;
          cumulativeTokenUsage?: TokenUsage;
        };
        this.lastUsage = done.cumulativeTokenUsage ?? done.tokenUsage ?? this.lastUsage;
        this.lastReason = done.reason ?? 'completed';
        return;
      }
      default:
        return;
    }
  }
}
