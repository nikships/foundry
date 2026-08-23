/**
 * Piecewise time scale for the run timeline.
 *
 * A run's wall-clock span is a bad x-axis: a phase can wait hours at a
 * checkpoint, and a linear scale then spends most of its pixels on nothing
 * while every phase that did work collapses into a sliver. This maps time to
 * width in segments instead — stretches where a phase was running keep
 * proportional width, and long idle stretches collapse to a fixed sliver that
 * the axis labels as a break. The mapping stays monotonic, so ordering and
 * overlap still read correctly.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Width a collapsed idle stretch gets, as a fraction of the track. */
const BREAK_FRACTION = 0.045;

/** Idle must exceed both to be worth collapsing: a share of the run, and a floor. */
const BREAK_SHARE = 0.06;
const BREAK_FLOOR = 45 * SECOND;

/** Minimum px between axis labels; the tick step is chosen to respect it. */
const MIN_TICK_PX = 92;

/**
 * Half-width reserved for a break's "Nh NNm idle" label. The break itself is a
 * narrow sliver, so its label overhangs on both sides and would collide with a
 * tick landing at the boundary.
 */
const BREAK_LABEL_HALF_PX = 58;

const NICE_STEPS = [
  SECOND,
  2 * SECOND,
  5 * SECOND,
  10 * SECOND,
  15 * SECOND,
  30 * SECOND,
  MINUTE,
  2 * MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
];

export interface Span {
  start: number;
  end: number;
}

export interface ScaleSegment {
  kind: 'active' | 'break';
  /** Time bounds, ms from run start. */
  t0: number;
  t1: number;
  /** Width bounds as percentages of the track. */
  x0: number;
  x1: number;
}

export interface TimeScale {
  segments: ScaleSegment[];
  /** Total run length in ms, the domain this scale covers. */
  total: number;
  /** True when at least one idle stretch was collapsed. */
  compressed: boolean;
  /** Map a time offset (ms from run start) to a percentage of the track. */
  toPercent: (ms: number) => number;
}

export interface AxisTick {
  /** Time offset in ms from run start. */
  t: number;
  /** Position as a percentage of the track. */
  x: number;
}

/** Merge overlapping/touching spans into a sorted, disjoint list. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans]
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const end = Math.max(span.end, span.start);
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, end);
    else merged.push({ start: span.start, end });
  }
  return merged;
}

/**
 * Build a scale over `total` ms, keeping `active` spans proportional and
 * collapsing the idle stretches between them.
 */
export function buildTimeScale(active: Span[], total: number): TimeScale {
  const domain = Math.max(total, 1);
  const merged = mergeSpans(active);
  const end = Math.max(domain, merged.length ? merged[merged.length - 1].end : 0);
  const threshold = Math.max(end * BREAK_SHARE, BREAK_FLOOR);

  const raw: { kind: 'active' | 'break'; t0: number; t1: number }[] = [];
  const push = (kind: 'active' | 'break', t0: number, t1: number): void => {
    if (t1 > t0) raw.push({ kind, t0, t1 });
  };

  let cursor = 0;
  for (const span of merged) {
    push(span.start - cursor > threshold ? 'break' : 'active', cursor, span.start);
    push('active', span.start, span.end);
    cursor = span.end;
  }
  push(end - cursor > threshold ? 'break' : 'active', cursor, end);

  // Collapse adjacent actives so tick generation sees one continuous stretch.
  const segments: ScaleSegment[] = [];
  for (const seg of raw) {
    const last = segments[segments.length - 1];
    if (last && last.kind === 'active' && seg.kind === 'active') last.t1 = seg.t1;
    else segments.push({ ...seg, x0: 0, x1: 0 });
  }
  if (!segments.length) segments.push({ kind: 'active', t0: 0, t1: end, x0: 0, x1: 0 });

  const breaks = segments.filter((s) => s.kind === 'break').length;
  const activeMs = segments.reduce((n, s) => n + (s.kind === 'active' ? s.t1 - s.t0 : 0), 0);
  // All-idle runs have no proportional time to distribute; share width evenly.
  const activeWidth = Math.max(0, 1 - breaks * BREAK_FRACTION);

  let x = 0;
  for (const seg of segments) {
    seg.x0 = x * 100;
    if (seg.kind === 'break') x += BREAK_FRACTION;
    else x += activeMs > 0 ? ((seg.t1 - seg.t0) / activeMs) * activeWidth : activeWidth;
    seg.x1 = x * 100;
  }
  // Absorb rounding so the last segment lands exactly on 100%.
  if (segments.length) segments[segments.length - 1].x1 = 100;

  const toPercent = (ms: number): number => {
    if (!Number.isFinite(ms)) return 0;
    if (ms <= 0) return 0;
    for (const seg of segments) {
      if (ms > seg.t1) continue;
      if (ms < seg.t0) return seg.x0;
      const fraction = seg.t1 === seg.t0 ? 0 : (ms - seg.t0) / (seg.t1 - seg.t0);
      return seg.x0 + fraction * (seg.x1 - seg.x0);
    }
    return 100;
  };

  return { segments, total: end, compressed: breaks > 0, toPercent };
}

/**
 * Axis ticks at nice round intervals, generated per active segment and spaced
 * so labels cannot collide at the given track width.
 */
export function axisTicks(scale: TimeScale, trackPx: number): AxisTick[] {
  const width = Math.max(trackPx, 1);
  const ticks: AxisTick[] = [{ t: 0, x: 0 }];

  // Centres of every break label, in px, so ticks can keep clear of them.
  const breakCentres = scale.segments
    .filter((s) => s.kind === 'break')
    .map((s) => ((s.x0 + s.x1) / 2 / 100) * width);

  for (const seg of scale.segments) {
    if (seg.kind !== 'active') continue;
    const segPx = ((seg.x1 - seg.x0) / 100) * width;
    const segMs = seg.t1 - seg.t0;
    if (segPx < MIN_TICK_PX || segMs <= 0) continue;

    const minStep = (MIN_TICK_PX / segPx) * segMs;
    const step = NICE_STEPS.find((n) => n >= minStep) ?? NICE_STEPS[NICE_STEPS.length - 1];

    for (let t = Math.ceil(seg.t0 / step) * step; t <= seg.t1; t += step) {
      const x = scale.toPercent(t);
      const px = (x / 100) * width;
      const hitsTick = ticks.some((o) => Math.abs((o.x / 100) * width - px) < MIN_TICK_PX * 0.75);
      const hitsBreak = breakCentres.some((c) => Math.abs(c - px) < BREAK_LABEL_HALF_PX);
      if (!hitsTick && !hitsBreak) ticks.push({ t, x });
    }
  }
  return ticks;
}

/** Compact axis form: `0`, `250ms`, `30s`, `5m`, `1h 30m`. */
export function axisLabel(ms: number): string {
  if (ms <= 0) return '0';
  if (ms < SECOND) return `${Math.round(ms)}ms`;
  if (ms < MINUTE) return `${Math.round(ms / SECOND)}s`;
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    const seconds = Math.round((ms % MINUTE) / SECOND);
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.round((ms % HOUR) / MINUTE);
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Bin timestamps into fixed pixel columns so a phase with hundreds of tool
 * calls renders as readable density instead of a solid block.
 */
export function densityBins(
  offsets: number[],
  span: Span,
  barPx: number,
): { index: number; count: number; total: number; peak: number }[] {
  const width = span.end - span.start;
  const count = Math.max(1, Math.min(48, Math.floor(barPx / 3)));
  if (!offsets.length) return [];

  const bins = new Array<number>(count).fill(0);
  for (const at of offsets) {
    const fraction = width <= 0 ? 0 : (at - span.start) / width;
    const index = Math.min(count - 1, Math.max(0, Math.floor(fraction * count)));
    bins[index] += 1;
  }
  const peak = Math.max(...bins);
  return bins
    .map((n, index) => ({ index, count: n, total: count, peak }))
    .filter((b) => b.count > 0);
}
