import { describe, expect, it } from 'vitest';
import {
  axisLabel,
  axisTicks,
  buildTimeScale,
  densityBins,
  type Span,
} from '@renderer/utils/time-scale.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** The 11h run from the bug report: ~21m of work, then a long checkpoint wait. */
const LONG_RUN: Span[] = [
  { start: 0, end: 49 * SECOND },
  { start: 50 * SECOND, end: 702 * SECOND },
  { start: 703 * SECOND, end: 703 * SECOND + 230 },
  { start: 705 * SECOND, end: 1236 * SECOND },
  { start: 1237 * SECOND, end: 1265 * SECOND },
  { start: 11 * HOUR + 5 * MINUTE + 37 * SECOND, end: 11 * HOUR + 5 * MINUTE + 37 * SECOND + 68 },
  { start: 11 * HOUR + 5 * MINUTE + 39 * SECOND, end: 11 * HOUR + 7 * MINUTE },
];
const LONG_TOTAL = 11 * HOUR + 7 * MINUTE;

describe('buildTimeScale', () => {
  it('collapses a long idle stretch so working phases keep real width', () => {
    const scale = buildTimeScale(LONG_RUN, LONG_TOTAL);
    expect(scale.compressed).toBe(true);

    // Linearly, 21m of work in an 11h run is under 4% of the track.
    const linear = ((1265 * SECOND) / LONG_TOTAL) * 100;
    expect(linear).toBeLessThan(4);

    // The compressed scale gives that same work the bulk of the width.
    expect(scale.toPercent(1265 * SECOND)).toBeGreaterThan(80);
  });

  it('marks the idle stretch as a break segment carrying its real duration', () => {
    const scale = buildTimeScale(LONG_RUN, LONG_TOTAL);
    const breaks = scale.segments.filter((s) => s.kind === 'break');
    expect(breaks).toHaveLength(1);
    const idle = breaks[0].t1 - breaks[0].t0;
    expect(idle).toBeGreaterThan(10 * HOUR);
    // A break is a fixed sliver regardless of how long the wait was.
    expect(breaks[0].x1 - breaks[0].x0).toBeCloseTo(4.5, 1);
  });

  it('leaves a run with no meaningful idle uncompressed', () => {
    const spans: Span[] = [
      { start: 0, end: 56 * SECOND },
      { start: 57 * SECOND, end: 676 * SECOND },
      { start: 677 * SECOND, end: 677 * SECOND + 288 },
      { start: 678 * SECOND, end: 697 * SECOND },
    ];
    const scale = buildTimeScale(spans, 693 * SECOND);
    expect(scale.compressed).toBe(false);
    expect(scale.segments).toHaveLength(1);
  });

  it('stays monotonic and inside 0..100 across the domain', () => {
    const scale = buildTimeScale(LONG_RUN, LONG_TOTAL);
    let prev = -1;
    for (let t = 0; t <= LONG_TOTAL; t += LONG_TOTAL / 200) {
      const x = scale.toPercent(t);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
    expect(scale.toPercent(LONG_TOTAL)).toBeCloseTo(100, 5);
  });

  it('clamps out-of-domain input instead of overflowing the track', () => {
    const scale = buildTimeScale([{ start: 0, end: 60 * SECOND }], 60 * SECOND);
    expect(scale.toPercent(-5000)).toBe(0);
    expect(scale.toPercent(999 * HOUR)).toBe(100);
    expect(scale.toPercent(Number.NaN)).toBe(0);
  });

  it('survives a run with no started phases', () => {
    const scale = buildTimeScale([], 30 * SECOND);
    expect(scale.segments.length).toBeGreaterThan(0);
    expect(scale.toPercent(30 * SECOND)).toBeCloseTo(100, 5);
  });

  it('merges overlapping phase spans into one active stretch', () => {
    const scale = buildTimeScale(
      [
        { start: 0, end: 40 * SECOND },
        { start: 20 * SECOND, end: 60 * SECOND },
      ],
      60 * SECOND,
    );
    expect(scale.segments.filter((s) => s.kind === 'active')).toHaveLength(1);
    expect(scale.compressed).toBe(false);
  });
});

describe('axisTicks', () => {
  it('keeps an 11h run to a handful of labels instead of 133', () => {
    const scale = buildTimeScale(LONG_RUN, LONG_TOTAL);
    const ticks = axisTicks(scale, 730);
    // The old fixed 5-minute step produced one tick per 5 min of an 11h span.
    expect(Math.floor(LONG_TOTAL / (5 * MINUTE))).toBeGreaterThan(100);
    expect(ticks.length).toBeLessThanOrEqual(8);
    expect(ticks.length).toBeGreaterThan(1);
  });

  it('never places two labels closer than the collision floor', () => {
    for (const px of [320, 640, 1200]) {
      const scale = buildTimeScale(LONG_RUN, LONG_TOTAL);
      const ticks = axisTicks(scale, px);
      const xs = ticks.map((t) => (t.x / 100) * px).sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThan(60);
    }
  });

  it('keeps ticks clear of the break label that overhangs the sliver', () => {
    const scale = buildTimeScale(LONG_RUN, LONG_TOTAL);
    const breaks = scale.segments.filter((s) => s.kind === 'break');
    expect(breaks).toHaveLength(1);

    for (const px of [420, 520, 640, 900, 1200]) {
      const centre = ((breaks[0].x0 + breaks[0].x1) / 2 / 100) * px;
      for (const tick of axisTicks(scale, px)) {
        expect(Math.abs((tick.x / 100) * px - centre)).toBeGreaterThanOrEqual(58);
      }
    }
  });

  it('always includes the origin', () => {
    const scale = buildTimeScale([{ start: 0, end: 90 * SECOND }], 90 * SECOND);
    expect(axisTicks(scale, 600)[0]).toEqual({ t: 0, x: 0 });
  });

  it('emits only the origin when the track is too narrow to label', () => {
    const scale = buildTimeScale([{ start: 0, end: 90 * SECOND }], 90 * SECOND);
    expect(axisTicks(scale, 40)).toHaveLength(1);
  });
});

describe('axisLabel', () => {
  it('formats each magnitude compactly', () => {
    expect(axisLabel(0)).toBe('0');
    expect(axisLabel(250)).toBe('250ms');
    expect(axisLabel(30 * SECOND)).toBe('30s');
    expect(axisLabel(5 * MINUTE)).toBe('5m');
    expect(axisLabel(90 * SECOND)).toBe('1m 30s');
    expect(axisLabel(2 * HOUR)).toBe('2h');
    expect(axisLabel(HOUR + 30 * MINUTE)).toBe('1h 30m');
  });
});

describe('densityBins', () => {
  const span: Span = { start: 0, end: 100 * SECOND };

  it('caps bin count so a dense phase cannot paint the bar solid', () => {
    const offsets = Array.from({ length: 300 }, (_, i) => (i / 300) * 100 * SECOND);
    const bins = densityBins(offsets, span, 900);
    expect(bins.length).toBeLessThanOrEqual(48);
    expect(bins.reduce((n, b) => n + b.count, 0)).toBe(300);
  });

  it('scales bin count to the available pixels', () => {
    const offsets = Array.from({ length: 60 }, (_, i) => (i / 60) * 100 * SECOND);
    expect(densityBins(offsets, span, 30).length).toBeLessThanOrEqual(10);
  });

  it('reports a peak so callers can normalise height', () => {
    const offsets = [0, 0, 0, 99 * SECOND];
    const bins = densityBins(offsets, span, 60);
    expect(Math.max(...bins.map((b) => b.peak))).toBe(3);
  });

  it('returns nothing for a phase with no tool calls', () => {
    expect(densityBins([], span, 400)).toEqual([]);
  });

  it('keeps a zero-length span from producing an out-of-range bin', () => {
    const bins = densityBins([0, 0], { start: 5, end: 5 }, 40);
    expect(bins).toHaveLength(1);
    expect(bins[0].index).toBe(0);
  });
});
