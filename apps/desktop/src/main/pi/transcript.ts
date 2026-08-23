/**
 * The live transcript a one-shot session shows, folded from its event stream.
 *
 * Detection, setup-script generation, and the readiness fix each render a list
 * of lines while the agent works. `PanelSession` owns the list; this folder
 * is the one loop that turns runtime events into those lines, so the three
 * panels cannot disagree about when a tool row closes.
 *
 * This is not `events.ts`. That one writes trace rows for a run and owns caps,
 * throttles, and a raw JSONL mirror; this one grows an in-memory array a panel
 * re-renders from, for work that has no trace at all.
 *
 * The rules it encodes:
 * - Consecutive text deltas grow the last line rather than adding one per
 *   token, which is the difference between a paragraph and confetti.
 * - A tool call opens a row and its result closes that row, so the panel never
 *   shows a call that never returned. Failures stay visible as failures.
 */

import type { TranscriptToolKind } from '@shared/types.js';
import { labelToolCall, toolKind } from './events.js';
import type { TransportEvent } from './transport.js';

/** One line, in the shape all three panels already store. */
export interface TranscriptRow {
  kind: 'text' | 'tool' | 'note' | 'error';
  text: string;
  toolKind?: TranscriptToolKind;
  done?: boolean;
  failed?: boolean;
}

/**
 * Where the folded lines go. The caller owns the list because each panel keeps
 * its own — with its own id, timestamp, and cap — so this asks for the three
 * operations it needs rather than imposing a container.
 */
export interface TranscriptTarget<Row extends TranscriptRow> {
  /** Appends a line and returns the stored object, which this folder mutates. */
  push(row: TranscriptRow): Row;
  /** A stored line was mutated in place; re-render. */
  flush(): void;
  /** The most recent line, so consecutive text deltas grow one of them. */
  last(): Row | null;
  /** Cap on a single text line. Growth beyond it is dropped, not truncated mid-flight. */
  textCap?: number;
}

/**
 * Returns the folder for one session. Stateful: a tool result has to find the
 * row its call opened, and two sessions must not share that map.
 */
export function foldTranscript<Row extends TranscriptRow>(
  target: TranscriptTarget<Row>,
): (event: TransportEvent) => void {
  const openTools = new Map<string, Row>();

  return (event: TransportEvent): void => {
    switch (event.type) {
      case 'text_delta': {
        const last = target.last();
        if (last?.kind === 'text') {
          // Keep spaces and newlines: token streams often emit them alone.
          const grown = `${last.text}${event.delta}`;
          last.text = target.textCap ? grown.slice(0, target.textCap) : grown;
          target.flush();
        } else if (event.delta.trim()) {
          const first = target.textCap ? event.delta.slice(0, target.textCap) : event.delta;
          target.push({ kind: 'text', text: first });
        }
        return;
      }
      case 'tool_output': {
        const open = openTools.get(event.callId);
        if (!open) return;
        // Live command output replaces the label's trailing view, not the name.
        if (event.content) open.text = `${open.text.split('\n')[0]}\n${event.content}`;
        target.flush();
        return;
      }
      case 'retry': {
        target.push({
          kind: 'note',
          text: `retry ${event.attempt}/${event.maxAttempts}: ${event.message}`,
        });
        return;
      }
      case 'tool_call': {
        if (openTools.has(event.callId)) return;
        openTools.set(
          event.callId,
          target.push({
            kind: 'tool',
            text: labelToolCall(event.tool, event.input),
            toolKind: transcriptToolKind(event.tool),
          }),
        );
        return;
      }
      case 'tool_result': {
        const open = openTools.get(event.callId);
        if (!open) return;
        openTools.delete(event.callId);
        open.done = true;
        open.failed = event.isError;
        target.flush();
        return;
      }
      default:
        // Thinking and usage are a run's business; a one-shot panel shows the
        // answer and the work, not the accounting.
        return;
    }
  };
}

function transcriptToolKind(tool: string): TranscriptToolKind {
  const kind = toolKind(tool);
  return kind === 'progress' || kind === 'envelope' ? 'other' : kind;
}
