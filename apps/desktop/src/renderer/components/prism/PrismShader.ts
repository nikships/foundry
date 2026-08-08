/**
 * PrismShader — GLSL sources + WebGL2 compile helpers.
 * Raw WebGL2, no library. Keeps highp so the starfield hash stays pinned.
 *
 * starfield / sphereAt / shade are a verbatim ES3 port of the reference
 * renderer (xai-voice-clone orb-renderer.ts) — numerically pinned, do not
 * "simplify". The hero prism reuses that exact stack and only swaps the
 * geometry: a raymarched black-glass prism — apex at the top, three razor
 * edges down to a triangular base — with the galaxy sampled on a virtual
 * inner sphere, lit by the reference's moving light rig.
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

uniform vec2 uRes;
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
uniform float uVariant; // 0 background (full-bleed wash), 1 hero (raymarched prism)

float h1(float x) { return fract(sin(x * 127.1) * 43758.5453); }

vec4 starfield(vec3 n, float t) {
  float lon = atan(n.z, n.x);
  float lat = asin(clamp(n.y, -1.0, 1.0));
  float v1 = fract(uPhase * 7.13);
  float v2 = fract(uPhase * 3.71);
  float v3 = fract(uPhase * 5.37);
  float at = uArch >= 0.0 ? uArch : floor(fract(uPhase * 9.73) * 4.0);
  float isNeb = step(0.5, at) * (1.0 - step(1.5, at));
  float isCore = step(1.5, at) * (1.0 - step(2.5, at));
  float isDeep = step(2.5, at);

  float gb = lat + (0.15 + 0.4 * v1) * sin(lon * (1.0 + floor(v2 * 2.0)) + 1.3)
    + 0.12 * sin(lon * 3.0 + t * 0.1);
  float band = exp(-gb * gb * (5.0 + 10.0 * v3));
  band = mix(band, max(band, 0.8), isNeb);
  band *= 1.0 - 0.85 * isDeep;

  float n1 = sin(lon * 2.0 + sin(lat * 3.0 + t * 0.25) * 1.6 + t * 0.15);
  float n2 = sin(lon * 5.0 - sin(lat * 4.0 - t * 0.2) * 1.2 - t * 0.22 + 2.4);
  float neb = pow(0.5 + 0.5 * n1, 2.0) * (0.45 + 0.55 * pow(0.5 + 0.5 * n2, 2.0));
  float lane = pow(0.5 + 0.5 * sin(lon * 4.0 + lat * 7.0 + sin(lon * 2.0) * 2.0), 3.0);
  float galaxy = clamp(band * neb * (1.0 - lane * (0.55 + 0.35 * v2)), 0.0, 1.0);

  vec3 hue = mix(
    mix(uC0, uC1, v1),
    mix(uC1, uC2, v3),
    0.5 + 0.5 * sin(lon + lat * 2.0 - t * 0.2)
  );
  vec3 hueGrey = vec3(dot(hue, vec3(0.299, 0.587, 0.114)));
  hue = clamp(hueGrey + (hue - hueGrey) * 1.45, 0.0, 1.0);
  vec3 dust = mix(vec3(0.72, 0.78, 0.92), hue, 0.45 + 0.3 * v1 + 0.45 * isNeb);
  vec3 col = dust * galaxy * (0.6 + 0.9 * isNeb);

  float shear = sin(lon * 13.0 + lat * 4.0 - t * 0.35) * sin(lon * 5.0 + t * 0.2);
  col += dust * band * neb * max(shear, 0.0) * 0.14;
  float gb2 = lat - (0.35 + 0.25 * v2) * sin(lon * 2.0 - 1.1) + 0.4;
  float arm = exp(-gb2 * gb2 * 7.0) * neb;
  col += mix(dust, uC1, 0.35) * arm * 0.2;

  vec3 voidGlow = mix(vec3(0.04, 0.03, 0.1), mix(uC0, mix(uC1, uC2, v3), v1) * 0.22, 0.75);
  col += voidGlow * (0.5 + 0.22 * sin(t * 0.4 + lon)) * (0.4 + 0.6 * band);
  col += vec3(1.0, 0.88, 0.68) * pow(band, 4.0) * pow(neb, 2.0) * 0.4;

  float ca = v2 * 6.28318;
  vec3 coreDir = normalize(vec3(cos(ca) * 0.85, 0.6 * (v3 - 0.5), sin(ca) * 0.85));
  float bulge = max(dot(n, coreDir), 0.0);
  col += mix(vec3(1.0, 0.85, 0.6), uC2, 0.25)
    * (pow(bulge, 14.0) * 1.6 + pow(bulge, 4.0) * 0.5) * isCore;

  float pocket = pow(neb, 5.0) * band * (0.7 + 0.3 * sin(t * 0.6 + lon * 3.0));
  col += mix(uC2, uC0, fract(v1 + 0.5 * sin(lon * 2.0) + 0.5))
    * pocket * (0.5 + 0.4 * v2 + 0.8 * isNeb);
  float pocket2 = pow(0.5 + 0.5 * sin(lon * 3.0 + lat * 4.0 - t * 0.18 + 2.0), 6.0) * band;
  col += mix(uC1, uC2, v3) * pocket2 * (0.25 + 0.3 * v1 + 0.5 * isNeb);

  float detail = smoothstep(90.0, 200.0, uRes.y);
  vec2 gg = vec2(lon, lat) * 34.0;
  vec2 gc = floor(gg);
  vec2 gf = fract(gg);
  float gh = h1(gc.x * 3.7 + gc.y * 11.3);
  vec2 gp = vec2(0.2 + 0.6 * h1(gh * 91.0), 0.2 + 0.6 * h1(gh * 47.0));
  float gd = length((gf - gp) * vec2(cos(lat), 1.0));
  float grain = exp(-gd * gd * 700.0 * clamp(uRes.y / 420.0, 0.22, 1.0))
    * step(0.3, gh) * (0.15 + 0.85 * band);
  col += vec3(0.88, 0.9, 1.0) * grain * 0.4 * detail;
  float weight = clamp(galaxy * 0.7 + pow(band, 4.0) * 0.25, 0.0, 1.0);

  for (int s = 0; s < 3; s++) {
    float scale = s == 0 ? 6.0 : (s == 1 ? 11.0 : 19.0);
    vec2 g = vec2(lon, lat) * scale;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float hx = h1(cell.x * 13.7 + cell.y * 7.3 + float(s) * 91.0);
    float hy = h1(cell.x * 5.1 + cell.y * 17.9 + float(s) * 37.0);
    vec2 sp = vec2(0.15 + 0.7 * hx, 0.15 + 0.7 * hy);
    float distanceToStar = length((f - sp) * vec2(cos(lat), 1.0));
    float census = (v2 - 0.5) * 0.2 + 0.35 * isNeb - 0.2 * isCore + 0.3 * isDeep;
    float keep = step((s == 2 ? 0.3 : 0.55) + census, h1(hx * 89.0 + hy * 31.0) + band * 0.25);
    float res = clamp(uRes.y / 420.0, 0.22, 1.0);
    float twinkle = mix(0.92, 0.6 + 0.4 * sin(t * (1.5 + 3.0 * hx) + hx * 40.0), res);
    float hz = h1(hx * 53.0 + hy * 71.0 + cell.x);
    float sizeJitter = 0.35 + 1.8 * hz * hz;
    float sharp = (s == 0 ? 260.0 : (s == 1 ? 700.0 : 1600.0)) / sizeJitter * res;
    float star = exp(-distanceToStar * distanceToStar * sharp) * keep * twinkle;
    vec3 tint = mix(
      vec3(1.0),
      hx < 0.33 ? vec3(0.85, 0.9, 1.0) : (hx < 0.66 ? vec3(1.0, 0.95, 0.85) : mix(vec3(1.0), uC1, 0.3)),
      0.6
    );
    float bright = (s == 0 ? 1.7 : (s == 1 ? 0.9 : 0.5)) * (0.55 + 0.7 * sizeJitter);
    float starFade = mix(s == 2 ? 0.14 : 0.45, 1.0, detail);
    col += tint * star * bright * starFade;
    if (s == 0) {
      float big = smoothstep(1.2, 2.0, sizeJitter);
      col += tint * exp(-distanceToStar * distanceToStar * 60.0) * 0.18 * big * twinkle * starFade;
      vec2 delta = (f - sp) * vec2(cos(lat), 1.0);
      float spike = exp(-delta.x * delta.x * 1200.0) * exp(-delta.y * delta.y * 26.0)
        + exp(-delta.y * delta.y * 1200.0) * exp(-delta.x * delta.x * 26.0);
      col += tint * spike * 0.3 * big * twinkle * starFade;
      weight = max(weight, spike * 0.3 * big * starFade);
    }
    weight = max(weight, star * min(bright, 1.5) * starFade);
  }

  float pa = v1 * 6.28318;
  vec3 pulsarDir = normalize(vec3(sin(pa) * 0.9, 1.4 * (v2 - 0.5), cos(pa) * 0.9));
  float pd = max(dot(n, pulsarDir), 0.0);
  float beat = pow(0.5 + 0.5 * sin(t * (1.2 + v3 + 1.5 * uAudio) + v3 * 6.28), 8.0);
  beat = min(1.0, beat + 0.6 * uAudio);
  float pulsarFade = mix(0.45, 1.0, detail);
  col += vec3(0.9, 0.95, 1.0)
    * (pow(pd, 900.0) * (0.6 + 1.2 * beat) + pow(pd, 110.0) * 0.5 * beat) * pulsarFade;
  weight = max(weight, pow(pd, 900.0) * (0.5 + 0.5 * beat) * pulsarFade);
  return vec4(min(col, vec3(1.0)), min(weight, 1.0));
}

vec4 sphereAt(vec3 n, float spin, float t) {
  float roll = t * 0.13;
  float cr = cos(roll);
  float sr = sin(roll);
  n = vec3(cr * n.x - sr * n.y, sr * n.x + cr * n.y, n.z);
  float tilt = 0.45 + 0.35 * sin(t * 0.24);
  float cx = cos(tilt);
  float sx = sin(tilt);
  n = vec3(n.x, cx * n.y - sx * n.z, sx * n.y + cx * n.z);
  float cs = cos(spin);
  float ss = sin(spin);
  n = vec3(cs * n.x + ss * n.z, n.y, -ss * n.x + cs * n.z);
  return starfield(n, t);
}

// Background wash: reference shade() plus a vignette fold into uBg at the edge.
vec3 shade(vec2 p) {
  float radius = length(p);
  float t = uTime * 0.8 + uPhase;
  float rr = min(radius, 0.9995);
  float z = sqrt(1.0 - rr * rr);
  vec3 normal = vec3(p.x, p.y, z);
  float fresnel = pow(1.0 - z, 2.4);
  vec3 ray = refract(vec3(0.0, 0.0, -1.0), normal, 0.75);
  float hit = -2.0 * dot(normal, ray);
  vec3 backNormal = normalize(normal + ray * hit);
  float sv = fract(uPhase * 6.31);
  float sw = fract(uPhase * 2.17);
  float warpedTime = t
    + (0.9 + 1.3 * sv) * sin(t * (0.09 + 0.07 * sw))
    + (0.5 + 0.8 * sw) * sin(t * (0.21 + 0.09 * sv) + 2.6);
  vec4 front = sphereAt(normal, uSpin, warpedTime);
  vec4 back = sphereAt(backNormal, uSpin, warpedTime * 0.8 + 2.7);

  vec3 voidColor = mix(uAnchor * 0.04, uAnchor * 0.35, fresnel);
  vec3 color = mix(uBg, voidColor, 0.97 - 0.04 * fresnel);
  float frontAlpha = clamp(front.a, 0.0, 1.0);
  float backAlpha = clamp(back.a, 0.0, 1.0);
  color = mix(color, back.rgb, backAlpha * 0.16);
  color = mix(color, front.rgb, frontAlpha * 0.85);

  float longitude = atan(normal.x, normal.z);
  float speech = pow(
    0.5 + 0.5 * sin(longitude * 3.0 + sin(longitude * 7.0 + t * 1.1) * 0.7 + t * 0.5),
    3.0
  ) * (0.55 + 0.45 * sin(longitude * 5.0 - t * 0.65 + 1.7));
  float sky = -normal.y;
  float hang = smoothstep(-0.15, 0.5, sky);
  float rays = 0.7 + 0.3 * sin(longitude * 24.0 + sin(longitude * 9.0 - t * 0.8) * 2.0 + t * 1.6);
  float aurora = clamp(speech, 0.0, 1.0) * hang * rays * (1.0 + 2.2 * uAudio);
  float av = fract(uPhase * 2.93);
  vec3 auroraColor = mix(
    vec3(0.12, 0.95, 0.55),
    vec3(0.45, 0.35, 1.0),
    smoothstep(0.0, 0.95, sky + 0.35 * speech)
  );
  auroraColor = mix(auroraColor, mix(uC0, uC2, av), 0.15 + 0.4 * av);
  color += auroraColor * aurora * 0.8;

  float meteorCadence = 4.5 + 3.5 * fract(uPhase * 4.91);
  float epoch = floor(t / meteorCadence);
  float meteorPhase = fract(t / meteorCadence);
  vec2 start = vec2(-1.1 + 2.2 * h1(epoch * 1.3), 0.85 - 1.4 * h1(epoch * 2.9));
  vec2 direction = normalize(vec2(0.7 + 0.5 * h1(epoch * 4.1), -0.35 - 0.4 * h1(epoch * 5.3)));
  vec2 head = start + direction * meteorPhase * 2.8;
  vec2 relative = p - head;
  float along = dot(relative, direction);
  float perpendicular = dot(relative, vec2(-direction.y, direction.x));
  float visibility = smoothstep(0.0, 0.06, meteorPhase) * smoothstep(0.5, 0.32, meteorPhase);
  float tail = exp(-perpendicular * perpendicular * 1600.0) * exp(along * 9.0)
    * step(along, 0.0) * smoothstep(-0.5, -0.02, along);
  float headGlow = exp(-dot(relative, relative) * 900.0);
  color += (vec3(1.0) * headGlow * 1.2 + mix(vec3(1.0), uC1, 0.3) * tail * 0.85) * visibility;

  vec3 lightDirection = normalize(vec3(0.85 * sin(t * 0.42), 0.45 * sin(t * 0.26 + 1.2), 0.5));
  float diffuse = (0.62 + 0.65 * max(dot(normal, lightDirection), 0.0)) * (1.0 + 0.35 * uAudio);
  color *= diffuse;
  vec3 voiceColor = mix(uC1, vec3(1.0, 0.97, 0.9), 0.45);
  color += voiceColor * pow(1.0 - rr, 1.8) * uAudio * 0.5;
  color += (uC1 * 0.7 + vec3(0.12)) * fresnel * uAudio * 0.65;
  color += color * uAudio * 0.18 * sin(t * 14.0 + rr * 40.0 + uPhase * 7.0);
  float counter = max(dot(normal.xy, -lightDirection.xy), 0.0) * fresnel;
  color += mix(uC0, vec3(0.5, 0.6, 0.9), 0.5) * counter * 0.18;

  vec3 key = normalize(vec3(-0.45 + 0.3 * sin(t * 0.34), 0.62 + 0.2 * sin(t * 0.27 + 1.7), 0.64));
  float keyAmount = 0.5 * (0.78 + 0.22 * sin(t * 0.45 + 2.2));
  color += vec3(1.0) * pow(max(dot(normal, key), 0.0), 150.0) * keyAmount;
  vec3 sheen = normalize(vec3(sin(t * 0.07) * 0.9, 0.35 + 0.3 * cos(t * 0.05), 0.7));
  color += vec3(1.0) * pow(max(dot(normal, sheen), 0.0), 7.0) * 0.05;
  vec3 counterLight = normalize(vec3(0.52, -0.5 + 0.12 * sin(t * 0.09), 0.69));
  color += vec3(1.0) * pow(max(dot(normal, counterLight), 0.0), 140.0) * 0.25;
  color = mix(color, front.rgb, frontAlpha * fresnel * 0.3);
  color = mix(color, color * 0.85, smoothstep(0.94, 1.0, rr) * 0.4);

  // Background variant is full-bleed: fold through the void at the edge.
  float vig = smoothstep(1.25, 0.35, radius);
  color = mix(uBg, color, vig);
  return color;
}

// ── hero: black-glass prism ────────────────────────────────────────────
// Same galaxy, same light rig, different geometry. The starfield is sampled
// on a virtual inner sphere hit by the refracted ray, so flat facets still
// show parallax and curvature instead of a constant colour per face.

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// Apex-up prism: a single point at the top, three edges running down to a
// triangular base. Exact intersection of four half-spaces — no rounding
// radius, so the apex and every edge stay razor sharp. max() of plane
// distances underestimates near edges, which is safe for sphere tracing.
float prismSdf(vec3 q) {
  const float APEX = 0.62;
  const float BASE = -0.42;
  const float APO = 0.33; // base apothem (circumradius 0.66)
  vec2 slant = normalize(vec2(APEX - BASE, APO)); // (radial, y) of side normals
  float d = BASE - q.y;
  for (int i = 0; i < 3; i++) {
    // Face normals at 30/150/270 deg: a base vertex faces the camera, so the
    // front shows two facets meeting at one vertical razor edge.
    float a = 2.0943951 * float(i) + 0.5235988;
    vec2 u = vec2(cos(a), sin(a));
    d = max(d, dot(q.xz, u) * slant.x + (q.y - APEX) * slant.y);
  }
  return d;
}

vec3 prismNormal(vec3 q, float e) {
  vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * prismSdf(q + k.xyy * e) +
    k.yyx * prismSdf(q + k.yyx * e) +
    k.yxy * prismSdf(q + k.yxy * e) +
    k.xxx * prismSdf(q + k.xxx * e));
}

vec4 prism(vec2 p) {
  float t = uTime * 0.8 + uPhase;
  float sv = fract(uPhase * 6.31);
  float sw = fract(uPhase * 2.17);
  float warpedTime = t
    + (0.9 + 1.3 * sv) * sin(t * (0.09 + 0.07 * sw))
    + (0.5 + 0.8 * sw) * sin(t * (0.21 + 0.09 * sv) + 2.6);

  // World ray, then a copy rotated into object space (the prism turns).
  vec3 roW = vec3(0.0, 0.0, 2.15);
  vec3 rdW = normalize(vec3(p, -2.4));
  // The only motion is the slow horizontal turn around the vertical axis.
  // The camera sits at a fixed slight top-down tilt (negative pitch keeps
  // the base face hidden) — no wobble, no roll, no bob.
  float yaw = uSpin * 0.55;
  float pitch = -0.3;
  vec3 ro = roW;
  vec3 rd = rdW;
  ro.xz *= rot2(yaw);  rd.xz *= rot2(yaw);
  ro.yz *= rot2(pitch); rd.yz *= rot2(pitch);

  float tr = 0.0;
  float glow = 0.0;
  bool hit = false;
  for (int i = 0; i < 72; i++) {
    float d = prismSdf(ro + rd * tr);
    glow = max(glow, exp(-abs(d) * 9.0) * exp(-tr * 0.22));
    if (d < 0.0015) { hit = true; break; }
    tr += d * 0.9;
    if (tr > 7.0) break;
  }

  if (!hit) {
    // Faint cool halo; also softens the marched silhouette.
    float a = clamp(glow * 0.18, 0.0, 1.0);
    return vec4(mix(uAnchor * 2.0, mix(uC1, uC2, 0.5), 0.4) * a * 0.6, a);
  }

  vec3 q = ro + rd * tr;
  vec3 n = prismNormal(q, 0.002);
  vec3 nc = prismNormal(q, 0.02);
  // Fine vs coarse normals diverge only on the sharp edges; the small coarse
  // epsilon keeps the accent a hairline instead of a soft band.
  float edge = clamp(length(n - nc) * 1.4, 0.0, 1.0);
  float fresnel = pow(1.0 - max(dot(-rd, n), 0.0), 2.4);

  // World-space normal for the light rig, so facet flashes sweep as it turns.
  vec3 nW = n;
  nW.yz *= rot2(-pitch);
  nW.xz *= rot2(-yaw);

  // Galaxy on a virtual inner sphere, seen through the entry refraction.
  vec3 ray = refract(rd, n, 0.75);
  float R = 0.78;
  float b = dot(q, ray);
  float disc = b * b - (dot(q, q) - R * R);
  float s = sqrt(max(disc, 0.0));
  vec3 nf = normalize(q + ray * (-b - s));
  vec3 nb = normalize(q + ray * (-b + s));
  vec4 front = sphereAt(nf, uSpin, warpedTime);
  vec4 back = sphereAt(nb, uSpin, warpedTime * 0.8 + 2.7);
  float frontAlpha = clamp(front.a, 0.0, 1.0);
  float backAlpha = clamp(back.a, 0.0, 1.0);

  // Reference glass assembly: near-black base, back parallax, front galaxy.
  vec3 voidColor = mix(uAnchor * 0.04, uAnchor * 0.35, fresnel);
  vec3 color = voidColor;
  color = mix(color, back.rgb, backAlpha * 0.16);
  color = mix(color, front.rgb, frontAlpha * 0.85);

  // Reference light rig against the facet normals.
  vec3 lightDirection = normalize(vec3(0.85 * sin(t * 0.42), 0.45 * sin(t * 0.26 + 1.2), 0.5));
  float diffuse = (0.62 + 0.65 * max(dot(nW, lightDirection), 0.0)) * (1.0 + 0.35 * uAudio);
  color *= diffuse;
  float counter = max(dot(nW.xy, -lightDirection.xy), 0.0) * fresnel;
  color += mix(uC0, vec3(0.5, 0.6, 0.9), 0.5) * counter * 0.18;

  vec3 key = normalize(vec3(-0.45 + 0.3 * sin(t * 0.34), 0.62 + 0.2 * sin(t * 0.27 + 1.7), 0.64));
  float keyAmount = 0.5 * (0.78 + 0.22 * sin(t * 0.45 + 2.2));
  // The key light is the one specular a prism should split: red and blue
  // lobes a few degrees apart, white in the middle.
  vec3 keyR = normalize(key + vec3(0.05, 0.0, 0.0));
  vec3 keyB = normalize(key - vec3(0.05, 0.0, 0.0));
  color += vec3(1.0, 0.4, 0.35) * pow(max(dot(nW, keyR), 0.0), 150.0) * keyAmount * 0.55;
  color += vec3(1.0) * pow(max(dot(nW, key), 0.0), 150.0) * keyAmount;
  color += vec3(0.35, 0.55, 1.0) * pow(max(dot(nW, keyB), 0.0), 150.0) * keyAmount * 0.55;

  vec3 sheen = normalize(vec3(sin(t * 0.07) * 0.9, 0.35 + 0.3 * cos(t * 0.05), 0.7));
  color += vec3(1.0) * pow(max(dot(nW, sheen), 0.0), 7.0) * 0.05;
  vec3 counterLight = normalize(vec3(0.52, -0.5 + 0.12 * sin(t * 0.09), 0.69));
  color += vec3(1.0) * pow(max(dot(nW, counterLight), 0.0), 140.0) * 0.25;

  color = mix(color, front.rgb, frontAlpha * fresnel * 0.3);

  // Spectral hairline on the sharp edges — brand accents, not a rainbow.
  float ec = q.x * 0.6 + q.y * 0.9 + uTime * 0.06;
  vec3 spectrum = mix(
    mix(uC0, uC1, 0.5 + 0.5 * sin(ec * 6.28318)),
    uC2,
    0.5 + 0.5 * sin(ec * 3.7 + 1.7)
  );
  color += spectrum * edge * (0.3 + 0.25 * uAudio + 0.25 * fresnel);

  return vec4(color, 1.0);
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  // Keep aspect correct: caller sets canvas to viewport, so no extra correction
  // is needed beyond the -1..1 mapping.
  if (uVariant > 0.5) {
    // Hero: premultiplied colour + coverage for compositing over the frame.
    fragColor = prism(p);
    return;
  }
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
  // Background: full-bleed opaque over #000 via uBg, coverage is 1.
  // Still premultiplied so blending with page is correct at the blur edge.
  fragColor = vec4(col, 1.0);
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
  uRes: WebGLUniformLocation | null;
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
    uRes: gl.getUniformLocation(program, 'uRes'),
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
