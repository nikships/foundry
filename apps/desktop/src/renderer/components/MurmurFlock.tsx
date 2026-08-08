/**
 * MurmurFlock — the Murmur brand's living surface: a starling murmuration in
 * Canvas2D, sized to whatever element contains it.
 *
 * The flock runs a fixed arc (launch, gather, disperse, drift) and then stays
 * in drift indefinitely, disturbed by an occasional gust. Physics lives in
 * MurmurFlock.boids.ts; this file owns the canvas, the lifecycle, and the ink.
 */

import { useEffect, useRef } from 'react';
import { useReducedMotion } from '../hooks/useReducedMotion.js';
import {
  createBoids,
  tickBoids,
  type Boid,
  type FlockPhase,
  MURMUR_FLOCK,
} from './MurmurFlock.boids.js';

/** Phase boundaries in seconds since mount. Past the last one it is drift forever. */
const PHASE_AT = { flock: 1.8, disperse: 4.5, drift: 7 } as const;
const GUST_MIN_MS = 7000;
const GUST_SPREAD_MS = 5000;
const GUST_DURATION_MS = 600;
const GUST_MAGNITUDE = 0.06;
/** Above this the flock is costing more than a frame and sheds birds. */
const SLOW_FRAME_MS = 20;
const SLOW_FRAMES_BEFORE_SHEDDING = 12;

const INK_LEAD = 'rgba(255, 122, 61, 0.76)';
const INK_CLAY = 'rgba(201, 122, 90, 0.74)';
const INK_CREAM = 'rgba(255, 248, 235, 0.82)';
/** Birds are tinted by their own top speed, so the fast ones read as leaders. */
const LEAD_SPEED = 2.28;
const CLAY_SPEED = 2.1;

function phaseAt(elapsedSeconds: number): FlockPhase {
  if (elapsedSeconds < PHASE_AT.flock) return 'launch';
  if (elapsedSeconds < PHASE_AT.disperse) return 'flock';
  if (elapsedSeconds < PHASE_AT.drift) return 'disperse';
  return 'drift';
}

export interface MurmurFlockProps {
  count?: number;
  className?: string;
}

export default function MurmurFlock({
  count = MURMUR_FLOCK.defaultCount,
  className,
}: MurmurFlockProps): React.JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 1;
    let height = 1;
    let boids: Boid[] = [];

    const resize = (): void => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = container.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      // Draw in CSS pixels and let the transform handle the backing store, so
      // the sprite geometry below never has to know about DPR.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    boids = createBoids(count, width, height);

    const ro = new ResizeObserver(resize);
    ro.observe(container);

    let raf: number | null = null;
    let frozen = document.hidden;
    let offScreen = false;
    let lastTime = performance.now();
    const startedAt = performance.now();
    let slowFrames = 0;
    let gustUntil = 0;
    let nextGustAt = performance.now() + GUST_MIN_MS + Math.random() * GUST_SPREAD_MS;
    let gust = { x: 0, y: 0 };

    const draw = (): void => {
      ctx.clearRect(0, 0, width, height);
      ctx.shadowColor = 'rgba(43, 30, 20, 0.22)';
      ctx.shadowBlur = 4;
      for (const b of boids) {
        ctx.save();
        ctx.translate(b.x, b.y);
        // Sprites point along +x at zero rotation, so the nose is drawn up and
        // the whole shape turned a quarter turn into the direction of travel.
        ctx.rotate(Math.atan2(b.vy, b.vx) + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(0, -4);
        ctx.lineTo(-2.2, 3);
        ctx.lineTo(2.2, 3);
        ctx.closePath();
        ctx.fillStyle =
          b.maxSpeed > LEAD_SPEED ? INK_LEAD : b.maxSpeed > CLAY_SPEED ? INK_CLAY : INK_CREAM;
        ctx.fill();
        ctx.restore();
      }
    };

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      if (frozen || offScreen) {
        // Hold the clock so an unhidden window does not resume with a huge dt.
        lastTime = now;
        return;
      }

      const dt = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;
      const phase = phaseAt((now - startedAt) / 1000);

      if (phase === 'drift') {
        if (now >= nextGustAt) {
          const angle = Math.random() * Math.PI * 2;
          gust = { x: Math.cos(angle) * GUST_MAGNITUDE, y: Math.sin(angle) * GUST_MAGNITUDE };
          gustUntil = now + GUST_DURATION_MS;
          nextGustAt = now + GUST_MIN_MS + Math.random() * GUST_SPREAD_MS;
        }
        if (now < gustUntil) {
          for (const b of boids) {
            b.vx += gust.x;
            b.vy += gust.y;
          }
        }
      }

      // Boid steering is O(n^2). On a machine that cannot hold the frame, shed
      // birds once rather than degrading every frame from here on.
      if (dt * 1000 > SLOW_FRAME_MS) slowFrames += 1;
      else slowFrames = 0;
      if (slowFrames >= SLOW_FRAMES_BEFORE_SHEDDING && boids.length > MURMUR_FLOCK.minCount) {
        boids = boids.slice(0, MURMUR_FLOCK.minCount);
        slowFrames = 0;
      }

      tickBoids(boids, width, height, phase, dt || 1 / 60);
      draw();
    };

    const onVisibility = (): void => {
      frozen = document.hidden;
    };
    document.addEventListener('visibilitychange', onVisibility);

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry) offScreen = !entry.isIntersecting;
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    raf = requestAnimationFrame(frame);

    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [count, reduced]);

  // Reduced motion gets no flock at all: a frozen snapshot of a murmuration
  // reads as a smudge, and the frame behind it already carries the brand.
  if (reduced) return null;

  return (
    <canvas ref={canvasRef} className={`murmur-flock ${className ?? ''}`.trim()} aria-hidden />
  );
}
