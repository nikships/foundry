import { describe, expect, it } from 'vitest';
import { runRequestHeight } from '@renderer/components/run/ResizableRunRequest.js';

describe('run request resizing', () => {
  it('tracks the pointer delta within the available space', () => {
    expect(runRequestHeight(76, 40, 1_000)).toBe(116);
    expect(runRequestHeight(116, -24, 1_000)).toBe(92);
  });

  it('keeps the prompt usable when dragged closed', () => {
    expect(runRequestHeight(76, -1_000, 1_000)).toBe(42);
  });

  it('preserves room for run details when dragged open', () => {
    expect(runRequestHeight(76, 1_000, 600)).toBe(252);
    expect(runRequestHeight(76, 1_000, 2_000)).toBe(360);
  });
});
