/**
 * Pure boid physics for the Murmur flock. No React, no DOM, no canvas.
 * Reynolds separation / alignment / cohesion plus phase-specific tweaks.
 */

export interface Boid {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  maxSpeed: number;
}

export type FlockPhase = 'launch' | 'flock' | 'disperse' | 'drift';

export const MURMUR_FLOCK = {
  /** Default count; adaptive logic may lower to 55. */
  defaultCount: 72,
  minCount: 55,
  maxCount: 90,
  maxForce: 0.05,
  sepR: 24,
  aliR: 52,
  cohR: 78,
  wSep: 1.35,
  wAli: 1.0,
  wCoh: 0.9,
  /** Upward bias during launch phase. */
  launchLift: 0.02,
  /** Soft edge bounce impulse. */
  edgeBounce: 0.14,
  edgeMargin: 8,
  friction: 0.998,
} as const;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Spawn boids along a ground line just above the bottom edge of the given rect.
 */
export function createBoids(count: number, w: number, h: number): Boid[] {
  const groundY = h - 14;
  const boids: Boid[] = [];
  for (let i = 0; i < count; i++) {
    const x = rand(w * 0.08, w * 0.92);
    const y = groundY + rand(-4, 4);
    const vx = rand(-0.7, 0.7);
    const vy = rand(-2.8, -1.6);
    const maxSpeed = rand(1.9, 2.4);
    // Slight convergence toward center on spawn so the flock initially tightens.
    const toCenter = (w * 0.5 - x) * 0.003;
    boids.push({ x, y, vx: vx + toCenter, vy, ax: 0, ay: 0, maxSpeed });
  }
  return boids;
}

/**
 * Advance boids by one frame. dt is in seconds (expect ~1/60).
 */
export function tickBoids(
  boids: Boid[],
  w: number,
  h: number,
  phase: FlockPhase,
  dt: number,
): void {
  const {
    maxForce,
    sepR,
    aliR,
    cohR,
    wSep,
    wAli,
    wCoh,
    launchLift,
    edgeBounce,
    edgeMargin,
    friction,
  } = MURMUR_FLOCK;
  const sepR2 = sepR * sepR;
  const aliR2 = aliR * aliR;
  const cohR2 = cohR * cohR;

  // Phase weights: cohesion loosens over time, flock disperses.
  let cw: number = wCoh;
  let aw: number = wAli;
  let sw: number = wSep;
  if (phase === 'flock') {
    sw = 1.1;
  } else if (phase === 'disperse') {
    cw = 0.45;
    aw = 0.6;
  } else if (phase === 'drift') {
    sw = 0.85;
    aw = 0.4;
    cw = 0.25;
  }

  // Center pull varies by phase.
  const centerPull = phase === 'flock' ? 0.008 : phase === 'launch' ? 0 : 0.002;
  const cx = w * 0.5;
  const cy = h * 0.45;

  for (const b of boids) {
    let sepX = 0;
    let sepY = 0;
    let aliX = 0;
    let aliY = 0;
    let cohX = 0;
    let cohY = 0;
    let nSep = 0;
    let nAli = 0;
    let nCoh = 0;

    for (const o of boids) {
      if (o === b) continue;
      const dx = b.x - o.x;
      const dy = b.y - o.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < sepR2 && d2 > 1) {
        const inv = 1 / Math.sqrt(d2);
        sepX += dx * inv;
        sepY += dy * inv;
        nSep++;
      }
      if (d2 < aliR2) {
        aliX += o.vx;
        aliY += o.vy;
        nAli++;
      }
      if (d2 < cohR2) {
        cohX += o.x;
        cohY += o.y;
        nCoh++;
      }
    }

    let ax = 0;
    let ay = 0;

    if (nSep > 0) {
      sepX /= nSep;
      sepY /= nSep;
      const m = Math.hypot(sepX, sepY) || 1;
      sepX = (sepX / m) * b.maxSpeed;
      sepY = (sepY / m) * b.maxSpeed;
      ax += (sepX - b.vx) * sw;
      ay += (sepY - b.vy) * sw;
    }
    if (nAli > 0) {
      aliX /= nAli;
      aliY /= nAli;
      const m = Math.hypot(aliX, aliY) || 1;
      aliX = (aliX / m) * b.maxSpeed;
      aliY = (aliY / m) * b.maxSpeed;
      ax += (aliX - b.vx) * aw;
      ay += (aliY - b.vy) * aw;
    }
    if (nCoh > 0) {
      cohX = cohX / nCoh - b.x;
      cohY = cohY / nCoh - b.y;
      const m = Math.hypot(cohX, cohY) || 1;
      cohX = (cohX / m) * b.maxSpeed;
      cohY = (cohY / m) * b.maxSpeed;
      ax += (cohX - b.vx) * cw;
      ay += (cohY - b.vy) * cw;
    }

    // Phase forces
    if (phase === 'launch') {
      ay -= launchLift * 60 * dt;
    }
    // Center pull when outside central band (keeps flock visible)
    if (centerPull > 0) {
      ax += (cx - b.x) * centerPull;
      ay += (cy - b.y) * centerPull;
    }

    // Soft edge bounce, not wrap (birds do not teleport)
    if (b.x < edgeMargin && b.vx < 0) ax += edgeBounce;
    if (b.x > w - edgeMargin && b.vx > 0) ax -= edgeBounce;
    if (b.y < edgeMargin && b.vy < 0) ay += edgeBounce;
    if (b.y > h - edgeMargin && b.vy > 0) ay -= edgeBounce;

    // Clamp steering force
    const forceMag = Math.hypot(ax, ay);
    if (forceMag > maxForce) {
      ax = (ax / forceMag) * maxForce;
      ay = (ay / forceMag) * maxForce;
    }

    b.ax = ax;
    b.ay = ay;
  }

  // Integrate
  for (const b of boids) {
    b.vx += b.ax;
    b.vy += b.ay;
    b.vx *= friction;
    b.vy *= friction;
    const speed = Math.hypot(b.vx, b.vy);
    if (speed > b.maxSpeed) {
      b.vx = (b.vx / speed) * b.maxSpeed;
      b.vy = (b.vy / speed) * b.maxSpeed;
    }
    b.x += b.vx;
    b.y += b.vy;
    b.ax = 0;
    b.ay = 0;

    // Clamp position inside canvas so birds never leave permanently
    if (b.x < 2) b.x = 2;
    if (b.x > w - 2) b.x = w - 2;
    if (b.y < 2) b.y = 2;
    if (b.y > h - 2) b.y = h - 2;
  }
}
