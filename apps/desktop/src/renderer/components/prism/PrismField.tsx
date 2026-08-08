/**
 * PrismField — the Prism brand's living surface. Raw WebGL2, no library.
 *
 * Two variants share one shader: `background` is a blurred full-bleed wash
 * behind the whole shell, `hero` is a raymarched black-glass prism turning
 * in the onboarding frame.
 * Any failure path (no WebGL2, shader refuses to compile, context lost, OS
 * reduced-motion) renders the same static gradient, so the brand still reads
 * on a machine that cannot run the shader.
 */

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion.js';
import { PrismMotion } from './PrismMotion.js';
import {
  PRISM_FRAGMENT_GLSL,
  PRISM_VERTEX_GLSL,
  createProgram,
  getUniformLocations,
  resizeCanvasToDisplaySize,
} from './PrismShader.js';

type Variant = 'background' | 'hero';

/** Above this the field is "hot": 60fps and chromatic refraction. Below, 30fps. */
const HOT_ENERGY = 0.25;
const FRAME_BUDGET_HOT_MS = 16;
const FRAME_BUDGET_IDLE_MS = 33;
const SEED_KEY = 'foundry:prismSeed';

/** Backing-store ceilings. The background is blurred to 18px, so it costs
 * nothing to render it well under native resolution. */
const MAX_PIXELS: Record<Variant, { w: number; h: number }> = {
  background: { w: 1024, h: 1024 },
  hero: { w: 1280, h: 1280 },
};

/**
 * One personality per install. The seed only ever feeds the shader, so
 * localStorage is the right home for it: it survives relaunches, it is
 * per-window-origin, and it never needs to reach main.
 */
function readSeed(): string {
  try {
    const stored = localStorage.getItem(SEED_KEY);
    if (stored) return stored;
    const generated = crypto.randomUUID();
    localStorage.setItem(SEED_KEY, generated);
    return generated;
  } catch {
    // Private mode or a wiped profile: a per-session personality is still
    // better than every install looking identical.
    return `prism-${Math.random().toString(36).slice(2)}`;
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const BG_COLOR: Record<Variant, string> = { background: '#05070a', hero: '#0b0f1e' };
const ANCHOR = '#0b0f1e';
const ACCENTS = ['#5ad2dd', '#7b5cff', '#b8f1ff'] as const;

function PrismCanvas({
  variant,
  energy,
  seed,
  onFail,
}: {
  variant: Variant;
  energy: number;
  seed: string;
  onFail: () => void;
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  // Energy changes every frame budget rather than every mount, so it rides a
  // ref: re-running the effect would drop the GL context and the spin state.
  const energyRef = useRef(energy);
  energyRef.current = energy;
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const gl = canvas.getContext('webgl2', {
      alpha: variant === 'hero',
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
    if (!gl) {
      onFailRef.current();
      return;
    }

    let program: WebGLProgram;
    try {
      program = createProgram(gl, PRISM_VERTEX_GLSL, PRISM_FRAGMENT_GLSL);
    } catch {
      onFailRef.current();
      return;
    }

    gl.useProgram(program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // One full-screen triangle strip, interleaved position and uv.
    const verts = new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;
    const aPos = gl.getAttribLocation(program, 'aPos');
    const aUv = gl.getAttribLocation(program, 'aUv');
    if (aPos >= 0) {
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, stride, 0);
    }
    if (aUv >= 0) {
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, stride, 2 * Float32Array.BYTES_PER_ELEMENT);
    }

    const motion = new PrismMotion(seed);
    const uniforms = getUniformLocations(gl, program);
    const bg = hexToRgb(BG_COLOR[variant]);
    const anchor = hexToRgb(ANCHOR);
    const [c0, c1, c2] = ACCENTS.map(hexToRgb) as [
      [number, number, number],
      [number, number, number],
      [number, number, number],
    ];

    if (uniforms.uBg) gl.uniform3f(uniforms.uBg, bg[0], bg[1], bg[2]);
    if (uniforms.uAnchor) gl.uniform3f(uniforms.uAnchor, anchor[0], anchor[1], anchor[2]);
    if (uniforms.uC0) gl.uniform3f(uniforms.uC0, c0[0], c0[1], c0[2]);
    if (uniforms.uC1) gl.uniform3f(uniforms.uC1, c1[0], c1[1], c1[2]);
    if (uniforms.uC2) gl.uniform3f(uniforms.uC2, c2[0], c2[1], c2[2]);
    if (uniforms.uPhase) gl.uniform1f(uniforms.uPhase, motion.phase);
    // Negative means "derive the archetype tint from the seed's phase".
    if (uniforms.uArch) gl.uniform1f(uniforms.uArch, -1);
    if (uniforms.uVariant) gl.uniform1f(uniforms.uVariant, variant === 'hero' ? 1 : 0);

    let raf = 0;
    let lastFrame = 0;
    let painted = false;
    let hidden = document.hidden;
    let onScreen = true;

    const onVisibility = (): void => {
      hidden = document.hidden;
    };
    document.addEventListener('visibilitychange', onVisibility);

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry) onScreen = entry.isIntersecting;
      },
      { threshold: 0 },
    );
    io.observe(wrap);

    // A lost context leaves the canvas blank forever unless something takes
    // over, so hand the whole field to the static fallback.
    const onContextLost = (e: Event): void => {
      e.preventDefault();
      onFailRef.current();
    };
    canvas.addEventListener('webglcontextlost', onContextLost);

    const { w: maxW, h: maxH } = MAX_PIXELS[variant];

    const tick = (now: number): void => {
      raf = requestAnimationFrame(tick);
      // Occluded or scrolled out: the callback still fires (the compositor may
      // keep serving it), but nothing is drawn and no time advances.
      if (hidden || !onScreen) return;
      const hot = energyRef.current > HOT_ENERGY;
      const budget = hot ? FRAME_BUDGET_HOT_MS : FRAME_BUDGET_IDLE_MS;
      if (now - lastFrame < budget) return;
      lastFrame = now;

      const t = now / 1000 + motion.timeOffset;
      motion.update(t, energyRef.current);

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (resizeCanvasToDisplaySize(canvas, dpr, maxW, maxH)) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        // The starfield fades grain/star detail in by resolution.
        if (uniforms.uRes) gl.uniform2f(uniforms.uRes, canvas.width, canvas.height);
      }
      if (uniforms.uTime) gl.uniform1f(uniforms.uTime, t);
      if (uniforms.uAudio) gl.uniform1f(uniforms.uAudio, motion.audioSmooth);
      if (uniforms.uSpin) gl.uniform1f(uniforms.uSpin, motion.spin);
      // Refraction is three shader evaluations per pixel, so it only runs hot.
      if (uniforms.uLens) gl.uniform1f(uniforms.uLens, hot ? 0.06 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      if (!painted) {
        painted = true;
        setReady(true);
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      io.disconnect();
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [variant, seed]);

  const cls =
    variant === 'hero' ? 'prism-hero' : `prism-field background ${ready ? 'ready' : ''}`.trim();
  return (
    <div ref={wrapRef} className={cls} aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  );
}

export default function PrismField({
  variant,
  energy = 0.12,
}: {
  variant: Variant;
  energy?: number;
}): React.JSX.Element {
  const reduced = useReducedMotion();
  const [seed] = useState(readSeed);
  const [failed, setFailed] = useState(false);

  if (reduced || failed) {
    return (
      <div className={variant === 'hero' ? 'prism-fallback hero' : 'prism-fallback'} aria-hidden />
    );
  }
  return (
    <PrismCanvas variant={variant} energy={energy} seed={seed} onFail={() => setFailed(true)} />
  );
}
