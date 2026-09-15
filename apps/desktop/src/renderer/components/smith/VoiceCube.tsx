import { useEffect, useRef } from 'react';
import styles from './SmithVoicePanel.module.css';

const CX = 140;
const CY = 104;
/** Cube half-edge in projection units; the silhouette spans 3.46 × 4 units. */
const SIZE = 47;
const COS30 = 0.8660254;
/** Fillet radius for the shell and the aperture, relative to the half-edge. */
const EDGE_R = 0.21;
const APERTURE_R = 0.36;
/** How far the mouth sits inside the right face (fraction toward the centroid). */
const APERTURE_INSET = 0.12;

type Pt = [number, number];
type Vertices = Pt[];

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
function project(x: number, y: number, z: number, scale: number): Pt {
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

/** The right face of the shell, in silhouette order around the opening. */
const FACE = [0, 1, 5, 4];

/** Convex polygon path with every vertex filleted to the given radius. */
function poly(pts: Pt[], radius: number): Path2D {
  const path = new Path2D();
  const count = pts.length;
  for (let i = 0; i < count; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + count) % count];
    const next = pts[(i + 1) % count];
    const lPrev = Math.hypot(prev[0] - p[0], prev[1] - p[1]) || 1;
    const lNext = Math.hypot(next[0] - p[0], next[1] - p[1]) || 1;
    const r = Math.min(radius, lPrev * 0.45, lNext * 0.45);
    const ax = p[0] + ((prev[0] - p[0]) / lPrev) * r;
    const ay = p[1] + ((prev[1] - p[1]) / lPrev) * r;
    const bx = p[0] + ((next[0] - p[0]) / lNext) * r;
    const by = p[1] + ((next[1] - p[1]) / lNext) * r;
    if (i === 0) path.moveTo(ax, ay);
    else path.lineTo(ax, ay);
    path.quadraticCurveTo(p[0], p[1], bx, by);
  }
  path.closePath();
  return path;
}

/** The face quad pulled toward its own centroid, leaving the metal frame around the mouth. */
function insetQuad(quad: Pt[], k: number): Pt[] {
  const c: Pt = [
    (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4,
    (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4,
  ];
  return quad.map((p) => [p[0] + (c[0] - p[0]) * k, p[1] + (c[1] - p[1]) * k]);
}

function drawCube(
  context: CanvasRenderingContext2D,
  phase: number,
  energy: number,
  active: boolean,
): void {
  context.clearRect(0, 0, 280, 210);
  const scale = SIZE * (1 + energy * 0.04);
  // Furnace heat: banked while connected, flaring with the speaker level, flickering like fire.
  const flicker = 0.92 + 0.08 * Math.sin(phase * 6.3) * Math.sin(phase * 2.7);
  const heat = active ? (0.5 + energy * 0.5) * flicker : 0.06;
  const v = CORNERS.map(([x, y, z]) => project(x, y, z, scale));
  const face = FACE.map((corner) => v[corner]);
  const aperture = insetQuad(face, APERTURE_INSET);

  ambientGlow(context, scale, energy, heat);
  contactShadow(context, scale);
  drawShell(context, v, scale);
  drawFrame(context, v, face, aperture, scale, heat);
  drawInterior(context, aperture, scale, heat);
  drawRim(context, face, aperture, scale, phase, heat, active);
  drawEdges(context, v, heat);
  drawGrain(context, v, aperture, scale);
}

/** Warm halo thrown onto the panel behind the cube while the furnace is lit. */
function ambientGlow(
  context: CanvasRenderingContext2D,
  scale: number,
  energy: number,
  heat: number,
): void {
  if (heat < 0.02) return;
  const halo = context.createRadialGradient(
    CX + 0.5 * scale,
    CY,
    6,
    CX + 0.5 * scale,
    CY,
    135 + energy * 50,
  );
  halo.addColorStop(0, `rgba(255, 124, 8, ${0.09 * heat})`);
  halo.addColorStop(0.6, `rgba(255, 110, 0, ${0.04 * heat})`);
  halo.addColorStop(1, 'rgba(255, 110, 0, 0)');
  context.fillStyle = halo;
  context.fillRect(0, 0, 280, 210);
}

/** Soft elliptical contact shadow under the cube. */
function contactShadow(context: CanvasRenderingContext2D, scale: number): void {
  context.save();
  context.translate(CX, CY + 2.06 * scale);
  context.scale(1, 0.38);
  const shadow = context.createRadialGradient(0, 0, 4, 0, 0, 1.6 * scale);
  shadow.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
  shadow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  context.fillStyle = shadow;
  context.fillRect(-1.8 * scale, -1.8 * scale, 3.6 * scale, 3.6 * scale);
  context.restore();
}

/**
 * A soft light band hugging one edge of a clipped face — the highlight a
 * rounded fillet throws when the key light rakes across it. The gradient is
 * confined to a strip offset inward from the edge so it reads as roll-off.
 */
function sheen(
  context: CanvasRenderingContext2D,
  clip: Path2D,
  a: Pt,
  b: Pt,
  toward: Pt,
  alpha: number,
  scale: number,
): void {
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const dx = toward[0] - mid[0];
  const dy = toward[1] - mid[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = (dx / len) * 0.42 * scale;
  const ny = (dy / len) * 0.42 * scale;
  const gradient = context.createLinearGradient(mid[0], mid[1], mid[0] + nx, mid[1] + ny);
  gradient.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
  const band = new Path2D();
  band.moveTo(a[0], a[1]);
  band.lineTo(b[0], b[1]);
  band.lineTo(b[0] + nx, b[1] + ny);
  band.lineTo(a[0] + nx, a[1] + ny);
  band.closePath();
  context.save();
  context.clip(clip);
  context.fillStyle = gradient;
  context.fill(band);
  context.restore();
}

/** A single silhouette or ridge edge, stroked with a linear intensity ramp. */
function edgeLine(
  context: CanvasRenderingContext2D,
  a: Pt,
  b: Pt,
  width: number,
  stops: [number, string][],
): void {
  const gradient = context.createLinearGradient(a[0], a[1], b[0], b[1]);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  context.strokeStyle = gradient;
  context.lineWidth = width;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(a[0], a[1]);
  context.lineTo(b[0], b[1]);
  context.stroke();
}

/** The anodized shell: lit graphite top, charcoal left, the open face deferred to drawFrame. */
function drawShell(context: CanvasRenderingContext2D, v: Vertices, scale: number): void {
  // Dark base under every face — reads as the shadowed gaps between beveled panels.
  context.fillStyle = '#0b0c0f';
  context.fill(poly([v[3], v[1], v[5], v[4], v[6], v[2]], scale * EDGE_R));

  const top = poly([v[0], v[1], v[3], v[2]], scale * EDGE_R);
  const topGradient = context.createLinearGradient(
    v[3][0] - 0.4 * scale,
    v[3][1] - 0.4 * scale,
    v[0][0] + 0.5 * scale,
    v[0][1] + 0.6 * scale,
  );
  topGradient.addColorStop(0, '#666b72');
  topGradient.addColorStop(0.4, '#3d4147');
  topGradient.addColorStop(1, '#1b1d21');
  context.fillStyle = topGradient;
  context.fill(top);
  sheen(context, top, v[3], v[2], v[0], 0.22, scale);
  sheen(context, top, v[3], v[1], v[0], 0.12, scale);
  // Broad soft specular pooling toward the lit corner.
  const pooling = context.createRadialGradient(
    v[3][0] - 0.35 * scale,
    v[3][1] + 0.15 * scale,
    2,
    v[3][0] - 0.35 * scale,
    v[3][1] + 0.15 * scale,
    2.4 * scale,
  );
  pooling.addColorStop(0, 'rgba(255, 255, 255, 0.1)');
  pooling.addColorStop(1, 'rgba(255, 255, 255, 0)');
  context.save();
  context.clip(top);
  context.fillStyle = pooling;
  context.fillRect(v[3][0] - 2.8 * scale, v[3][1] - 2.8 * scale, 5.6 * scale, 5.6 * scale);
  context.restore();

  const left = poly([v[0], v[2], v[6], v[4]], scale * EDGE_R);
  const leftGradient = context.createLinearGradient(v[2][0], v[2][1], v[4][0], v[4][1]);
  leftGradient.addColorStop(0, '#24262b');
  leftGradient.addColorStop(0.55, '#17181c');
  leftGradient.addColorStop(1, '#0e0f12');
  context.fillStyle = leftGradient;
  context.fill(left);
  sheen(context, left, v[2], v[0], v[6], 0.1, scale);
}

/** The open face: metal frame, light spilling on it, and the dark recess inside the mouth. */
function drawFrame(
  context: CanvasRenderingContext2D,
  v: Vertices,
  face: Pt[],
  aperture: Pt[],
  scale: number,
  heat: number,
): void {
  const framePath = poly(face, scale * EDGE_R);
  const gradient = context.createLinearGradient(v[1][0], v[1][1], v[4][0], v[4][1]);
  gradient.addColorStop(0, '#222429');
  gradient.addColorStop(0.5, '#15171b');
  gradient.addColorStop(1, '#0d0e11');
  context.fillStyle = gradient;
  context.fill(framePath);

  const cx = (aperture[0][0] + aperture[1][0] + aperture[2][0] + aperture[3][0]) / 4;
  const cy = (aperture[0][1] + aperture[1][1] + aperture[2][1] + aperture[3][1]) / 4;
  context.save();
  context.clip(framePath);
  const spill = context.createRadialGradient(cx, cy, 2, cx, cy, 1.7 * scale);
  spill.addColorStop(0, `rgba(255, 128, 10, ${0.36 * heat})`);
  spill.addColorStop(0.55, `rgba(255, 110, 0, ${0.13 * heat})`);
  spill.addColorStop(1, 'rgba(255, 110, 0, 0)');
  context.fillStyle = spill;
  context.fillRect(cx - 2 * scale, cy - 2 * scale, 4 * scale, 4 * scale);
  context.restore();

  // Furnace bounce washing the shell around the mouth's lower-left.
  const bounce = context.createRadialGradient(
    aperture[0][0],
    aperture[0][1] + 0.4 * scale,
    2,
    aperture[0][0],
    aperture[0][1] + 0.4 * scale,
    1.8 * scale,
  );
  bounce.addColorStop(0, `rgba(255, 130, 16, ${0.14 * heat})`);
  bounce.addColorStop(1, 'rgba(255, 130, 16, 0)');
  context.fillStyle = bounce;
  context.fillRect(0, 0, 280, 210);

  const mouth = poly(aperture, scale * APERTURE_R);
  const recess = context.createLinearGradient(
    aperture[1][0],
    aperture[1][1],
    aperture[3][0],
    aperture[3][1],
  );
  recess.addColorStop(0, '#150a04');
  recess.addColorStop(1, '#050302');
  context.fillStyle = recess;
  context.fill(mouth);

  // Ambient occlusion where the frame's lip overhangs the cavity.
  context.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  context.lineWidth = 3;
  context.stroke(mouth);
}

/** Seen through the mouth: the inner back wall above the crease, the molten floor below. */
function drawInterior(
  context: CanvasRenderingContext2D,
  aperture: Pt[],
  scale: number,
  heat: number,
): void {
  const [left, top, right, bottom] = aperture;
  context.save();
  context.clip(poly(aperture, scale * APERTURE_R));

  const crease: Pt = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
  const wall = context.createLinearGradient(top[0], top[1], crease[0], crease[1]);
  wall.addColorStop(0, `rgba(44, 14, 2, ${0.96 * heat})`);
  wall.addColorStop(0.55, `rgba(108, 38, 0, ${0.92 * heat})`);
  wall.addColorStop(1, `rgba(196, 76, 2, ${0.95 * heat})`);
  context.fillStyle = wall;
  fillTri(context, left, top, right);

  const floor = context.createLinearGradient(left[0], bottom[1], right[0], right[1]);
  floor.addColorStop(0, `rgba(255, 220, 124, ${heat})`);
  floor.addColorStop(0.55, `rgba(255, 166, 32, ${0.96 * heat})`);
  floor.addColorStop(1, `rgba(240, 96, 0, ${0.96 * heat})`);
  context.fillStyle = floor;
  fillTri(context, left, right, bottom);

  // White-hot core where the floor meets the crease, blooming additively.
  const core: Pt = [
    (left[0] * 3 + bottom[0] + right[0]) / 5,
    (left[1] * 3 + bottom[1] + right[1]) / 5,
  ];
  const glow = context.createRadialGradient(core[0], core[1], 1, core[0], core[1], 0.45 * scale);
  glow.addColorStop(0, `rgba(255, 232, 168, ${0.34 * heat})`);
  glow.addColorStop(0.5, `rgba(255, 140, 0, ${0.15 * heat})`);
  glow.addColorStop(1, 'rgba(255, 140, 0, 0)');
  context.globalCompositeOperation = 'lighter';
  context.fillStyle = glow;
  context.fillRect(core[0] - 1.2 * scale, core[1] - 1.2 * scale, 2.4 * scale, 2.4 * scale);
  context.globalCompositeOperation = 'source-over';

  // The frame's lip casts its shadow onto the back wall.
  const lipShadow = context.createLinearGradient(top[0], top[1], crease[0], crease[1]);
  lipShadow.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
  lipShadow.addColorStop(0.5, 'rgba(0, 0, 0, 0)');
  context.fillStyle = lipShadow;
  context.fillRect(
    Math.min(...aperture.map((p) => p[0])),
    Math.min(...aperture.map((p) => p[1])),
    Math.max(...aperture.map((p) => p[0])) - Math.min(...aperture.map((p) => p[0])),
    Math.max(...aperture.map((p) => p[1])) - Math.min(...aperture.map((p) => p[1])),
  );

  // The seam where the glowing floor meets the back wall.
  edgeLine(context, left, right, 1.8, [
    [0, `rgba(255, 200, 108, ${Math.min(1, 0.4 + 0.6 * heat)})`],
    [1, `rgba(255, 124, 8, ${0.6 * heat})`],
  ]);
  edgeLine(context, left, right, 6, [
    [0, `rgba(255, 150, 30, ${0.22 * heat})`],
    [1, `rgba(255, 120, 10, ${0.1 * heat})`],
  ]);
  context.restore();
}

/** The emissive lip of the mouth: molten along the lower-left, cooling to ember up top. */
function drawRim(
  context: CanvasRenderingContext2D,
  face: Pt[],
  aperture: Pt[],
  scale: number,
  phase: number,
  heat: number,
  active: boolean,
): void {
  const [left, top, , bottom] = aperture;
  const mouth = poly(aperture, scale * APERTURE_R);
  const shimmer = 0.85 + 0.15 * Math.sin(phase * 4);
  const rim = context.createLinearGradient(
    (left[0] + bottom[0]) / 2,
    (left[1] + bottom[1]) / 2,
    top[0],
    top[1],
  );
  rim.addColorStop(0, `rgba(255, 208, 122, ${Math.min(1, (0.6 + 0.4 * heat) * shimmer)})`);
  rim.addColorStop(0.45, `rgba(255, 146, 24, ${0.94 * heat})`);
  rim.addColorStop(1, `rgba(130, 52, 5, ${0.85 * heat})`);

  // Bloom stays on the frame: clip to the shell ring outside the mouth.
  const ring = new Path2D();
  ring.addPath(poly(face, scale * EDGE_R));
  ring.addPath(mouth);
  context.save();
  context.clip(ring, 'evenodd');
  context.shadowColor = `rgba(255, 140, 10, ${0.85 * heat})`;
  context.shadowBlur = 14 * heat + 2;
  context.strokeStyle = rim;
  context.lineWidth = 2.6;
  context.stroke(mouth);
  context.restore();

  context.save();
  context.clip(ring, 'evenodd');
  context.strokeStyle = `rgba(255, 130, 0, ${0.28 * heat})`;
  context.lineWidth = 10;
  context.stroke(mouth);
  context.restore();

  // The crisp molten lip itself.
  context.strokeStyle = rim;
  context.lineWidth = 2.4;
  context.stroke(mouth);
  if (!active) {
    context.strokeStyle = 'rgba(170, 170, 178, 0.28)';
    context.lineWidth = 1.3;
    context.stroke(mouth);
  }
}

/** Rake-light rims on the shell fillets; warm bounce on the silhouette near the furnace. */
function drawEdges(context: CanvasRenderingContext2D, v: Vertices, heat: number): void {
  const rim = 'rgba(255, 255, 255, ';
  edgeLine(context, v[3], v[2], 1.5, [
    [0, `${rim}0.65)`],
    [1, `${rim}0.25)`],
  ]);
  edgeLine(context, v[3], v[1], 1.5, [
    [0, `${rim}0.55)`],
    [1, `${rim}0.18)`],
  ]);
  edgeLine(context, v[2], v[0], 1.3, [
    [0, `${rim}0.5)`],
    [1, `${rim}0.15)`],
  ]);
  edgeLine(context, v[0], v[4], 1.4, [
    [0, `${rim}0.5)`],
    [1, `${rim}0.14)`],
  ]);
  edgeLine(context, v[0], v[1], 1.1, [
    [0, `${rim}0.2)`],
    [1, `${rim}0.06)`],
  ]);
  edgeLine(context, v[2], v[6], 1.2, [
    [0, `${rim}0.3)`],
    [1, `${rim}0.08)`],
  ]);
  edgeLine(context, v[6], v[4], 1.2, [
    [0, `${rim}0.14)`],
    [1, `${rim}0.05)`],
  ]);
  edgeLine(context, v[1], v[5], 1.2, [
    [0, `${rim}0.16)`],
    [1, `${rim}0.08)`],
  ]);
  edgeLine(context, v[4], v[5], 1.2, [
    [0, `rgba(255, 140, 30, ${0.28 * heat})`],
    [1, `${rim}0.05)`],
  ]);
}

function fillTri(context: CanvasRenderingContext2D, a: Pt, b: Pt, c: Pt): void {
  context.beginPath();
  context.moveTo(a[0], a[1]);
  context.lineTo(b[0], b[1]);
  context.lineTo(c[0], c[1]);
  context.closePath();
  context.fill();
}

let noiseTile: HTMLCanvasElement | null = null;

/** Shared 96px grayscale noise tile for the brushed-metal grain. */
function grainTile(): HTMLCanvasElement | null {
  if (noiseTile) return noiseTile;
  const tile = document.createElement('canvas');
  tile.width = 96;
  tile.height = 96;
  const pen = tile.getContext('2d');
  if (!pen) return null;
  const image = pen.createImageData(96, 96);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 128 + (Math.random() - 0.5) * 44;
    image.data[i] = value;
    image.data[i + 1] = value;
    image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  pen.putImageData(image, 0, 0);
  noiseTile = tile;
  return tile;
}

/** Fine anodized grain over the metal only — the mouth stays clean glass-hot. */
function drawGrain(
  context: CanvasRenderingContext2D,
  v: Vertices,
  aperture: Pt[],
  scale: number,
): void {
  const tile = grainTile();
  if (!tile) return;
  const pattern = context.createPattern(tile, 'repeat');
  if (!pattern) return;
  const shell = new Path2D();
  shell.addPath(poly([v[3], v[1], v[5], v[4], v[6], v[2]], scale * EDGE_R));
  shell.addPath(poly(aperture, scale * APERTURE_R));
  context.save();
  context.clip(shell, 'evenodd');
  context.globalCompositeOperation = 'overlay';
  context.globalAlpha = 0.5;
  context.fillStyle = pattern;
  context.fillRect(0, 0, 280, 210);
  context.restore();
}
