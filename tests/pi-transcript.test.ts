/**
 * One-shot transcript folding: whitespace tokens must stay, or streamed
 * prose glues together.
 */

import { describe, expect, it } from 'vitest';
import { foldTranscript, type TranscriptRow } from '../src/main/pi/transcript.js';

function target(): {
  rows: TranscriptRow[];
  fold: ReturnType<typeof foldTranscript>;
} {
  const rows: TranscriptRow[] = [];
  const fold = foldTranscript({
    push: (row) => {
      rows.push(row);
      return row;
    },
    flush: () => {},
    last: () => rows[rows.length - 1] ?? null,
  });
  return { rows, fold };
}

describe('foldTranscript', () => {
  it('keeps spaces that arrive as their own delta', () => {
    const { rows, fold } = target();
    fold({ type: 'text_delta', messageId: '1', blockIndex: 0, delta: 'Hello' });
    fold({ type: 'text_delta', messageId: '1', blockIndex: 0, delta: ' ' });
    fold({ type: 'text_delta', messageId: '1', blockIndex: 0, delta: 'world' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('Hello world');
  });

  it('does not open a row for a leading whitespace-only delta', () => {
    const { rows, fold } = target();
    fold({ type: 'text_delta', messageId: '1', blockIndex: 0, delta: '  ' });
    expect(rows).toHaveLength(0);
    fold({ type: 'text_delta', messageId: '1', blockIndex: 0, delta: 'Hi' });
    expect(rows[0]!.text).toBe('Hi');
  });
});
