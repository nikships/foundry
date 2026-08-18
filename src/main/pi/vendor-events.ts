/**
 * Pi's session events, translated into the neutral stream everything above
 * this directory reads.
 *
 * Shared by the long-lived transport an agent phase runs on and the
 * short-lived one-shot a detection, a setup, a repair, or a readiness fix
 * opens. Both need the same translation, and the two live transcripts the app
 * shows are only consistent because there is one of it.
 *
 * The reader is stateful for two reasons: a text block is identified by the
 * message it belongs to, which Pi announces separately from its deltas, and a
 * turn's usage is the sum over its assistant messages rather than the last one.
 */

import type {
  AgentSession as PiAgentSession,
  AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { PiUsage } from './model.js';
import type { TransportEvent, TurnUsage } from './transport.js';

/**
 * How the turn ended, read off the last assistant message.
 *
 * `prompt()` resolves without saying why it stopped, so the stop reason has to
 * be recovered from the transcript. An abort and a model error are both
 * ordinary resolutions there, and telling them apart is what lets a caller
 * report an interruption instead of an empty answer.
 */
export function lastAssistantStop(session: PiAgentSession): {
  stopReason: string;
  errorMessage?: string;
} | null {
  const messages = session.state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === 'assistant') {
      return {
        stopReason: message.stopReason,
        ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      };
    }
  }
  return null;
}

export class VendorEventReader {
  /** Distinguishes text blocks of different messages in the folded trace. */
  private messageSeq = 0;
  private usage: TurnUsage | null = null;

  /** What this turn has cost so far, or null before any usage was reported. */
  get turnUsage(): TurnUsage | null {
    return this.usage;
  }

  /** Called between turns: usage is per turn, the message counter is not. */
  startTurn(): void {
    this.usage = null;
  }

  absorb(event: AgentSessionEvent, emit: (event: TransportEvent) => void): void {
    switch (event.type) {
      case 'message_start':
        this.messageSeq += 1;
        return;
      case 'message_update': {
        const inner = event.assistantMessageEvent;
        const messageId = String(this.messageSeq);
        if (inner.type === 'text_delta') {
          emit({
            type: 'text_delta',
            messageId,
            blockIndex: inner.contentIndex,
            delta: inner.delta,
          });
        } else if (inner.type === 'text_end') {
          emit({ type: 'text_end', messageId, blockIndex: inner.contentIndex });
        } else if (inner.type === 'thinking_delta') {
          emit({ type: 'thinking_delta', messageId, delta: inner.delta });
        } else if (inner.type === 'thinking_end') {
          emit({ type: 'thinking_end', messageId });
        }
        return;
      }
      case 'message_end': {
        const message = event.message;
        if (message.role !== 'assistant') return;
        // Usage arrives per assistant message; a turn is several of them, so
        // the turn's figure is the sum rather than the last one.
        this.usage = addUsage(this.usage, message.usage);
        if (this.usage) emit({ type: 'usage', usage: this.usage });
        return;
      }
      case 'tool_execution_start':
        emit({
          type: 'tool_call',
          callId: event.toolCallId,
          tool: event.toolName,
          input: asRecord(event.args),
        });
        return;
      case 'tool_execution_end':
        emit({
          type: 'tool_result',
          callId: event.toolCallId,
          content: resultText(event.result),
          isError: event.isError,
        });
        return;
      default:
        return;
    }
  }
}

function addUsage(current: TurnUsage | null, usage: PiUsage | undefined): TurnUsage | null {
  if (!usage) return current;
  const base = current ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    cost: 0,
  };
  return {
    inputTokens: base.inputTokens + usage.input,
    outputTokens: base.outputTokens + usage.output,
    cacheCreationTokens: base.cacheCreationTokens + usage.cacheWrite,
    cacheReadTokens: base.cacheReadTokens + usage.cacheRead,
    thinkingTokens: base.thinkingTokens + (usage.reasoning ?? 0),
    cost: base.cost + usage.cost.total,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A tool answers with content blocks; the trace row wants one string. */
function resultText(result: unknown): string {
  const content = asRecord(result).content;
  if (!Array.isArray(content)) return typeof result === 'string' ? result : '';
  return content
    .map((block) => {
      const item = asRecord(block);
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n');
}
