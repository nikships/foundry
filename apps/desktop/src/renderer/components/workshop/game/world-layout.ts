export interface WorldPoint {
  x: number;
  y: number;
}
export interface Workbench extends WorldPoint {
  width: number;
}

export const WORLD_HEIGHT = 1080;
export const GROUND_Y = 925;

/**
 * In-world text is rasterized once, then scaled by devicePixelRatio and up to
 * 1.8x camera zoom, so a 1x raster blurs. Rasterize at DPR x zoom headroom.
 */
export const TEXT_RESOLUTION = Math.min(4, (globalThis.devicePixelRatio || 1) * 2);
const HEIGHTS = [760, 555, 795, 595, 755, 525];

export function benchAt(index: number): Workbench {
  return { x: 250 + index * 370, y: HEIGHTS[index % HEIGHTS.length]!, width: 260 };
}

export function worldWidth(count: number): number {
  return Math.max(1600, count * 370 + 160);
}

export function deliveryVelocity(from: WorldPoint, to: WorldPoint, gravity = 650): WorldPoint {
  const seconds = Math.max(0.7, Math.min(2.2, Math.abs(to.x - from.x) / 340));
  return {
    x: (to.x - from.x) / seconds,
    y: (to.y - from.y - 0.5 * gravity * seconds * seconds) / seconds,
  };
}
