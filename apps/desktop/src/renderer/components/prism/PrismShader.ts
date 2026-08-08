/**
 * PrismShader — GLSL sources + WebGL2 compile helpers.
 * Raw WebGL2, no library. Keeps highp so the starfield hash stays pinned.
 */

export const PRISM_VERTEX_GLSL = `#version 300 es
precision highp float;
in vec2 aPos;
in vec2 aUv;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

export const PRISM_FRAGMENT_GLSL = `#version 300 es
precision highp float;
// keep highp — fract(sin*43758.5453) diverges on mediump

in vec2 vUv;
out vec4 fragColor;

uniform vec3 uBg;
uniform vec3 uAnchor;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform float uTime;
uniform float uPhase;
uniform float uAudio;
uniform float uSpin;
uniform float uArch;
uniform float uLens;
uniform float uVariant; // 0 background (full-bleed), 1 hero (disc)

float h1(float x) { return fract(sin(x * 127.1) * 43758.5453); }

vec4 starfield(vec3 n, float t) {
  // Project sphere normal to a 2D UV for star noise, keep deterministic.
  vec2 uv = vec2(atan(n.y, n.x) * 0.15915494309 + 0.5, n.z * 0.5 + 0.5);
  // Low-frequency banding decorrelated by phase.
  float v1 = fract(uPhase * 2.17);
  float v2 = fract(uPhase * 5.31);
  float warped = t + 0.9 * sin(t * 0.09 + v1 * 6.28) + 0.5 * sin(t * 0.21 + v2 * 6.28);
  // Coarse spiral / flow modulation.
  float flow = sin(uv.x * 6.28318 + warped * 0.22) * 0.5 + 0.5;
  float band = sin(uv.y * 12.0 + warped * 0.15 + uPhase * 6.28) * 0.5 + 0.5;
  float neb = mix(flow, band, 0.55);
  // Star sparkle — cheap hash grid.
  vec2 g = fract(uv * 38.0);
  float cell = h1(dot(floor(uv * 38.0), vec2(12.9898, 78.233)));
  float tw = sin(warped * 1.5 + cell * 40.0) * 0.5 + 0.5;
  tw = pow(tw, 3.0);
  float star = step(0.985, cell + tw * 0.015) * tw;
  // Mix nebula colour from accent trio.
  vec3 colA = mix(uC0, uC1, fract(v1 * 1.7));
  vec3 colB = mix(uC1, uC2, fract(v2 * 1.3));
  vec3 nebCol = mix(colA, colB, neb) * (0.65 + 0.5 * neb);
  // Slight archetype tint: uArch -1 derives from phase.
  float archPick = uArch < -0.5 ? fract(uPhase * 4.91) * 3.0 : uArch;
  float archMix = clamp(archPick / 3.0, 0.0, 1.0);
  nebCol = mix(nebCol, nebCol * vec3(1.1, 0.9, 1.2), archMix * 0.35);
  float alpha = clamp(neb * 0.55 + star * 1.4, 0.0, 1.0);
  vec3 col = nebCol * alpha + vec3(star) * 0.9;
  return vec4(col, alpha);
}

vec4 sphereAt(vec3 n, float spin, float t) {
  float v1 = fract(uPhase * 2.17);
  float v2 = fract(uPhase * 5.31);
  float warpedTime = t + 0.9 * sin(t * 0.09) * v1 + 0.5 * sin(t * 0.21) * v2;
  // Yaw + subtle roll/tilt so it never feels like a flat disc.
  float ca = cos(spin);
  float sa = sin(spin);
  mat2 rotY = mat2(ca, -sa, sa, ca);
  vec3 p = n;
  p.xz = rotY * p.xz;
  float tilt = 0.18 * sin(warpedTime * 0.07 + uPhase);
  float ct = cos(tilt);
  float st = sin(tilt);
  mat2 rotX = mat2(ct, -st, st, ct);
  p.yz = rotX * p.yz;
  return starfield(p, warpedTime);
}

vec3 shade(vec2 p) {
  float r = length(p);
  float rr = min(r, 0.9995);
  float z = sqrt(max(0.0, 1.0 - rr * rr));
  vec3 n = vec3(p, z);
  float fresnel = pow(max(0.0, 1.0 - z), 2.4);
  vec3 ray = refract(vec3(0.0, 0.0, -1.0), n, 0.75);

  vec4 front = sphereAt(n, uSpin, uTime * 0.8 + uPhase * 2.0);
  // Back hemisphere: invert normal and offset spin for depth
  vec3 nb = vec3(-n.x, -n.y, -z);
  vec4 back = sphereAt(nb, -uSpin * 0.6, uTime * 0.55 + uPhase);

  vec3 voidCol = mix(uAnchor * 0.04, uAnchor * 0.35, fresnel);
  vec3 col = mix(voidCol, front.rgb, front.a * 0.85);
  col = mix(col, back.rgb * 0.45, back.a * 0.22 * fresnel);

  // Aurora / speech-like breathing
  float speech = sin(uTime * 0.4 + p.x * 2.0) * 0.5 + 0.5;
  float speech2 = sin(uTime * 1.1 + p.y * 3.0 + uPhase) * 0.5 + 0.5;
  float aur = speech * speech2;
  vec3 aurCol = mix(uC0, uC1, aur) * (0.12 + 0.18 * uAudio);
  col += aurCol * fresnel * (0.6 + 0.4 * aur);

  // Meteor / streak cadence
  float cad = 4.5 + 3.5 * fract(uPhase * 4.91);
  float meteorPhase = fract(uTime / cad);
  float meteor = exp(-pow((p.x - (meteorPhase * 2.0 - 1.0)) * 3.2, 2.0)) * exp(-pow(p.y * 1.8, 2.0));
  col += uC2 * meteor * 0.35 * uAudio;

  // Diffuse + voice tint
  float diff = max(0.0, dot(n, normalize(vec3(0.45, 0.7, 1.0))));
  vec3 voiceCol = mix(uC0, uC1, clamp(uAudio, 0.0, 1.0));
  col += voiceCol * diff * 0.10 * (0.5 + 0.5 * uAudio);

  // Rim lights
  col += uC2 * pow(fresnel, 2.0) * 0.22;
  col += uC0 * pow(fresnel, 4.0) * 0.10;

  // Faceted spikes — hero only, but cheap enough to keep gated by variant
  if (uVariant > 0.5) {
    float ang = atan(p.y, p.x);
    float spike = 0.0;
    for (int k = 0; k < 3; k++) {
      float a0 = float(k) * 2.09439510239;
      float dx = ang - a0;
      // wrap to -pi..pi
      dx = mod(dx + 3.14159265, 6.28318530) - 3.14159265;
      spike += exp(-dx * dx * 1200.0) * exp(-pow(r - 0.72, 2.0) * 26.0);
      spike += exp(-dx * dx * 320.0) * exp(-pow(r - 0.88, 2.0) * 42.0) * 0.5;
    }
    col += spike * 0.22 * mix(uC0, uC2, 0.5);
  }

  // Fold through background void at the edge for hero disc feathering is done
  // by the coverage alpha; background variant vignettes here.
  if (uVariant < 0.5) {
    float vig = smoothstep(1.25, 0.35, r);
    col = mix(uBg, col, vig);
  }

  return col;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  // Keep aspect correct: caller sets canvas to viewport, so no extra correction
  // is needed beyond the -1..1 mapping. If the canvas is non-square, the disc
  // still covers correctly because the viewport is the canvas.
  vec3 col;
  if (uLens > 0.001) {
    float off = uLens * 0.012;
    vec3 rCol = shade(p * (1.0 - off * 1.4));
    vec3 gCol = shade(p);
    vec3 bCol = shade(p * (1.0 + off * 1.0));
    col = vec3(rCol.r, gCol.g, bCol.b);
  } else {
    col = shade(p);
  }
  float coverage = 1.0;
  if (uVariant > 0.5) {
    coverage = 1.0 - smoothstep(0.988, 1.0, length(p));
    // Premultiplied output for hero disc compositing
    fragColor = vec4(col * coverage, coverage);
  } else {
    // Background: full-bleed opaque over #000 via uBg, coverage is 1
    // Still premultiplied so blending with page is correct at the blur edge.
    fragColor = vec4(col, 1.0);
  }
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown compile error';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

export function createProgram(
  gl: WebGL2RenderingContext,
  vsSource: string,
  fsSource: string,
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('createProgram failed');
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

export interface PrismUniforms {
  uBg: WebGLUniformLocation | null;
  uAnchor: WebGLUniformLocation | null;
  uC0: WebGLUniformLocation | null;
  uC1: WebGLUniformLocation | null;
  uC2: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  uPhase: WebGLUniformLocation | null;
  uAudio: WebGLUniformLocation | null;
  uSpin: WebGLUniformLocation | null;
  uArch: WebGLUniformLocation | null;
  uLens: WebGLUniformLocation | null;
  uVariant: WebGLUniformLocation | null;
}

export function getUniformLocations(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
): PrismUniforms {
  return {
    uBg: gl.getUniformLocation(program, 'uBg'),
    uAnchor: gl.getUniformLocation(program, 'uAnchor'),
    uC0: gl.getUniformLocation(program, 'uC0'),
    uC1: gl.getUniformLocation(program, 'uC1'),
    uC2: gl.getUniformLocation(program, 'uC2'),
    uTime: gl.getUniformLocation(program, 'uTime'),
    uPhase: gl.getUniformLocation(program, 'uPhase'),
    uAudio: gl.getUniformLocation(program, 'uAudio'),
    uSpin: gl.getUniformLocation(program, 'uSpin'),
    uArch: gl.getUniformLocation(program, 'uArch'),
    uLens: gl.getUniformLocation(program, 'uLens'),
    uVariant: gl.getUniformLocation(program, 'uVariant'),
  };
}

export function resizeCanvasToDisplaySize(
  canvas: HTMLCanvasElement,
  dpr: number,
  maxW: number,
  maxH: number,
): boolean {
  const rect = canvas.getBoundingClientRect();
  const w = Math.min(Math.max(1, Math.round(rect.width * dpr)), maxW);
  const h = Math.min(Math.max(1, Math.round(rect.height * dpr)), maxH);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}
