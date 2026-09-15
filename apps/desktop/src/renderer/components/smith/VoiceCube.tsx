import { useEffect, useRef } from 'react';
import styles from './SmithVoicePanel.module.css';

const CX = 140;
const CY = 104;
/** Cube half-edge in projection units; the silhouette spans 3.46 × 4 units. */
const SIZE = 40;
const COS30 = 0.8660254;

/** A sampled speaker signal stokes the furnace inside an open metal cube; no React updates per frame. */
export function VoiceCube({
  active,
  speaking,
  readLevel,
}: {
  active: boolean;
  speaking: boolean;
  readLevel: () => number;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = 280 * ratio;
    canvas.height = 210 * ratio;
    context.scale(ratio, ratio);
    let frame = 0;
    let energy = 0;
    let phase = 0;
    let last = 0;
    const render = (now: number): void => {
      const delta = Math.min((now - last) / 1000, 0.05);
      last = now;
      energy += (readLevel() - energy) * 0.18;
      if (!motion.matches) phase += delta * (speaking ? 1.4 : 0.35);
      drawCube(context, phase, motion.matches ? 0 : energy, active);
      if (active && !document.hidden && !motion.matches) frame = requestAnimationFrame(render);
    };
    const restart = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(render);
    };
    restart();
    document.addEventListener('visibilitychange', restart);
    motion.addEventListener('change', restart);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', restart);
      motion.removeEventListener('change', restart);
    };
  }, [active, speaking, readLevel]);
  return <canvas ref={canvasRef} className={styles.cube} aria-hidden="true" />;
}

/** Isometric projection of a unit-cube coordinate into the 280 × 210 canvas. */
function project(x: number, y: number, z: number, scale: number): [number, number] {
  return [CX + (x - z) * COS30 * scale, CY + (-y + (x + z) * 0.5) * scale];
}

/**
 * Corner order: 0 near, 1 upper-right, 2 upper-left, 3 top, 4 bottom,
 * 5 lower-right, 6 lower-left, 7 far (shares the canvas center with 0).
 */
const CORNERS: [number, number, number][] = [
  [1, 1, 1],
  [1, 1, -1],
  [-1, 1, 1],
  [-1, 1, -1],
  [1, -1, 1],
  [1, -1, -1],
  [-1, -1, 1],
  [-1, -1, -1],
];

type Vertices = [number, number][];

/** The right side of the cube is not a face with a window — it is entirely open. */
const OPENING = [0, 1, 5, 4];

function drawCube(
  context: CanvasRenderingContext2D,
  phase: number,
  energy: number,
  active: boolean,
): void {
  context.clearRect(0, 0, 280, 210);
  const scale = SIZE * (1 + energy * 0.04);
  // Furnace heat: banked while connected, flaring with the speaker level, flickering like fire.
  const flicker = 0.9 + 0.1 * Math.sin(phase * 6.3) * Math.sin(phase * 2.7);
  const heat = active ? (0.42 + energy * 0.58) * flicker : 0.07;
  const v = CORNERS.map(([x, y, z]) => project(x, y, z, scale));

  const spill = context.createRadialGradient(CX, CY, 10, CX, CY, 100 + energy * 45);
  spill.addColorStop(0, `rgba(255, 133, 0, ${0.11 * heat})`);
  spill.addColorStop(1, 'rgba(255, 133, 0, 0)');
  context.fillStyle = spill;
  context.fillRect(0, 0, 280, 210);

  const shadow = context.createRadialGradient(
    CX,
    CY + 2.1 * scale,
    4,
    CX,
    CY + 2.1 * scale,
    1.5 * scale,
  );
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.32)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = shadow;
  context.fillRect(CX - 1.6 * scale, CY + 0.5 * scale, 3.2 * scale, 1.7 * scale);

  drawShell(context, v, scale);
  drawCavity(context, v, scale, phase, energy, heat, active);
  drawRidges(context, v);
}

/** The solid anodized shell: graphite top and charcoal left face. The right side stays open. */
function drawShell(context: CanvasRenderingContext2D, v: Vertices, scale: number): void {
  const faces: {
    path: number[];
    from: [number, number];
    to: [number, number];
    colors: [string, string];
  }[] = [
    {
      path: [0, 1, 3, 2],
      from: [CX, CY - 2 * scale],
      to: [CX, CY + 0.3 * scale],
      colors: ['#383b41', '#232528'],
    },
    {
      path: [0, 2, 6, 4],
      from: [CX - 1.6 * scale, CY - scale],
      to: [CX - 0.2 * scale, CY + 1.8 * scale],
      colors: ['#1e2024', '#141518'],
    },
  ];
  for (const face of faces) {
    const gradient = context.createLinearGradient(
      face.from[0],
      face.from[1],
      face.to[0],
      face.to[1],
    );
    gradient.addColorStop(0, face.colors[0]);
    gradient.addColorStop(1, face.colors[1]);
    context.fillStyle = gradient;
    context.beginPath();
    face.path.forEach((corner, index) => {
      if (index === 0) context.moveTo(v[corner][0], v[corner][1]);
      else context.lineTo(v[corner][0], v[corner][1]);
    });
    context.closePath();
    context.fill();
  }
}

/** Specular rim on the top outer ridges; dark falloff on the remaining silhouette. */
function drawRidges(context: CanvasRenderingContext2D, v: Vertices): void {
  const strokes: { edges: [number, number][]; width: number; color: string }[] = [
    {
      edges: [
        [3, 1],
        [3, 2],
      ],
      width: 1,
      color: 'rgba(255, 255, 255, 0.2)',
    },
    { edges: [[0, 2]], width: 0.8, color: 'rgba(255, 255, 255, 0.09)' },
    { edges: [[2, 6]], width: 1, color: 'rgba(0, 0, 0, 0.35)' },
    { edges: [[6, 4]], width: 1, color: 'rgba(0, 0, 0, 0.5)' },
  ];
  for (const { edges, width, color } of strokes) {
    context.lineWidth = width;
    context.strokeStyle = color;
    context.beginPath();
    for (const [from, to] of edges) {
      context.moveTo(v[from][0], v[from][1]);
      context.lineTo(v[to][0], v[to][1]);
    }
    context.stroke();
  }
}

function openingPath(context: CanvasRenderingContext2D, v: Vertices): void {
  context.beginPath();
  OPENING.forEach((corner, index) => {
    if (index === 0) context.moveTo(v[corner][0], v[corner][1]);
    else context.lineTo(v[corner][0], v[corner][1]);
  });
  context.closePath();
}

/** The open chamber: hollow interior, molten floor and wall, neon lip on the cube's own edges. */
function drawCavity(
  context: CanvasRenderingContext2D,
  v: Vertices,
  scale: number,
  phase: number,
  energy: number,
  heat: number,
  active: boolean,
): void {
  openingPath(context, v);
  context.fillStyle = '#08090b';
  context.fill();

  context.save();
  openingPath(context, v);
  context.clip();
  drawInterior(context, v, scale, heat);
  context.restore();

  // Chamfered shell thickness around the opening, brightest toward the key light.
  const chamfer = context.createLinearGradient(v[3][0], v[3][1], v[4][0], v[4][1]);
  chamfer.addColorStop(0, '#3a3d44');
  chamfer.addColorStop(1, '#1a1b1f');
  openingPath(context, v);
  context.lineWidth = 3.5;
  context.strokeStyle = chamfer;
  context.stroke();

  // Light spilling out of the chamber.
  const ox = (v[0][0] + v[1][0] + v[5][0] + v[4][0]) / 4;
  const oy = (v[0][1] + v[1][1] + v[5][1] + v[4][1]) / 4;
  const cast = context.createRadialGradient(ox, oy, 4, ox, oy, (1.1 + energy * 0.6) * scale);
  cast.addColorStop(0, `rgba(255, 133, 0, ${0.22 * heat})`);
  cast.addColorStop(1, 'rgba(255, 133, 0, 0)');
  context.fillStyle = cast;
  context.fillRect(ox - 1.8 * scale, oy - 1.8 * scale, 3.6 * scale, 3.6 * scale);

  // Neon lip: orange and blooming while the furnace is lit, cold grey otherwise.
  const shimmer = 0.85 + 0.15 * Math.sin(phase * 4);
  openingPath(context, v);
  context.lineWidth = 6;
  context.strokeStyle = `rgba(255, 133, 0, ${active ? 0.2 * heat : 0})`;
  context.stroke();
  openingPath(context, v);
  context.lineWidth = 1.7;
  context.strokeStyle = active
    ? `rgba(255, 133, 0, ${(0.45 + 0.55 * heat) * shimmer})`
    : 'rgba(163, 151, 140, 0.35)';
  context.stroke();
}

/**
 * Seen through the open face: the inner back wall (z = -1) above and the inner
 * floor (y = -1) below, meeting at the crease from the deep corner to lower-right.
 */
function drawInterior(
  context: CanvasRenderingContext2D,
  v: Vertices,
  scale: number,
  heat: number,
): void {
  const deep = v[7];

  const wall = context.createLinearGradient(
    deep[0],
    deep[1],
    (v[1][0] + v[5][0]) / 2,
    (v[1][1] + v[5][1]) / 2,
  );
  wall.addColorStop(0, `rgba(255, 170, 17, ${0.05 + 0.85 * heat})`);
  wall.addColorStop(0.55, `rgba(230, 74, 0, ${0.8 * heat})`);
  wall.addColorStop(1, 'rgba(74, 20, 0, 0.95)');
  context.fillStyle = wall;
  fillQuad(context, [v[3], v[1], v[5], v[7]]);

  const floor = context.createLinearGradient(
    deep[0],
    deep[1],
    (v[4][0] + v[6][0]) / 2,
    (v[4][1] + v[6][1]) / 2,
  );
  floor.addColorStop(0, `rgba(255, 106, 10, ${0.85 * heat})`);
  floor.addColorStop(1, 'rgba(64, 18, 0, 0.95)');
  context.fillStyle = floor;
  fillQuad(context, [v[4], v[5], v[7], v[6]]);

  const core = context.createRadialGradient(deep[0], deep[1], 1, deep[0], deep[1], 1.1 * scale);
  core.addColorStop(0, `rgba(255, 205, 100, ${0.75 * heat})`);
  core.addColorStop(0.4, `rgba(255, 133, 0, ${0.35 * heat})`);
  core.addColorStop(1, 'rgba(255, 133, 0, 0)');
  context.fillStyle = core;
  context.fillRect(deep[0] - 1.2 * scale, deep[1] - 1.2 * scale, 2.4 * scale, 2.4 * scale);
}

function fillQuad(context: CanvasRenderingContext2D, points: [number, number][]): void {
  context.beginPath();
  context.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index++)
    context.lineTo(points[index][0], points[index][1]);
  context.closePath();
  context.fill();
}
