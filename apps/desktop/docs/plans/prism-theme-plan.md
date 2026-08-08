# Prism OLED Theme — Implementation Plan

**Brand:** `prism` | **Base:** OLED pure black `#000000` + spectral neon | **Switch model:** restart-required (relaunch) | **Status:** plan only, no source edits beyond this MD | **Date:** 2026-08-08 | **Author:** planner sub-agent (parallel track A)

> This is the Prism track. Murmur is planned in parallel — keep shared machinery (brand-gated CSS loader, relaunch, motion utils) compatible with both, but Prism owns the cinematic payload: WebGL prism, seeded personality, spectral glass, and the #000 void.

---

## 0) How to use this plan

Implementer executes **top to bottom**. Each section ends with an acceptance check. File paths are absolute from repo root unless marked. No new npm deps without justification (see §4.6). All code lives under `apps/desktop/` — never import from `.claude/skills/sssf/`, never add Python. Run `npm run check` before finishing (typecheck → lint → format:check → knip → test → build → audit:deps).

Reference orb skill: `/Users/nik/.agents/skills/black-glass-orb-app/SKILL.md` + templates `OrbShader.metal`, `OrbMotion.swift`, `OrbRenderer.swift` + live reference at `~/repos/ghostty-vibe-xr/ghosttyxr/mac-companion/GhosttyXR-Companion/Sources/GhosttyXRCompanion/Views/Orb/` (and WebGL original `website/src/components/voice/orb-renderer.ts`). This plan is a **port of those ideas into WebGL/GLSL inside the renderer process** — not a floating window.

---

## 1) Vision summary

### 1.1 One-line pitch

**Prism turns Foundry into a dark-lab instrument viewed through black glass.** The window is a true OLED void (`#000`), not the current `#06080f` navy. Inside it, a spectrum has been split — cyan, magenta, violet, amber — and caught in glass. Light refracts through a faceted prism, not a glowing blob. Everything else is evidence-gray, until status or interaction pulls a spectral edge into view. It is quiet, expensive, and responsive like hardware: seeded, slightly asymmetric, never looping cleanly.

### 1.2 Palette — concrete anchors

Keep semantic token _names_ (`--cyan`, `--purple`, etc. — inspector waterfalls and phase badges already bind to them). Override their _values_ per brand. Prism adds a spectral layer underneath.

| Role                      | Token(s)                                                                                                                      | Prism value                                                                                                         | Note                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Void / base**           | `--bg-void`                                                                                                                   | `#000000`                                                                                                           | OLED black, window `backgroundColor` matches. Pure black is the point — no navy tint. |
| **Base / panel / raised** | `--bg-base` `#080A14` → `#05070A`? **No** — Prism is `#000000` → `#080A0F` → `#0B101E` → `#121A2E`                            | See §3 for full ladder. Surfaces are black-adjacent, not grey. Each step is a deliberate lift off void.             |
| **Text**                  | `--text` `#E8ECF4` → `#EDEFF5`                                                                                                | Slightly brighter to survive pure-black contrast.                                                                   |
| **Text dim/faint**        | `--text-dim` `#9AA6BD` → `#8E9BB3`, `--text-faint` `#6B7689` → `#5D6A80`                                                      | Keep dim hierarchy; Prism's spectral accents must remain brightest thing.                                           |
| **Lines**                 | `--line` `rgba(255,255,255,0.09)` → `rgba(255,255,255,0.07)`, `--line-strong` `0.16` → `0.13`, `--line-faint` `0.05` → `0.04` | Thinner on black — lines vanish faster. Glass borders re-introduce the edge where needed.                           |
| **Cyan (primary)**        | `--cyan` `#5AD2DD` → **keep** `#5AD2DD` (anchor)                                                                              | Retain for continuity; it is the Prism lead. `color-mix` glow widens.                                               |
| **Purple / violet**       | `--purple` `#C89BFF` → `#A78BFA` (spectral violet)                                                                            | Shift from pastel to neon violet: more blue, more snap.                                                             |
| **Magenta**               | _new_ `--prism-magenta` `#FF3B9A`                                                                                             | Spectrum anchor absent today. Prism introduces it. Used for accents only, not status.                               |
| **Amber**                 | `--amber` `#E8B64A` → `#F59E0B` + `--prism-amber` same                                                                        | Warmer, more saturated — the long-wavelength end.                                                                   |
| **Emerald / ice tail**    | `--prism-ice` `#B8F1FF`, `--prism-emerald` `#34D399`                                                                          | Short/long tails of spectrum. Ice is the OrbPalette accent2; emerald grounds success on black without losing punch. |
| **Success/fail**          | `--green` `#4ADE80` → `#34D399`, `--red` `#FF6F67` → `#FB7185`                                                                | Slightly purer on black; keep semantic mapping `--status-success: var(--green)` etc.                                |
| **Neon dims**             | `--cyan-dim` `#5AD2DD28` → `#5AD2DD22`, `--purple-dim` → `#A78BFA22`, etc.                                                    | Lower alpha on black — chrome must not muddy void. Each brand neon gets a `…-dim` at ~13–14% alpha.                 |

**Prism-exclusive tokens** (add, do not replace):

```css
--prism-neon-cyan: #5ad2dd; /* spectrum 480nm */
--prism-neon-violet: #7b5cff; /* 420nm — OrbPalette accent1 */
--prism-neon-magenta: #ff3b9a; /* 700nm+ folded back (prism wrap) */
--prism-neon-amber: #f59e0b; /* 590nm */
--prism-neon-ice: #b8f1ff; /* OrbPalette accent2 */
--glass-bg: rgba(12, 16, 32, 0.42);
--glass-bg-strong: rgba(12, 16, 32, 0.62);
--glass-border: rgba(255, 255, 255, 0.08);
--glass-border-strong: rgba(255, 255, 255, 0.12);
--glass-blur: 18px;
--glass-blur-strong: 26px;
--glass-saturate: 1.35;
--prism-chroma-offset: 1.4px; /* RGB split on glass edge */
--prism-glow-cyan: 0 0 0 1px var(--cyan-dim), 0 0 28px -8px var(--cyan);
--prism-glow-violet: 0 0 0 1px var(--prism-neon-violet-dim), 0 0 28px -8px var(--prism-neon-violet);
```

**Contrast discipline:** On `#000`, WCAG AAA for body text is easier (ratio ~18:1), but muted text (`--text-faint`) risks falling below 4.5:1 if lightened blindly. Prism keeps faint at no lighter than `#5D6A80` on `#000` (ratio ~5.2:1). Verify with `npx lighthouse` or manual contrast check on sidebar + inspector.

### 1.3 Glass thickness & refraction rules

| Element                                    | Thickness metaphor      | Blur                                          | Border                                                                                | Shadow                                                               | Chromatic rule                                                                          |
| ------------------------------------------ | ----------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **App background**                         | void (no glass)         | none                                          | none                                                                                  | none                                                                 | none — pure black, no tint                                                              |
| **Sidebar / titlebar**                     | thin cold glass, 6–8px  | `backdrop-filter: blur(14px) saturate(1.2)`   | 1px `rgba(255,255,255,0.06)` left edge only                                           | none                                                                 | no chromatic — stays utilitarian                                                        |
| **Cards / panels** (`--bg-panel` surfaces) | 10–14px black glass     | `blur(18px) saturate(1.35)`                   | 1px `rgba(255,255,255,0.08)` + inner `inset 0 1px 0 rgba(255,255,255,0.06)` highlight | `0 16px 48px rgba(0,0,0,0.65)` + spectral outer glow on hover        | **1.0–1.6px RGB channel offset** on hover/focus (see §4)                                |
| **Primary buttons / active pills**         | beveled prism edge      | none (solid)                                  | 1px spectral tint (`var(--cyan)` or violet)                                           | outer glow `0 0 24px -6px var(--cyan)`                               | on press: brief 120ms chromatic burst (R +1.4px, B −1.4px)                              |
| **Inspector transcript lane**              | etched glass            | `blur(8px)` subtle                            | faint top rule                                                                        | inner shadow `inset 0 1px 0 rgba(255,255,255,0.04)`                  | none — readability first                                                                |
| **Onboarding hero prism**                  | 18–22px faceted crystal | WebGL owns interior; CSS glass is the _frame_ | 1px `rgba(255,255,255,0.10)` + 1px inner `rgba(90,210,221,0.18)` rim                  | `0 24px 64px rgba(0,0,0,0.75), 0 0 40px -12px rgba(90,210,221,0.35)` | shader does real dispersion; frame gets static 3-stop edge gradient (cyan→violet→amber) |

**Rule of thirds for refraction:** No more than one refracting surface is “hot” at a time. Idle: only the hero prism shimmers. Hover: hovered card gains chromatic edge (others stay dormant). Active (run running): background field gains energy but cards stay quiet. Press: single burst. This prevents the “everything is chrome” carnival.

### 1.4 Motion personality

Direct port of `OrbMotion` semantics:

- **Seeded.** Each install derives a stable `phase` float in `[0,1)` from a persistent value (e.g., FNV-1a of `engineerName + settings.brand + installId` — see §4.7). Two teammates running the same build see subtly different prisms; same prompt → same _kind_ of result, per the repo philosophy, but the glass has its own fingerprint.
- **Asymmetric envelopes.** Two smoothed energy signals, not one:
  - `audioSmooth` (rise `0.11s`, decay `0.30s`) → shader `uAudio`/glow/aurora. Feels like breathing.
  - `audioFast` (rise `0.04s`, decay `0.18s`) → spin velocity impulse. Feels like a twitch.
  - Energy rises fast, decays slowly. “Pushed, then lingers.”
- **Queued direction flips.** A slow per-prism oscillator (`sin(t * (0.45+0.2*variance) + phase)`) queues a spin-direction flip; the flip is _applied only when `audioFast` is quiet_, so mid-flare never stutters. This is the “it feels alive rather than decorative” trick — copy it verbatim, do not invent a simpler lerp.
- **Perlin-ish warps.** Idle drift is not a clean `sin(time)`. Add phase-modulated warps: `warpedTime = t + 0.9*sin(t*0.09) + 0.5*sin(t*0.21)` scaled by `v1/v2` derived from `fract(phase*…)`. See `OrbMotion.swift:41-55` and `OrbShader.metal: sphereAt → warpedTime`.
- **Why not random?** Seeded determinism + oscillator sign memory is what makes the orb feel like an object with momentum, not a screensaver.

---

## 2) Architecture for restart-required switch

### 2.1 Decision: brand-gated CSS at launch + full relaunch on change

**Locked choice:** restart-required. No live CSS-variable flicker. Theme is decided _before first paint_ and only changes via `app.relaunch()`.

Rejected alternative: live `data-brand` swap with `<link disabled>` toggling. It works, but heavy WebGL layers + `backgroundColor`/`vibrancy` cannot be hot-swapped without a layout flash, and Prism's `#000` vs Murmur's `#06080f` would FOUC on every toggle. Restart gives clean separation and lets the main process own `backgroundColor`/`vibrancy` atomically with the CSS.

### 2.2 Launch sequence (no FOUC)

```
Electron main (Node, before window)                Renderer (Chromium, before React)
─────────────────────────────────────              ────────────────────────────────
1. AppContext ctor reads settings.json              1. index.html shell is minimal, body { background: var(--bg-void) }
   synchronously (JsonStore.read is sync).
2. createWindow(brand) reads                      2. main.tsx runs BEFORE createRoot:
     brand = settings.get().brand                    const brand = new URLSearchParams(location.search).get('brand') ?? 'prism'
   → picks BrowserWindow opts:                     document.documentElement.setAttribute('data-brand', brand)
     if prism:                                         // branch-select CSS:
       backgroundColor: '#000000'                    if (brand === 'prism') await import('./design/tokens-prism.css')
       vibrancy: undefined                           else await import('./design/tokens-murmur.css')
       visualEffectState: undefined                  await import('./design/tokens-base.css')  // or tokens.css split
     else (murmur):
       backgroundColor: '#06080f'                    // then mount React
       vibrancy: 'under-window'
       visualEffectState: 'followWindow'          3. React mounts, first paint sees correct vars.
3. loadFile(index.html?brand=prism)               4. useBrandedAsset still works — main's assetUrl already brand-aware
   or loadURL(DEV_URL?brand=prism)                    (prism → assets/brands/prism/**, fallback assets/**).
4. ctx.applyBrandDockIcon() (existing)
   uses 1024px icon from brands/<brand>/icon/
```

**Why query param, not preload `window.__BRAND__`:** Query param is available _synchronously_ in `main.tsx` without waiting for preload bridge IPC (which is async and would force a placeholder paint). Preload's `bridge.cjs` can also expose `window.foundry.brand` via `contextBridge`, but it would arrive after the first style recalculation. Keep it as `?brand=` URL state; it survives dev `ELECTRON_RENDERER_URL` and packaged `loadFile`.

**FOUC avoidance details:**

- `src/renderer/index.html` adds a blocking `<style>` that hides `#app` until `data-brand` is set:
  ```html
  <style>
    html:not([data-brand]) #app {
      visibility: hidden;
    }
    html {
      background: #000;
    }
  </style>
  ```
  The `html` background is set to prism's `#000000` as neutral fallback (black is safe for both — murmur's `#06080f` is close enough that a 1-frame black is not a flash; the reverse would be a white-ish flash).
- `main.tsx` sets `document.documentElement.dataset.brand` _before_ any `import('./design/…')` that triggers style insertion. Vite's CSS imports are hoisted — so instead do **static side-effect imports guarded by branch via dynamic `import()`** or **two entry CSS files** (see below). The critical thing is that no React renders until the correct token file has been evaluated.
- Motion: `PrismField` canvas is mounted with `opacity:0` and fades in over `400ms var(--ease)` after first WebGL frame. No black-to-prism pop.

### 2.3 CSS file split — proposed paths

Keep the current `tokens.css` story but split into base + brand overrides. This matches the “tokens-prism.css / tokens-murmur.css imported via a brand-gated loader in main.tsx” option in the task.

```
apps/desktop/src/renderer/design/
  tokens.css              ← KEEP for one release as re-export shim, then delete.
                          For now, split physically but preserve import path
                          so old imports don't break during migration:
                          @import './tokens-base.css';

  tokens-base.css         ← NEW. Structural tokens only: spacing (--s*), radii (--r*),
                          type scale (--text-*), --leading, --font, --sidebar-w,
                          --titlebar-h, --lane-h, motion (--ease, --fast etc.),
                          z-index scale, scrollbar, focus-visible.
                          NO colors. No --bg-*, --line-*, --text color vars.

  tokens-prism.css        ← NEW. All color + depth + glass tokens for Prism.
                          :root, :root[data-brand="prism"] { --bg-void:#000; … }
                          Includes --prism-neon-*, --glass-*, --glow-*.

  tokens-murmur.css       ← NEW. Murmur's color overrides (keeps current navy #06080f base
                          but namespaced). :root[data-brand="murmur"] { … }.
                          Extracted from current tokens.css so Prism edit cannot regress Murmur.

  prism/
    prism.css             ← NEW. Prism chrome: .glass, .glass-strong, .chroma-edge,
                          .spectral-border, .prism-hero-frame, scrollbar tint, focus ring tint.
                          Imported only when brand=prism (from main.tsx).
    prism-animations.css  ← NEW (or inside prism.css). Keyframes for shimmer, drift, burst.
                          Respects @media (prefers-reduced-motion: reduce) → durations 0.

apps/desktop/src/renderer/components/prism/
  PrismField.tsx          ← NEW. Full-bleed background canvas + hero variant. Props: variant ('background'|'hero'), energy, seed.
  PrismShader.ts          ← NEW. GLSL strings + compile helpers (vertex + fragment), uniform locations.
  PrismMotion.ts          ← NEW. Port of OrbMotion.swift → TypeScript (phase, timeOffset, spin, audioSmooth/Fast, flipQueued).
  usePrismMotion.ts       ← NEW. Hook wiring PrismMotion to rAF + visibility + prefers-reduced-motion.
  GlassCard.tsx           ← NEW (or extend existing .card). Glass wrapper applying .glass + chromatic edge logic.

apps/desktop/src/renderer/hooks/
  useBrand.ts             ← NEW small hook: reads ?brand=, exposes BrandId, used by PrismField for seed toggle.
```

**Vite wiring:** `electron.vite.config.ts` already aliases `@shared/@main/@renderer`. No config change needed for CSS — Vite handles `import './design/tokens-prism.css'` as a CSS chunk. To avoid both brand CSS loading, `main.tsx` must use **dynamic imports** (code-split) rather than static `import './tokens-prism.css'` at top level (which would bundle both). Pattern:

```ts
// src/renderer/main.tsx
const brand = new URLSearchParams(location.search).get('brand') as BrandId | null ?? 'prism';
document.documentElement.setAttribute('data-brand', brand);
if (brand === 'prism') {
  await import('./design/tokens-prism.css');
  await import('./design/prism/prism.css');
} else {
  await import('./design/tokens-murmur.css');
}
import('./design/tokens-base.css'); // base is tiny, can be static but keep order: base first, then brand overrides win
createRoot(...).render(<App />)
```

Because `main.tsx` is an async entry, add `type="module"` already; top-level await is supported in Vite. If top-level await is disallowed by Electron's ESM loader, wrap in `(async () => { … })()` before `createRoot`.

Alternative that also satisfies “no FOUC” and is simpler to verify: **two HTML entry CSS links** injected by main — but dynamic `import()` is more idiomatic for electron-vite and keeps CSS in Vite's graph (HMR in dev still works: changing `tokens-prism.css` hot-reloads only when `?brand=prism`).

**Electron window chrome per brand:**

```ts
// src/main/main.ts — createWindow(brand: BrandId)
const isPrism = brand === 'prism';
const win = new BrowserWindow({
  width: 1440,
  height: 940,
  minWidth: 1080,
  minHeight: 720,
  show: false,
  title: 'Foundry',
  titleBarStyle: 'hiddenInset',
  trafficLightPosition: { x: 18, y: 22 },
  vibrancy: isPrism ? undefined : 'under-window',
  visualEffectState: isPrism ? undefined : 'followWindow',
  backgroundColor: isPrism ? '#000000' : '#06080f',
  transparent: false, // keep opaque — OLED black is cheaper than transparent blur on Intel
  webPreferences: {
    preload: join(here, '../preload/bridge.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: true,
    additionalArguments: [`--brand=${brand}`], // fallback channel for preload if needed
  },
});
const url = DEV_URL ? `${DEV_URL}?brand=${brand}` : null;
if (url) await win.loadURL(url);
else await win.loadFile(join(here, '../renderer/index.html'), { query: { brand } });
```

`loadFile` with `{ query: { brand } }` is Electron ≥28 API — it appends `?brand=prism` to the `file://` URL, so `location.search` works in packaged builds too. Verify with a quick test on `npm run build && npm start`.

**Settings → General picker change:** `src/renderer/screens/SettingsScreen.tsx:330 applyBrand` currently patches settings and tries `api.brand.applyDockIcon()` live with a toast, offering a manual `Relaunch` button. Prism keeps that but **adds a required restart**:

```ts
const applyBrand = async (brand: BrandId) => {
  if (!settings || brandBusy || settings.brand === brand) return;
  setBrandBusy(true);
  const res = await patchSettings({ brand });
  if (res.issues.length) {
    /* show errors */ return;
  }
  await api.brand.applyDockIcon(); // best-effort, same as today
  setBrandNote(`Switched to ${BRAND_LABELS[brand]} — relaunch to apply theme.`);
  // Do NOT auto-relaunch — show banner with Relaunch button calling api.app.relaunch()
  // so the user can finish typing elsewhere.
};
```

Banner component (reuse `UpdateBanner` pattern) says “Theme change needs a relaunch — Relaunch now / Later”. Clicking calls `await api.app.relaunch()` which main handles as `app.relaunch(); app.exit(0)` (already exists in `src/main/ipc/app.ts:16`).

Branch on `settings.brand` also drives `ctx.applyBrandDockIcon()` at next launch (already there in `src/main/main.ts:162`).

### 2.4 Stashing brand at boot so first paint is correct (avoid FOUC checklist)

- [ ] Main reads `settings.json` synchronously _before_ `createWindow`.
- [ ] `backgroundColor` matches the brand's `--bg-void` exactly (prism `#000000`, murmur `#06080f`).
- [ ] `vibrancy`/`visualEffectState` set per brand _at construction_ — not mutated post-show.
- [ ] Renderer `main.tsx` sets `document.documentElement.dataset.brand` synchronously before `createRoot`.
- [ ] Correct token CSS is loaded before React mount (dynamic import + await).
- [ ] `index.html` has `html:not([data-brand]) #app{visibility:hidden}` guard so a slow CSS import does not flash unstyled content.
- [ ] Packaged `loadFile` path tested with `{ query: { brand } }` so `location.search` is non-empty in production.
- [ ] `prefers-color-scheme` is forced dark (`<meta name="color-scheme" content="dark">`) plus `document.documentElement.style.colorScheme = 'dark'` — Prism is dark-only; do not let system light mode bleach `color-scheme`.

---

## 3) Token redesign — full mapping

### 3.1 Strategy

- Keep **semantic names** (`--bg-void`, `--line`, `--cyan`, `--status-running`, etc.) — dozens of components bind to them. Override values per brand.
- Keep **structural tokens** brand-agnostic in `tokens-base.css`.
- Add **brand-specific spectral/glass tokens** only in `tokens-prism.css` under `--prism-*` and `--glass-*`. Murmur never sees them (or sees noop fallbacks), so no pollution.
- Use `:root` + `:root[data-brand="prism"]` specificity: base defines defaults, brand files override. In practice with the relaunch model only one brand file loads, but double-guarding with attribute lets dev HMR preview both without restart.

### 3.2 Before / after table

| Semantic token         | Current (implicit murmur)                              | **Prism value**                                            | Rationale                                                                                                                                         |
| ---------------------- | ------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--bg-void`            | `#06080f`                                              | **`#000000`**                                              | OLED void. The single most cinematic move.                                                                                                        |
| `--bg-base`            | `#0A0E18`                                              | **`#05070A`**                                              | Lift off void is barely perceptible. Content shell sits on this.                                                                                  |
| `--bg-panel`           | `#0F1420`                                              | **`#0B0F1E`**                                              | Cards. Slight blue push (`hsl(225 40% 9%)`) so white text never looks yellow on black.                                                            |
| `--bg-raised`          | `#141A28`                                              | **`#121A32`**                                              | Raised interactive surfaces (buttons, inputs idle).                                                                                               |
| `--bg-hover`           | `#1A2232`                                              | **`#182040`**                                              | Hover is where Prism shows violet — `color-mix(in srgb, #121A32 80%, var(--prism-neon-violet) 8%)` if you want subtle tint, else solid `#182040`. |
| `--bg-active`          | `#212B3D`                                              | **`#1E2A4A`**                                              | Active press, deeper.                                                                                                                             |
| `--bg-input`           | `#080B13`                                              | **`#030508`**                                              | Inputs sink _into_ void on Prism, not float. Near-black.                                                                                          |
| `--bg-sidebar`         | `rgba(10,14,24,0.72)`                                  | **`rgba(3,5,10,0.78)`**                                    | Prism sidebar is _more_ opaque because blur is reduced (see vibrancy off). Keeps text legible on black.                                           |
| `--bg-titlebar`        | `rgba(6,8,15,0.6)`                                     | **`rgba(0,0,0,0.72)`**                                     | Titlebar is a glass strip on Prism — darker, so traffic lights pop.                                                                               |
| `--line-faint`         | `rgba(255,255,255,0.05)`                               | **`rgba(255,255,255,0.045)`**                              | Hairlines vanish on #000 at 5% — keep but slightly lower so panels breathe.                                                                       |
| `--line`               | `rgba(255,255,255,0.09)`                               | **`rgba(255,255,255,0.075)`**                              | Same. Prism leans on glass border (`--glass-border`) not generic lines.                                                                           |
| `--line-strong`        | `rgba(255,255,255,0.16)`                               | **`rgba(255,255,255,0.13)`**                               | Inputs focus ring base. Slightly muted — spectral focus ring does the work.                                                                       |
| `--text`               | `#E8ECF4`                                              | **`#EDEFF5`**                                              | Cranked ~2% brighter for #000 contrast/legibility.                                                                                                |
| `--text-dim`           | `#9AA6BD`                                              | **`#8E9BB3`**                                              | Dim is spectral-aware: slightly less warm than before.                                                                                            |
| `--text-faint`         | `#6B7689`                                              | **`#5D6A80`**                                              | Keep ≥4.5:1 on #000.                                                                                                                              |
| `--text-ghost`         | `#47506180` (50% alpha)                                | **`#4A587480`**                                            | Placeholders, empty-state captions.                                                                                                               |
| `--cyan`               | `#5AD2DD`                                              | **`#5AD2DD` (keep)**                                       | Primary accent, OrbPalette-adjacent. Prism's lead.                                                                                                |
| `--cyan-dim`           | `#5AD2DD28` (~16%)                                     | **`#5AD2DD22` (~13%)**                                     | Lower alpha — glows tighter on black.                                                                                                             |
| `--purple`             | `#C89BFF`                                              | **`#A78BFA`**                                              | Violet neon — more saturated, less pastel. Maps to `--prism-neon-violet`.                                                                         |
| `--purple-dim`         | `#C89BFF28`                                            | **`#A78BFA22`**                                            | Match violet shift.                                                                                                                               |
| `--amber`              | `#E8B64A`                                              | **`#F59E0B`**                                              | Spectral amber — purer.                                                                                                                           |
| `--amber-dim`          | `…28`                                                  | **`#F59E0B22`**                                            |                                                                                                                                                   |
| `--green`              | `#4ADE80`                                              | **`#34D399`**                                              | Success on black — emerald reads cleaner.                                                                                                         |
| `--green-dim`          | `…28`                                                  | **`#34D39922`**                                            |                                                                                                                                                   |
| `--red`                | `#FF6F67`                                              | **`#FB7185`**                                              | Rose-red on black, less orange.                                                                                                                   |
| `--red-dim`            | `…28`                                                  | **`#FB718522`**                                            |                                                                                                                                                   |
| `--blue`               | `#6AA8FF`                                              | **`#60A5FA`**                                              | Keep but align to violet family.                                                                                                                  |
| `--blue-dim`           | `…28`                                                  | **`#60A5FA22`**                                            |                                                                                                                                                   |
| `--status-queued` etc. | maps to text-faint/cyan/...                            | **unchanged mapping, new base values flow through**        | No semantic change, just brighter/more spectral base hues.                                                                                        |
| `--shadow-sm`          | `0 1px 3px rgba(0,0,0,0.4)`                            | **`0 1px 3px rgba(0,0,0,0.65)`**                           | Blacker shadows on black — counterintuitive but needed so lifted cards separate.                                                                  |
| `--shadow`             | `0 4px 16px rgba(0,0,0,0.45)`                          | **`0 8px 24px rgba(0,0,0,0.62)`**                          | Larger + darker. Prism cards float higher.                                                                                                        |
| `--shadow-lg`          | `0 16px 48px rgba(0,0,0,0.6)`                          | **`0 24px 64px rgba(0,0,0,0.78)`**                         | Hero / modal.                                                                                                                                     |
| `--glow-cyan`          | `0 0 0 1px var(--cyan-dim), 0 0 24px -6px var(--cyan)` | **`0 0 0 1px var(--cyan-dim), 0 0 28px -8px var(--cyan)`** | Slightly wider blur, tighter alpha — OLED glow trick.                                                                                             |
| `--ease`               | `cubic-bezier(0.32,0.72,0,1)`                          | **keep**                                                   | App-wide motion curve already correct — don't fork per brand.                                                                                     |
| `--fast/normal/slow`   | `120/220/400ms`                                        | **keep, but zero under `prefers-reduced-motion`**          | Same guard: `@media (prefers-reduced-motion: reduce) { :root { --fast:0ms; --normal:0ms; --slow:0ms }}`                                           |

**New Prism spectral tokens (additive, not overriding):**

```css
--prism-neon-cyan: #5ad2dd;
--prism-neon-violet: #7b5cff; /* OrbPalette accent1 */
--prism-neon-magenta: #ff3b9a;
--prism-neon-amber: #f59e0b;
--prism-neon-ice: #b8f1ff; /* OrbPalette accent2 */
--prism-neon-cyan-dim: #5ad2dd22;
--prism-neon-violet-dim: #7b5cff22;
--prism-neon-magenta-dim: #ff3b9a22;
--prism-neon-amber-dim: #f59e0b22;
--prism-spectrum: linear-gradient(
  90deg,
  var(--prism-neon-ice),
  var(--prism-neon-cyan),
  var(--prism-neon-violet),
  var(--prism-neon-magenta),
  var(--prism-neon-amber)
);
--prism-spectrum-vertical: linear-gradient(
  180deg,
  var(--prism-neon-ice),
  var(--prism-neon-cyan),
  var(--prism-neon-violet),
  var(--prism-neon-magenta)
);
```

**New glass tokens:**

```css
--glass-bg: rgba(12, 16, 32, 0.42);
--glass-bg-strong: rgba(12, 16, 32, 0.62);
--glass-border: rgba(255, 255, 255, 0.08);
--glass-border-strong: rgba(255, 255, 255, 0.12);
--glass-highlight: rgba(255, 255, 255, 0.06); /* inset top */
--glass-blur: 18px;
--glass-blur-strong: 26px;
--glass-saturate: 1.35;
--glass-radius: var(--r-lg);
```

**File split illustration:**

```css
/* tokens-base.css — no colors */
:root {
  --font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  --font-mono: 'SF Mono', ui-monospace, Menlo, monospace;
  --text-xs: 12px;
  --text-sm: 14px;
  --text-base: 16px; /* … */
  --s1: 4px;
  --s2: 8px;
  --s3: 12px;
  --s4: 16px; /* … */
  --r-sm: 6px;
  --r: 10px;
  --r-lg: 14px;
  --r-xl: 20px;
  --r-full: 999px;
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
  --fast: 120ms;
  --normal: 220ms;
  --slow: 400ms;
  --sidebar-w: 264px;
  --titlebar-h: 52px;
  --lane-h: 44px;
  --lane-gap: 6px;
}
@media (prefers-reduced-motion: reduce) {
  :root {
    --fast: 0ms;
    --normal: 0ms;
    --slow: 0ms;
  }
}

/* tokens-prism.css — colors + depth + glass */
:root,
:root[data-brand='prism'] {
  --bg-void: #000000;
  --bg-base: #05070a;
  --bg-panel: #0b0f1e; /* … full table above */
  --cyan: #5ad2dd;
  --purple: #a78bfa; /* … */
  --prism-neon-cyan: #5ad2dd;
  --prism-neon-violet: #7b5cff; /* … */
  --glass-bg: rgba(12, 16, 32, 0.42);
  --glass-blur: 18px; /* … */
  --shadow: 0 8px 24px rgba(0, 0, 0, 0.62);
  --glow-cyan: 0 0 0 1px var(--cyan-dim), 0 0 28px -8px var(--cyan);
}

/* tokens-murmur.css — same shape, current navy values */
:root[data-brand='murmur'] {
  --bg-void: #06080f;
  --bg-base: #0a0e18;
  --bg-panel: #0f1420; /* … exact current values */
  /* no --prism-* or --glass-* here (or set --glass-bg: var(--bg-panel) as no-op) */
}
```

### 3.3 Migration note

Existing `tokens.css` becomes a 3-line shim for one release (`@import './tokens-base.css'; @import './tokens-prism.css';`) so any lingering `import './design/tokens.css'` still works while implementer chases imports. After the split lands and `main.tsx` exclusively uses the brand-gated loader, delete `tokens.css` shim to avoid double-loading in dev HMR.

---

## 4) Glass / refraction system

### 4.1 Where the prism lives (placement strategy)

Prism is _not_ a floating window. It is an in-app design element in two forms:

| Variant              | Where                                                                                                                                        | Size                                                                                                                                                                                 | Z                                                              | Opacity / blend                                                                                                                                       | Purpose                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Background field** | `App.tsx` shell, `<PrismField variant="background" />` as first child of `.shell`, `position:fixed; inset:0; z-index:0; pointer-events:none` | Full viewport, canvas `width/height = devicePixelRatio * viewport`                                                                                                                   | behind `.content` and `Sidebar` (`z-index:0` vs content `z:1`) | `opacity: 0.14` idle, `0.22` when a run is live (energy-driven). Canvas is `filter: blur(18px)` + `saturate(1.1)` so field is atmospheric, not sharp. | Subliminal depth. The user _feels_ the prism without looking at it. The grid in `OnboardingScreen` and the orbs at `#06080f` are replaced by this field in Prism.                                                |
| **Hero prism**       | `OnboardingScreen.tsx` `.cinema .frame` — replace the static `SceneArt` + `.orbit` decorative orbs for Prism brand. `variant="hero"`         | Frame is `~ 420×420` circle, canvas is `512×512` (power-of-two, matches Metal offscreen), CSS circle mask via `border-radius:50%` + `overflow:hidden`. Rim is CSS glass (see below). | inside onboarding frame, `z:2`                                 | `opacity: 0.92` on hero, sharp (no blur).                                                                                                             | Onboarding's “galaxy marble” moment — the first thing a new user sees. Also reusable as empty-state accent (`RunsScreen` empty, `PipelineGraph` placeholder) when brand=prism, but hero is the primary instance. |
| **Header accent**    | `App.tsx` `.titlebar` bottom edge (1px line)                                                                                                 | 1px high, full width                                                                                                                                                                 | top of stacking context                                        | `background: var(--prism-spectrum); opacity:0.55`                                                                                                     | Thin spectral rule — the cheapest signal that Prism is on, visible even when WebGL is disabled/paused.                                                                                                           |
| **Glass cards**      | Every `.card` / `.panel` / `RunRow` / phase badge                                                                                            | card size                                                                                                                                                                            | card `z`                                                       | CSS glass (no WebGL per card — too expensive). Chromatic edge is a pseudo-element, not a canvas.                                                      | Scalable glass system — works even when PrismField is paused.                                                                                                                                                    |

Do not add a prism canvas per card. One background field + one hero at a time is the perf budget. Cards get _CSS chromatic_ — a 1px edge gradient that _implies_ refraction without a shader per element.

### 4.2 CSS glass — how cards/panels work in Prism

Base class (in `prism/prism.css`):

```css
[data-brand='prism'] .glass {
  position: relative;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border: 1px solid var(--glass-border);
  border-radius: var(--glass-radius);
  box-shadow:
    var(--shadow),
    inset 0 1px 0 var(--glass-highlight);
  overflow: hidden; /* clip chromatic edge */
  /* isolation creates a stacking context so backdrop-filter doesn't bleed */
  isolation: isolate;
}
[data-brand='prism'] .glass-strong {
  background: var(--glass-bg-strong);
  backdrop-filter: blur(var(--glass-blur-strong)) saturate(var(--glass-saturate));
  -webkit-backdrop-filter: blur(var(--glass-blur-strong)) saturate(var(--glass-saturate));
  border-color: var(--glass-border-strong);
}

/* Chromatic edge — 1px spectral rim, hidden by default, revealed on hover/focus */
[data-brand='prism'] .glass::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(
    135deg,
    var(--prism-neon-cyan),
    var(--prism-neon-violet),
    var(--prism-neon-magenta)
  );
  -webkit-mask:
    linear-gradient(#fff 0 0) content-box,
    linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  opacity: 0;
  transition: opacity var(--fast) var(--ease);
  pointer-events: none;
}
[data-brand='prism'] .glass:hover::after,
[data-brand='prism'] .glass:focus-within::after {
  opacity: 0.85;
}

/* Hover light-spread (see §5): inner highlight sweeps */
[data-brand='prism'] .glass::before {
  content: '';
  position: absolute;
  inset: 0;
  background: radial-gradient(
    600px circle at var(--mouse-x, 50%) var(--mouse-y, 50%),
    rgba(255, 255, 255, 0.06),
    transparent 40%
  );
  opacity: 0;
  transition: opacity var(--normal) var(--ease);
  pointer-events: none;
}
[data-brand='prism'] .glass:hover::before {
  opacity: 1;
}

/* Fallback when backdrop-filter unsupported or reduced-motion */
@supports not (backdrop-filter: blur(1px)) {
  [data-brand='prism'] .glass {
    background: var(--bg-panel);
  }
}
@media (prefers-reduced-motion: reduce) {
  [data-brand='prism'] .glass::after,
  [data-brand='prism'] .glass::before {
    display: none;
  }
  [data-brand='prism'] .glass {
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
```

`--mouse-x / --mouse-y` are set by a tiny `mousemove` listener on `.glass` containers (throttled to `rAF`, not per-pixel). If JS disabled, the `::before` simply never shows — graceful.

**Hero frame glass** adds an extra spectral rim that is always visible (not hover-only) and an outer glow:

```css
[data-brand='prism'] .prism-hero-frame {
  position: relative;
  border-radius: 50%;
  padding: 2px;
  background: var(--prism-spectrum);
  box-shadow:
    0 24px 64px rgba(0, 0, 0, 0.78),
    0 0 40px -12px rgba(90, 210, 221, 0.35);
}
[data-brand='prism'] .prism-hero-frame::after {
  /* inner glass ring inside the spectral border */
  content: '';
  position: absolute;
  inset: 2px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.1);
  pointer-events: none;
}
```

### 4.3 WebGL prism — porting OrbShader.metal / OrbRenderer ideas to GLSL

**Library choice: raw WebGL2, no three.js / babylon / regl.** Justification:

- Prism is a single fullscreen-triangle (or quad) fragment shader. Three.js would add ~600kB minified + its own scene graph, camera, and render loop we do not need. `regl` is lighter but still an abstraction.
- Electron's Chromium already exposes WebGL2 reliably on macOS (ANGLE → Metal). Raw `HTMLCanvasElement.getContext('webgl2')` is sufficient.
- Shared control over frame budget: we need explicit 30fps idle / 60fps hot throttling and `IntersectionObserver` / `document.hidden` pause — easier to own the `requestAnimationFrame` loop directly than fight a framework's loop.
- Tiny util budget: one `createProgram(gl, vsSource, fsSource)` helper (~40 lines), one `resizeCanvasToDisplaySize` helper, and `PrismMotion.ts`. No dependency.

If a helper is truly wanted, `gl-matrix` for `mat2` is 5kB, but the shader's `mat2` rotations can be inlined as `cos/sin` pairs — no lib needed.

**GLSL translation notes from Metal:**

| Metal                                                                       | GLSL ES 3.0 (WebGL2)                                                                                                                                                                                  | Keep numerically pinned?                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrbUniforms` struct → buffer(0)                                            | `uniform vec2 uRes; uniform vec3 uBg, uAnchor, uC0, uC1, uC2; uniform float uTime, uPhase, uAudio, uSpin, uArch, uLens;`                                                                              | Yes — keep `fract(sin(x)*43758.5453)` hash verbatim. Metal note about `MTL_FAST_MATH: NO` applies to GLSL too: the starfield hash is fragile. In WebGL, `precision highp float` is mandatory; do not use `mediump` or starfield diverges visibly. |
| `MTL_FAST_MATH: NO` build flag                                              | `precision highp float;` + never enable `OES_standard_derivatives` fast paths that fuse `sin`                                                                                                         | Add comment `// keep highp — fract(sin*43758.5453) diverges on mediump`                                                                                                                                                                           |
| `[[stage_in]] OrbVertexOut` + `orbVertex`                                   | Vertex shader passthrough: `in vec2 aPos; in vec2 aUv; out vec2 vUv; void main(){ vUv=aUv; gl_Position=vec4(aPos,0,1);} ` with fullscreen triangle strip (4 verts) or 3-vert triangle covering screen | Use 3-vert fullscreen triangle (less overdraw) — but 4-vert strip is fine and matches Metal verbatim. Pick one, document.                                                                                                                         |
| `refract`, `fract`, `mix`, `smoothstep`, `step`, `clamp`                    | Same names in GLSL                                                                                                                                                                                    | Direct port, line-for-line comparable — keep file layout mirroring Metal so diffs stay readable.                                                                                                                                                  |
| Premultiplied alpha disc edge `coverage = 1 - smoothstep(0.988,1.0,radius)` | Same, but in fragment `gl_FragColor = vec4(color*coverage, coverage)` — hero variant uses `discard` alternative?                                                                                      | Hero uses coverage alpha; background field uses additive `mix(bg, prism, coverage)` because it composites over `#000` body, not transparent panel.                                                                                                |
| `float3/float2/float2x2`                                                    | `vec3/vec2/mat2`                                                                                                                                                                                      |                                                                                                                                                                                                                                                   |

**Fragment shader structure (PrismShader.ts exports `PRISM_FRAGMENT_GLSL`):**

```glsl
precision highp float;
// uniforms: uRes, uBg, uAnchor, uC0, uC1, uC2, uTime, uPhase, uAudio, uSpin, uArch, uLens
// varyings: vUv

float h1(float x){ return fract(sin(x*127.1)*43758.5453); }

// starfield(vec3 n, float t) → vec4(col, weight)  — ~120 lines, port Metal verbatim
vec4 starfield(vec3 n, float t){ /* … see OrbShader.metal: starfield … */ }

// sphereAt(vec3 n, float spin, float t) → vec4
vec4 sphereAt(vec3 n, float spin, float t){ /* roll+tilt+spin rotations, call starfield */ }

// shade(vec2 p) → vec3  — refraction prism: fresnel + refract + double sphere + aurora + meteor + lighting
vec3 shade(vec2 p){
  float r = length(p);
  float t = uTime*0.8 + uPhase;
  float rr = min(r, 0.9995);
  float z = sqrt(1.0 - rr*rr);
  vec3 n = vec3(p, z);
  float fresnel = pow(1.0 - z, 2.4);
  vec3 ray = refract(vec3(0,0,-1), n, 0.75); // IOR 1.33-like, keep Metal's 0.75
  // … front/back sphere, voidColor mix, aurora, meteor, diffuse, voiceColor, rim lights …
}

// main():
//   vec2 p = vUv*2.0 - 1.0;  // hero: keep disc mask; background: no mask, full-bleed with vignette
//   vec3 col; if(uLens>0.0){ /* chromatic lens split: shade(p*(1-lens*red)).r etc. */ } else col=shade(p);
//   float coverage = hero ? 1.0 - smoothstep(0.988,1.0,length(p)) : 1.0;
//   // hero: premultiplied disc; background: blend into void with vignette falloff
```

**Prism-specific tuning vs orb galaxy:**

- Keep `starfield` and `sphereAt` largely intact — they are the “wild imagination” part and already cinematic. The risk of rewriting is losing the numerical pin.
- Tune `shade` for prism vs galaxy: increase `fresnel` exponent bias toward edge, add a **prism dispersion** pass when `uLens > 0` that offsets R/G/B lookups by `lens * vec2(offset)` — Metal already has this (RGB split via `point*(1-lens*red/green/blue)`). For Prism, make this _more pronounced_ on hero (chromatic offset `1.4–2.0px` equivalent in UV space) and subtle on background field.
- Add a **faceted highlight**: 3–5 short hard specular lines (spike pattern from Metal's `spike = exp(-dx²*1200)*exp(-dy²*26)+…`) but biased to prism edges (triangular). Keep subtle — hero only.
- Background field variant: disable the expensive inner `for(int s=0;s<3;s++)` star loop at `s==2` when `uRes.y < 800` or when `uAudio < 0.05` (LOD). Background is blurred anyway — grain is wasted pixels.

**Uniforms — explain each:**

| Uniform             | Type    | Source                                                                                                  | Meaning                                                                                                                                            |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uRes`              | `vec2`  | canvas `width,height` (device pixels)                                                                   | Resolution for grain density and `smoothstep` feather tuning.                                                                                      |
| `uBg`               | `vec3`  | Prism tokens: `#000000` for hero edge, `#05070A` for field base — passed as normalized RGB              | Background void color mixed in `shade`.                                                                                                            |
| `uAnchor`           | `vec3`  | `#101632` (OrbPalette anchor) remapped to Prism's void-adjacent `#0B0F1E` normalized                    | Deep shadow anchor for `mix(uAnchor*0.04, uAnchor*0.35, fresnel)`.                                                                                 |
| `uC0,uC1,uC2`       | `vec3`  | `--prism-neon-cyan` `#5AD2DD`, `--prism-neon-violet` `#7B5CFF`, `--prism-neon-ice` `#B8F1FF` normalized | Accent trio cycled via `mix(mix(uC0,uC1,v1), mix(uC1,uC2,v3), …)`. Prism's spectrum is built here.                                                 |
| `uTime`             | `float` | `performance.now()/1000 + timeOffset` (from PrismMotion)                                                | Monotonic clock driving drift, aurora, meteor.                                                                                                     |
| `uPhase`            | `float` | Seeded `[0,1)` from install (FNV-1a)                                                                    | Personality seed — decorrelates band/nebula/archetype per install.                                                                                 |
| `uAudio`            | `float` | `PrismMotion.audioSmooth` (0…1)                                                                         | Energy pushed by app activity (see §4.7). Drives glow/aurora/pulsar/meteor intensity.                                                              |
| `uSpin`             | `float` | `PrismMotion.spin` (radians)                                                                            | Yaw driven by motion model, not wall clock — feels inertial.                                                                                       |
| `uArch`             | `float` | `-1` (derive from phase) or `0…3`                                                                       | Archetype selector (nebula/core/deep) — keep `-1` for Prism hero (phase-derived variety). Background field can lock to `1` (core) for calmer look. |
| `uLens`             | `float` | `0` idle, `0.12–0.18` on hover/press, `0` when reduced-motion                                           | Chromatic lens strength — RGB split amount. Metal's `uLens` already exists; Prism leans on it harder.                                              |
| `uMouse` (optional) | `vec2`  | normalized `0…1` mouse inside canvas rect                                                               | For hero parallax: subtle `p += (uMouse-0.5)*0.02` offset — not in Metal, added for Prism interactivity. Throttled.                                |

**Canvas & context setup (PrismField.tsx):**

```ts
const canvas = ref.current!;
const gl = canvas.getContext('webgl2', {
  alpha: true, // hero needs disc alpha; background uses alpha false but keep true for fade
  antialias: false, // we handle AA via smoothstep coverage, not MSAA (cheaper on OLED)
  premultipliedAlpha: true, // hero disc is premultiplied
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
}) as WebGL2RenderingContext | null;
if (!gl) {
  showFallbackGradient();
  return;
}
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied
```

**Reduced-motion fallback:**

- Detect `window.matchMedia('(prefers-reduced-motion: reduce)').matches` at mount. If true: do not create WebGL context at all. Render a static CSS gradient instead:

  ```css
  .prism-fallback {
    background:
      radial-gradient(ellipse at 30% 20%, rgba(90, 210, 221, 0.18), transparent 55%),
      radial-gradient(ellipse at 80% 70%, rgba(123, 92, 255, 0.16), transparent 60%),
      radial-gradient(ellipse at 50% 90%, rgba(255, 59, 154, 0.1), transparent 65%),
      linear-gradient(180deg, #000000 0%, #05070a 100%);
  }
  ```

  No `requestAnimationFrame`, no shader, one paint.

- Also expose a `prefers-reduced-transparency` check (where supported) to disable `backdrop-filter`.

### 4.4 PrismMotion — port of OrbMotion to TypeScript

Create `src/renderer/components/prism/PrismMotion.ts` as a pure class (no React, no WebGL) that is unit-testable against `OrbMotion.swift` / `website orb-renderer.ts`.

```ts
export class PrismMotion {
  readonly phase: number; // 0…1 seeded
  readonly timeOffset: number; // seconds decorrelating clocks
  spin = 0;
  spinVelocity = 0;
  spinDirection: 1 | -1 = 1;
  audioSmooth = 0;
  audioFast = 0;
  private prevAudio = 0;
  private flipQueued = false;
  private oscillatorSign: 1 | -1 | 0 = 1;
  private lastTime: number | null = null;

  constructor(seed: string) {
    const h = fnv1a32(seed); // FNV-1a 32-bit, same as Swift
    this.phase = (h % 100000) / 100000; // or h/2^32 — match Swift's normalization exactly
    // timeOffset: hash-derived, 0…20s, so two prisms never sync
    this.timeOffset = ((h >>> 8) % 20000) / 1000;
  }
  update(time: number, audio: number): void {
    const dt = this.lastTime != null ? Math.min(0.1, Math.max(0, time - this.lastTime)) : 0;
    this.lastTime = time;
    const level = Math.min(1, Math.max(0, audio));
    // asymmetric envelopes — MUST match Swift constants
    const smoothResp = level > this.audioSmooth ? 0.11 : 0.3;
    this.audioSmooth += (level - this.audioSmooth) * (dt > 0 ? 1 - Math.exp(-dt / smoothResp) : 0);
    const fastResp = level > this.audioFast ? 0.04 : 0.18;
    this.audioFast += (level - this.audioFast) * (dt > 0 ? 1 - Math.exp(-dt / fastResp) : 0);
    // oscillator + queued flip
    const variance = (6.31 * this.phase) % 1;
    const osc = Math.sin(time * (0.45 + 0.2 * variance) + this.phase);
    const sign = osc > 0 ? 1 : osc < 0 ? -1 : 0;
    if (sign !== this.oscillatorSign) {
      this.oscillatorSign = sign as any;
      this.flipQueued = true;
    }
    if (this.flipQueued && this.audioFast < 0.08) {
      this.spinDirection *= -1;
      this.flipQueued = false;
    }
    const base = 0.18 + 0.22 * Math.abs(Math.sin(time * 0.09 + this.phase));
    const targetVel = this.spinDirection * (base + 1.2 * this.audioSmooth);
    this.spinVelocity += (targetVel - this.spinVelocity) * (dt > 0 ? 1 - Math.exp(-dt / 0.35) : 0);
    const attack = Math.max(0, this.audioFast - this.prevAudio);
    this.prevAudio = this.audioFast;
    this.spinVelocity += this.spinDirection * Math.min(6 * attack, 1.4) * dt * 14;
    this.spin += this.spinVelocity * dt;
  }
}
function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
```

Wire energy: `PrismField` receives `energy` prop (0…1) from parent — background field computes it from live run state (`isRunning ? 0.45 : 0.08`, plus `menuOpen ? 0.2`). Hero is `0.12` idle. Map to `PrismMotion.update(time, energy)` each frame, then upload `uAudio = motion.audioSmooth`, `uSpin = motion.spin`.

Seed source (see §4.7): derive from `settings.engineerName + '|' + brand + '|' + stableInstallId` — `stableInstallId` is a UUID written once to `localStorage` or to `settings` if you add a `prismSeed` field (preferred: add `prismSeed?: string` to `AppSettings` so it survives reinstalls that clear localStorage but not `~/Library/Application Support`).

### 4.5 Placement wiring — where PrismField mounts

- **`src/renderer/App.tsx`**: add `<PrismField variant="background" energy={liveEnergy} seed={seed} />` as first child of `.shell`, before `Sidebar`/`content`. Guard with `brand==='prism'` (read from `location.search` via `useBrand()`). When `brand!=='prism'`, render nothing — zero cost.

- **`src/renderer/screens/OnboardingScreen.tsx`**: inside `.cinema .frame`, conditional:

  ```tsx
  {brand==='prism'
    ? <div className="prism-hero-frame"><PrismField variant="hero" seed={seed} energy={0.12} /></div>
    : <><SceneArt …/><div className="orbit">…</div></>
  }
  ```

  Keep the existing `.grid` and `.orb-a/b/c` CSS orbs for Murmur — Prism's background field replaces them functionally, so hide them behind `data-brand`:

  ```css
  [data-brand='prism'] .onboarding .orb,
  [data-brand='prism'] .onboarding .grid {
    display: none;
  }
  ```

- **Reduced-motion**: both placements check `useReducedMotion()` — if true, render `<div className="prism-fallback">` instead of canvas.

### 4.6 Library choice — why no heavy dep

Already justified in §4.3: raw WebGL2 wins. To make it explicit for the implementer:

- **Do not add `three`**, `babylonjs`, `ogl`, `twgl.js`, or `regl`. The shader is a single pass with no geometry, lights, or cameras. Those libs would be dead weight and complicate the FPS budget (they own the loop).
- **Allowed tiny util:** a `createShader`/`createProgram` helper (30–50 lines, inline in `PrismShader.ts`) and optionally a 1-file `resizeCanvasToDisplaySize` util. No npm install.
- **If you must have a helper, use the 2kB `gl` utils already in `website orb-renderer.ts`** — copy that file's `compileShader`/`linkProgram` as the reference, not a lib.

### 4.7 Seeding personality — deterministic per install

- Add `prismSeed?: string` to `AppSettings` (`src/shared/types.ts` + `src/main/store/settings.ts` migrate). On first Prism launch (brand already `prism` and `prismSeed` missing), generate `crypto.randomUUID()` and `patchSettings({ prismSeed })`. Keep it — this is the install's fingerprint for `PrismMotion.phase`.
- Fallback seed string for shader `uPhase`: `prismSeed ?? engineerName ?? 'prism-default'`. Hash via FNV-1a (matching Swift's `hashSeed`), so the same seed yields the same galaxy/personality across restarts — deterministic but not boring.
- Document that changing `engineerName` does not re-seed (seed is independent) — personality sticks with the install, not the name.

---

## 5) Animations

All animations respect `prefers-reduced-motion` (media query zeroes durations, WebGL fallback shows static gradient). FPS budget: **30fps idle, 60fps hot**, pause when occluded/hidden — same as `OrbRenderer`.

### 5.1 Idle prism shimmer (background field + hero)

- **What:** Slow drift of the galaxy inside the prism — `uTime` advancing at `0.8×` wall clock, plus phase-warped `warpedTime`, plus `spin` from `PrismMotion`. Aurora `speech` pattern breathes (`sin(t*0.4)`, `sin(t*1.1)`), starfield twinkles per-cell (`sin(t*1.5+hx*40)`), meteor streaks on a `4.5+3.5*fract(phase*4.91)` cadence.
- **Timing:** Continuous. `rAF` loop advances `PrismMotion.update(time, energy)` with `energy=0.06–0.12` idle. Easing is in the motion model, not CSS.
- **FPS:** 30fps idle (throttle via `if (now - lastFrame < 33ms) return`). Hero can be 30fps too — it is large but single canvas. Only boost to 60fps when `energy>0.25` (run live, hover hot).
- **CSS complement:** Background canvas `filter: blur(18px)` is static — no CSS animation on the canvas element itself (blur animates expensively). Opacity fade-in on mount is `400ms var(--ease)`.

### 5.2 Hover light-spread (glass cards)

- **What:** On `.glass:hover`, two effects:
  1. Chromatic edge `::after` fades in (`opacity 0→0.85`, `120ms var(--ease)`).
  2. Inner light pool `::before` (`radial-gradient(600px at var(--mouse-x) var(--mouse-y), rgba(255,255,255,0.06), transparent 40%)`) fades in (`220ms var(--ease)`), position follows mouse via `mousemove` → `element.style.setProperty('--mouse-x', e.offsetX + 'px')` throttled to `rAF`.
- **Easing:** `--ease` (`cubic-bezier(0.32,0.72,0,1)`) — same curve as the rest of app, so hover feels native.
- **FPS:** CSS-only (composited). No JS per-frame cost beyond throttled mouse coords.

### 5.3 Button press chromatic burst

- **What:** On `.btn.primary:active` (and glass cards with press), a 120ms burst: `text-shadow` or `box-shadow` chromatic split (`R +1.4px, B −1.4px`) plus `transform: scale(0.98)` for tactile feedback. For primary buttons, also flash `uLens` to `0.16` for one frame if a PrismField is visible — prism “reacts” to clicks.
- **Timing:** `120ms ease-out` burst, then `220ms ease` return. Feels like a shutter.
- **Where defined:** `prism/prism.css`:
  ```css
  [data-brand='prism'] .btn.primary:active {
    transform: scale(0.98);
    box-shadow:
      1.4px 0 0 rgba(255, 59, 154, 0.35),
      /* magenta split */ -1.4px 0 0 rgba(90, 210, 221, 0.35),
      /* cyan split */ var(--prism-glow-cyan);
    transition:
      transform 120ms ease-out,
      box-shadow 120ms ease-out;
  }
  ```

### 5.4 Focus / active spectral edge

- **What:** `:focus-visible` on glass cards and inputs shows a 2px spectral border (`background: var(--prism-spectrum)` via `::after` padding trick) instead of the current `outline:2px solid var(--cyan)`. Keep `outline` as fallback for a11y, but hide when `.glass:focus-within::after` is visible:
  ```css
  [data-brand='prism'] .glass:focus-within {
    outline: none;
  }
  [data-brand='prism'] .glass:focus-within::after {
    opacity: 1;
    background: var(--prism-spectrum);
  }
  ```
- **Timing:** `120ms`.

### 5.5 Background subtle parallax (mouse / scroll)

- **What:** Background field `PrismField` listens to `mousemove` on `.shell` (throttled, passive) and nudges `uMouse` → `p += (uMouse-0.5)*0.015` in fragment shader (tiny — 1.5% of viewport). Gives the void a parallax depth without moving DOM.
- **Budget:** Only when `energy<0.2` and not occluded. Disabled on reduced-motion. Listener is `passive` and updates a uniform, not layout.
- **Alternative / complement:** On scroll in `RunsScreen` / `InspectorScreen`, the field's `transform: translateY(scrollTop * -0.04)` adds parallax, but keep CSS `transform` (composited) — do not re-render WebGL per scroll pixel. WebGL parallax is mouse-only.

### 5.6 Run-live energy lift

- **What:** When a run is `running` (poll `runs/list` or `run/detail` status), background field `energy` ramps `0.12→0.45` over `600ms`. Motion model raises `audioSmooth`/`audioFast`, shader brightens aurora/meteor/pulsar, `blur` tightens `18px→14px`, opacity lifts `0.14→0.22`. Sidebar's live indicator (if any) pulses `cyan` with `pulse` keyframe but now with spectral tint.
- **Timing:** Ramp `600ms ease`, decay `900ms ease` after run settles (`accepted/rejected/failed`). Matches `OrbMotion` envelope decays (0.30s smooth, 0.18s fast) — feels like the factory breathing harder.

### 5.7 Global FPS budget & pause rules (copy OrbRenderer's discipline)

| Condition                                                                    | FPS                 | What happens                                                                                                                             |
| ---------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Document hidden (`document.hidden`)                                          | 0                   | Cancel `rAF`, no GL calls. Resume on `visibilitychange`.                                                                                 |
| Canvas not intersecting viewport (`IntersectionObserver` with `threshold:0`) | 0                   | Same — pause. Hero when onboarding is not visible is auto-paused.                                                                        |
| Idle (no run live, no hover, no press)                                       | **30fps**           | Throttle: `if (now - last < 33ms) return;`                                                                                               |
| Hot (run live OR hover on glass OR burst window)                             | **60fps**           | `if (now - last < 16ms) return;`                                                                                                         |
| `prefers-reduced-motion: reduce`                                             | 0 + static fallback | Do not create `rAF` at all; render fallback gradient.                                                                                    |
| WebGL context lost (`webglcontextlost`)                                      | 0 + fallback        | Listen for `canvas.addEventListener('webglcontextlost', e=>{e.preventDefault(); showFallback()})` and `webglcontextrestored` to re-init. |

Also: `canvas.width/height` set to `clientWidth * devicePixelRatio` capped at `512` for background field on large screens? For hero, cap at `512` (matches Metal offscreen). For background field, cap at `1024` width to avoid 4k canvas — blur hides the resolution anyway. Use `gl.viewport(0,0,canvas.width,canvas.height)` each frame.

---

## 6) File manifest — every file to create/modify with 1-line purpose

### 6.1 New files (create)

| Path                                             | Purpose                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/design/tokens-base.css`            | Structural tokens only (spacing, radii, type, motion, layout). No colors.                                                                                                                                                                                |
| `src/renderer/design/tokens-prism.css`           | All Prism color/depth/glass/spectral tokens (`--bg-*`, `--line-*`, `--text-*`, `--cyan` etc. overrides + `--prism-*` + `--glass-*`). Guarded by `:root, :root[data-brand="prism"]`.                                                                      |
| `src/renderer/design/tokens-murmur.css`          | Murmur color tokens (exact current `tokens.css` color values) under `:root[data-brand="murmur"]`. Prevents Prism edits regressing Murmur.                                                                                                                |
| `src/renderer/design/prism/prism.css`            | Prism chrome: `.glass`, `.glass-strong`, chromatic edge `::after`, hover light `::before`, `.prism-hero-frame`, header spectral rule, scrollbar/focus tints.                                                                                             |
| `src/renderer/design/prism/prism-animations.css` | (or folded into `prism.css`) Keyframes `prism-drift`, `prism-burst`, `spectral-sweep` + `@media (prefers-reduced-motion)` overrides.                                                                                                                     |
| `src/renderer/components/prism/PrismField.tsx`   | React wrapper for the WebGL canvas — mounts GL, drives `PrismMotion` rAF loop, handles `visibilitychange`/`IntersectionObserver`/`webglcontextlost`, fades in, falls back to CSS gradient on reduced-motion or GL failure. Props: `variant: 'background' | 'hero'`, `energy: number`, `seed: string`. |
| `src/renderer/components/prism/PrismShader.ts`   | GLSL source strings (vertex + fragment) + `compileShader`/`createProgram`/`getUniformLocations` helpers + `resizeCanvasToDisplaySize`. Keeps shader as a TS string so Vite bundles it; no separate `.glsl` loader needed.                                |
| `src/renderer/components/prism/PrismMotion.ts`   | Pure TS port of `OrbMotion.swift` — seeded FNV-1a, `phase`/`timeOffset`/`spin`/`audioSmooth`/`audioFast`/`flipQueued`/`oscillatorSign` state, `update(time,audio)` with asymmetric envelopes. No DOM/GL imports.                                         |
| `src/renderer/hooks/usePrismMotion.ts`           | (optional, or inline in PrismField) Hook tying `PrismMotion` to `rAF` + `timeOffset` + `energy` prop — returns `{ spin, audioSmooth }` per frame.                                                                                                        |
| `src/renderer/hooks/useBrand.ts`                 | Tiny hook: `const brand = useBrand()` reads `location.search` `?brand=` (or `settings.brand` via `useApp()` after mount). Used to gate PrismField rendering and hero conditional.                                                                        |
| `src/renderer/hooks/useReducedMotion.ts`         | Hook wrapping `matchMedia('(prefers-reduced-motion: reduce)')` + listener — consumed by PrismField and prism.css JS (mouse tracking).                                                                                                                    |
| `src/renderer/components/prism/GlassCard.tsx`    | (optional) Wrapper `<div className="glass">` that wires `mousemove → --mouse-x/--mouse-y` and `IntersectionObserver` — so card consumers don't each reimplement hover light tracking.                                                                    |
| `docs/plans/prism-theme-plan.md`                 | This file (copy from `/tmp/prism-theme-plan.md`).                                                                                                                                                                                                        |

### 6.2 Modified files

| Path                                                                                        | One-line change                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/main.tsx`                                                                     | Gate CSS loading on `?brand=` query param + `data-brand` attribute before `createRoot`; dynamic `import()` of `tokens-prism.css` vs `tokens-murmur.css` + `tokens-base.css` + `prism/prism.css`. Adds async entry wrapper if top-level await unavailable. |
| `src/renderer/index.html`                                                                   | Add `<meta name="color-scheme" content="dark">` + blocking `<style>html:not([data-brand]) #app{visibility:hidden}; html{background:#000}</style>` FOUC guard; keep CSP `style-src 'unsafe-inline'` (already allows it).                                   |
| `src/renderer/App.tsx`                                                                      | Mount `<PrismField variant="background">` behind shell when `brand==='prism'`; add header spectral 1px rule (`<div className="prism-header-rule">` under titlebar).                                                                                       |
| `src/renderer/screens/OnboardingScreen.tsx`                                                 | Conditional hero: `brand==='prism'` renders `prism-hero-frame > PrismField variant="hero"` instead of `.orbit` + static `SceneArt`; hide `.orb/.grid` on Prism, verify single background instance (not per-screen)                                        | 0.5 day | 0.5 day |
| `src/renderer/design/tokens.css`                                                            | Turn into 3-line shim re-exporting `tokens-base.css` for one release, then delete after migration (or keep as deprecated import path).                                                                                                                    |
| `src/main/main.ts`                                                                          | `createWindow(brand: BrandId)` reads `settings.get().brand` synchronously before window opts; sets `backgroundColor`/`vibrancy`/`visualEffectState` per brand; passes `?brand=` via `loadURL`/`loadFile({query})`; calls `applyBrandDockIcon()` still.    |
| `src/main/context.ts`                                                                       | No change needed for `assetUrl` (already brand-aware) but verify `brandedCandidates` covers `prism/` hero assets if any new assets added; add `prismSeed` handling if storing seed in settings (see below).                                               |
| `src/shared/types.ts`                                                                       | Add `prismSeed?: string` to `AppSettings` (optional but recommended for stable personality).                                                                                                                                                              |
| `src/main/store/settings.ts`                                                                | `appSettingsSchema` adds `prismSeed: z.string().optional()`; `defaultSettings()` adds `prismSeed: undefined`; `migrate()` preserves it; add `genPrismSeed()` helper if needed.                                                                            |
| `src/renderer/screens/SettingsScreen.tsx`                                                   | `applyBrand` shows “Relaunch to apply” banner with `api.app.relaunch()` button (reuse `brand-relaunch` style); keep `applyDockIcon` best-effort toast. Do not auto-relaunch.                                                                              |
| `src/renderer/stores/app.tsx`                                                               | No change required, but document that `settings.brand` drives `useBrand()` fallback — `api.on('settings-changed')` already refreshes.                                                                                                                     |
| `electron.vite.config.ts`                                                                   | No change (alias already covers new paths). Verify `renderer.build.rollupOptions.input` still `index.html` — dynamic CSS imports are code-split automatically.                                                                                            |
| `src/renderer/components/Sidebar.tsx` / `RunsScreen.tsx` / `InspectorScreen.tsx` (optional) | Add `className="glass"` to cards where glass should appear (or rely on `[data-brand="prism"] .card { @extend .glass }` via CSS). Prefer adding `.glass` in JSX conditionally on brand to avoid global `.card` mutation for Murmur.                        |
| `package.json`                                                                              | No new deps. If `prismSeed` needs `uuid`, use `crypto.randomUUID()` (available in Electron 30+), no package.                                                                                                                                              |

### 6.3 Untouched (verify, do not modify)

- `src/main/engine/*`, `src/main/cli/*`, `src/main/trace/*`, `src/main/ipc/*` (except the relaunch banner text) — engine invariants must not be touched for a theme.
- `src/preload/bridge.cjs` — keep CJS, named invoke. Do not add a generic brand getter there unless `?brand=` query param proves insufficient.
- `.claude/skills/sssf/*` — reference only, per `AGENTS.md` rule.

---

## 7) Risks & verification

### 7.1 What could break

| Risk                                                        | Likelihood                                     | Impact                                                                                                      | Mitigation                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FOUC / flash of wrong brand**                             | High if `data-brand` set after first paint     | User sees navy → black snap on every launch; feels broken.                                                  | Checklist in §2.4: `data-brand` before `createRoot`, query param sync, blocking `visibility:hidden` guard, `backgroundColor` matching `--bg-void`. Test both `npm run dev` (loadURL) and `npm run build && npm start` (loadFile).                              |
| **Shader compile fail on older GPU / WebGL2 missing**       | Medium                                         | Black rectangle or transparent void where prism should be; hero empty.                                      | Guard: `if (!gl) showFallback()`. Try/catch `createProgram` link errors; log `gl.getShaderInfoLog`. Fallback gradient must be visually complete (not “missing shader” look). Test on Intel Mac (ANGLE) and disable WebGL in devtools to force fallback.        |
| **High-DPI canvas OOM / jank**                              | Medium                                         | 4k canvas at `devicePixelRatio=2` is `3840×2160×4 bytes ≈ 33MB` per frame; blur + rAF can jank.             | Cap canvas backing store: `Math.min(canvas.clientWidth*dpr, 1024)` for background, `512` for hero. Disable `antialias`, use `powerPreference:'high-performance'`. Background is blurred anyway — resolution beyond 1024 is wasted.                             |
| **Perf / battery — rAF never sleeps**                       | High if pause rules missing                    | 30/60fps loop drains battery even when window occluded/minimized.                                           | Implement all pause rules (§5.7): `document.hidden`, `IntersectionObserver`, `webglcontextlost`, page `visibilitychange`. Verify via Activity Monitor Energy tab and `chrome://gpu` frame counters.                                                            |
| **`precision mediump` hash divergence**                     | High if shader omits `precision highp float`   | Starfield looks visibly different from Metal reference (clumpy, shifted) — diverges from sibling GLSL port. | Add `precision highp float;` at top of fragment shader with comment citing `MTL_FAST_MATH: NO` landmine. Keep `fract(sin*43758.5453)` exactly.                                                                                                                 |
| **`loadFile({query})` not supported in older Electron**     | Low (Electron 28+ required, Foundry uses 43.3) | Brand param missing in packaged build → `location.search` empty → wrong CSS.                                | Fallback: also read `window.process?.argv` via `additionalArguments: ['--brand=prism']` and parse in preload if `location.search` empty. Test packaged build.                                                                                                  |
| **CSP blocks inline `<style>` FOUC guard**                  | Low                                            | Guard style not applied → FOUC still.                                                                       | CSP already allows `style-src 'unsafe-inline'` (see `index.html`), so allowed. Keep guard as `<style>` not `<style nonce>`.                                                                                                                                    |
| **Vite HMR loads both brand CSS in dev**                    | Medium                                         | Dev shows mixed tokens if both `tokens-prism.css` and `tokens-murmur.css` are bundled.                      | Dynamic `import()` code-splits — Vite's dev server respects branch (only the taken import loads). But if implementer accidentally uses static `import './tokens-prism.css'` at top, both load. Lint rule: no static brand CSS imports outside `main.tsx` gate. |
| **Glass `backdrop-filter` unsupported / flickers on Intel** | Medium (Intel UHD 630)                         | Glass falls back to solid or flashes white.                                                                 | `@supports not (backdrop-filter: blur(1px))` fallback to `var(--bg-panel)`. Test on non-Apple-Silicon. Also guard with `prefers-reduced-transparency` if available.                                                                                            |
| **Murmur regression — Prism tokens leak**                   | High if `tokens.css` split is wrong            | Murmur users see black void or magenta tints.                                                               | `tokens-prism.css` scoped to `:root, :root[data-brand="prism"]`; `tokens-murmur.css` scoped to `:root[data-brand="murmur"]`; never use global `:root` alone for colors after split. Manual visual pass on Murmur before merge.                                 |
| **Seed instability — personality changes on rename**        | Low if `prismSeed` not added                   | User expects stable prism but it shifts when they rename engineerName.                                      | Store `prismSeed` in `AppSettings` (persistent under `~/Library/Application Support/foundry/settings.json`), not derived from `engineerName` alone. `engineerName` fallback only if seed missing.                                                              |
| **Mouse tracking leaks / rAF spam on many glass cards**     | Low                                            | Each `.glass` adding a `mousemove` listener → O(n) handlers.                                                | Single delegated listener on `.shell` or per-card throttled to `rAF` via `requestAnimationFrame` flag, not per-pixel `setProperty`. Use `GlassCard` wrapper to centralize.                                                                                     |
| **Reduced-motion not respected**                            | High if forgotten                              | Motion-sensitive users get vestibular trigger; accessibility failure.                                       | Two guards: CSS `@media (prefers-reduced-motion: reduce)` zeroes `--fast/--normal/--slow` and hides glass pseudo-elements; JS `useReducedMotion()` prevents WebGL init and mouse parallax. Test with macOS Settings → Accessibility → Reduce motion on.        |

### 7.2 Verification — how to know it worked

**Automated (must pass before PR):**

```bash
cd apps/desktop
npm run typecheck   # no new any, BrandId narrowing correct
npm run lint        # max-warnings 0 — new components must satisfy eslint-plugin-react-hooks
npm run format:check
npm run knip        # no unused files — tokens shim is used, PrismField imported
npm test            # existing suites (brand-icons.test.ts must still pass — Prism pack exists)
npm run build       # production bundle — verify both brand CSS chunks emitted:
                    #   out/renderer/assets/tokens-prism-*.css
                    #   out/renderer/assets/tokens-murmur-*.css
npm run audit:deps  # no new deps, so trivially passes
```

Add a tiny Vitest for `PrismMotion` (optional but recommended): port `OrbMotionTests` assertions — `spin` advances, `audioSmooth` asymmetry, queued flip only when quiet.

**Manual visual checks (record a 20s clip for the PR description):**

1. **Cold launch Prism:** `settings.brand=prism` → quit → `npm run build && npm start` (or `npm run dev`) → window opens with _no_ white or navy flash; `backgroundColor` is pure black; `.shell` background is `#000`; `data-brand="prism"` on `<html>` within 50ms (check via `document.documentElement.dataset.brand` in devtools before React mounts).
2. **Onboarding hero:** fresh install (or `settings.onboarded=false`) → onboarding frame shows faceted prism hero (not the old `.orbit` dots); hero shimmers slowly; hovering hero increases chromatic lens subtlety; no jank at 30fps.
3. **Background field:** after onboarding done → main Runs view → faint prism field behind sidebar/content at `opacity ~0.14`, blurred; start a run (or mock `energy=0.5`) → field brightens, sharpens slightly, motion speeds to 60fps; kill run → decays to idle over ~1s.
4. **Glass cards:** hover any `.card.glass` (Runs list, phase drawer) → chromatic edge fades in 120ms + light pool follows mouse; press primary button → burst + hero chromatic pulse; `Tab` focus shows spectral edge, not cyan outline.
5. **Relaunch flow:** Settings → General → switch Prism↔Murmur → banner appears “Relaunch to apply theme” with `Relaunch` button; clicking calls `api.app.relaunch()` and window reopens with new palette, dock icon swapped, `backgroundColor` updated, no FOUC; `settings-changed` broadcast does not flicker pre-relaunch (CSS still old until relaunch — correct).
6. **Reduced motion:** macOS System Settings → Accessibility → Display → Reduce motion ON → relaunch Prism → no WebGL canvas, static fallback gradient visible, no `rAF`, glass `backdrop-filter` disabled, durations 0ms (hover edge appears instantly or not at all — acceptable).
7. **Packaged path:** `npm run package` → open `Foundry.app` → brand still Prism, assets load from `assets/brands/prism/**` (check `assetUrl('scenes/onboarding-hero.png')` resolves to `…/brands/prism/scenes/onboarding-hero.png` via `file://` URL, not 404).
8. **Fallback path:** open devtools → `WEBGL_debug_renderer_info` or manually `canvas.getContext('webgl2')` → null injection → PrismField shows CSS fallback gradient, not empty black circle.
9. **Murmur not regressed:** set brand to murmur → relaunch → `backgroundColor #06080f`, `vibrancy under-window` restored, glass not present, `.orb/.grid` decorative orbs visible in onboarding, no prism canvas, no `--prism-*` vars leaking (check via devtools computed style).

Performance spot-checks: Activity Monitor → Foundry Energy Impact idle ~2–4, hot ~8–12; Chrome devtools Performance → `PrismField` rAF handler <3ms/frame idle, <6ms hot; no `setInterval` leaks after navigation.

---

## 8) Effort estimate & ordering

Rough LOE for a single implementer who can run `npm run check` locally and has a macOS test machine. Assumes `b59f998` dual-brand plumbing is on `main` and `assets/brands/prism/**` listing is already verified (1024² agents, 2752×1536 scenes).

| Order  | Task                                                                                                                                                                                                                                                                                                                                           | Scope      | Estimate     |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------ |
| **1**  | **Scaffold tokens split** — create `tokens-base.css`, `tokens-prism.css`, `tokens-murmur.css`, shim `tokens.css`, wire `useBrand`/`useReducedMotion` hooks                                                                                                                                                                                     | 1 day      | 0.5–1 day    |
| **2**  | **Relaunch-gated loader** — `src/renderer/main.tsx` brand query param + `data-brand` + dynamic `import()`; `src/main/main.ts` per-brand `BrowserWindow` opts (`backgroundColor`/`vibrancy`) + `loadFile({query})`; `src/renderer/index.html` FOUC guard; `SettingsScreen` relaunch banner; `shared/types.ts` + `store/settings.ts` `prismSeed` | 1 day      | 0.75–1 day   |
| **3**  | **Prism tokens polish** — fill `tokens-prism.css` per §3.2 table, tune `--bg-*` ladder on-device (OLED vs LCD blacks differ), contrast check, verify Murmur still navy via `tokens-murmur.css`                                                                                                                                                 | 0.5 day    | 0.5 day      |
| **4**  | **`prism/prism.css` glass system** — `.glass`, `.glass-strong`, `::after` chromatic edge, `::before` mouse light, `prism-hero-frame`, header rule, `@supports` + `prefers-reduced-motion` guards, wire `GlassCard` optional wrapper                                                                                                            | 0.5 day    | 0.5–0.75 day |
| **5**  | **`PrismMotion.ts` port** — FNV-1a, `phase`/`timeOffset`/`spin`/`audioSmooth`/`audioFast`/`flipQueued`, `update(time,audio)`, seed persistence (`prismSeed` in settings), unit test parity with OrbMotion                                                                                                                                      | 0.5 day    | 0.5 day      |
| **6**  | **`PrismShader.ts` GLSL** — vertex + fragment strings (port `OrbShader.metal` ~400 lines), `compileShader`/`createProgram`, uniform locations, `precision highp` comment, `uLens`/`uMouse` tuning, hero vs background variant branching, `resizeCanvasToDisplaySize`                                                                           | 1–1.5 days | 1–1.5 days   |
| **7**  | **`PrismField.tsx` integration** — canvas lifecycle, `getContext('webgl2')` with fallback, `rAF` loop with 30/60fps throttle, `visibilitychange` + `IntersectionObserver` + `webglcontextlost` pause, `useReducedMotion` gate, `energy` prop wiring, fade-in, cleanup                                                                          | 1 day      | 1 day        |
| **8**  | **Placement wiring** — `App.tsx` background field + header rule, `OnboardingScreen.tsx` hero conditional, hide `.orb/.grid` on Prism, verify single background instance (not per-screen)                                                                                                                                                       | 0.5 day    | 0.5 day      |
| **9**  | **Animations polish** — hover `mousemove→--mouse-x/y` throttled, button burst `scale+shadow`, focus spectral edge, run-live energy lift (ramp `0.12→0.45`), header accent                                                                                                                                                                      | 0.5 day    | 0.5 day      |
| **10** | **Verification & PR** — `npm run check` green, build chunk check, manual 9-step visual pass (both brands, both motion prefs, packaged), clip for PR description, self-review vs `AGENTS.md` invariants                                                                                                                                         | 0.5–1 day  | 0.75 day     |

**Total:** **~6–8 days** solo (calm pace with device testing). Can compress to **~4–5 days** if the implementer copies `OrbShader.metal` → GLSL mechanically (no tuning) and defers hero variant V2.

**Suggested ordering for incremental PRs:**

- PR A (shippable alone): Steps 1–4 — tokens split + relaunch loader + glass + tokens polish. Prism is already cinematic without WebGL; Murmur not regressed. Mergeable after `npm run check` + manual checks 1,5,9.
- PR B: Steps 5–8 — motion + shader + field + placement. The “galaxy marble” lands.
- PR C (polish): Step 9 + fallback/performance tuning. Can ride B if time.

If single PR is required, do A→B→C in one branch, but keep commits per step so review is tractable.

**Dependencies & coordination note:** Murmur planner is running in parallel. Share `tokens-base.css` shape and the `main.tsx` brand-gated loader contract early (agree on `data-brand` attribute name, query param `?brand=`, and `tokens-base.css` vs `tokens.css` import path). Prism's `prismSeed` is additive — Murmur can ignore it but should not delete it. Do not both edit `src/main/main.ts` `BrowserWindow` opts in conflicting ways — Prism's per-brand `backgroundColor`/`vibrancy` superset covers Murmur's needs.

---

## 9) Appendix — references & invariants to not break

- **Global invariants (AGENTS.md):** phase born `fail`, code owns sequencing/retries/acceptance, write boundaries enforced by git diff post-call, every run gets a `foundry/run_*` worktree+branch, corrections re-prompt live session, gates return evidence, `finish()` settles status/notification/banner/`outcome_detail` together, comments explain why never what, no emoji.
- **Renderer constraints (`src/renderer/AGENTS.md`):** renderer never touches disk/git/droid, only `shared/` + `renderer/`, no direct `src/main/` imports, `BrandIcon` imports `Color.js`/`Mono.js` directly, polling via `stores/run.tsx`, styling via `design/tokens.css` (now `tokens-base.css` + brand CSS).
- **Brand plumbing already on main:** `BrandId='prism'|'murmur'`, `settings.brand` default `prism`, `assets/brands/{prism,murmur}/**` with fallback `assets/**`, `assetUrl`, `applyBrandDockIcon()`, `useBrandedAsset`, Settings picker. This plan extends that, does not replace it.
- **Onboarding invariants:** project step name freely and any repo, `engineerName` recorded on every run — seed should not depend on project name.
- **No heavy WebGL dep:** justification in §4.6 — raw WebGL2 + tiny helpers. If a reviewer insists on a lib, reopen with measured bundle delta.

---

_End of plan. Implementer: when you start, re-read `apps/desktop/src/renderer/design/tokens.css` in full (the table above is derived from it at 2026-08-08) and diff against the file you see — if tokens have shifted on `main`, update the before/after table before coding._
