# Murmur Theme Plan — Foundry (warm communal dark)

> **Status:** Planning — no code changes. Implementer executes solo from this file.
> **Brand:** Murmur (`brand: 'murmur'`). Companion to Prism. Restart-required switch.
> **Stack:** Electron 43 + React 19 + Vite 7 (`electron-vite`), TypeScript 5.7, `tokens.css` as contract.
> **Spec source:** Commit `b59f998` dual-brand plumbing, plus task constraints (restart switch, `#1A1410` base, WebGL/Shaders + 50-100 boids ceiling, cinematic communal bar).

---

## Table of contents

1. [Vision summary](#1-vision-summary)
2. [Architecture for restart-required switch](#2-architecture-for-restart-required-switch)
3. [Token redesign](#3-token-redesign)
4. [Flocking system](#4-flocking-system--boids)
5. [Other animations](#5-other-animations)
6. [File manifest](#6-file-manifest)
7. [Risks & verification](#7-risks--verification)
8. [Effort estimate & sequencing](#8-effort-estimate--sequencing)
9. [Appendix — implementation notes & quick references](#9-appendix)

---

## 1. Vision summary

### Murmur in one sentence

A **warm dark charcoal-brown** room at dusk: cream paper, walnut ink, ember hearth-light, flocks that move as one. Not a recolor of Prism's OLED-neon lab. A hearth, not a clean room.

### Palette anchors (locked)

| Role                  | Hex         | Token family               | Usage                                                          |
| --------------------- | ----------- | -------------------------- | -------------------------------------------------------------- |
| **Void / base**       | `#1A1410`   | `--bg-base`                | Window fill, shell background, `BrowserWindow.backgroundColor` |
| **Deep void**         | `#0E0B08`   | `--bg-void`                | Titlebar, deepest wells, scrollbar track                       |
| **Cream text**        | `#FFFBF0`   | `--text`                   | Primary type                                                   |
| **Paper**             | `#FFF5E1`   | `--murmur-paper-*`         | Cards, empty-state parchment                                   |
| **Ember**             | `#FF7A3D`   | `--murmur-ember-*`         | Primary CTA, focus ring, flock leader tint                     |
| **Clay / terracotta** | `#C97A5A`   | `--murmur-clay-*`          | Secondary accents, icons, borders                              |
| **Amber**             | `#E8B64A`   | `--amber` (kept, warmed)   | Warnings, highlights                                           |
| **Walnut ink**        | `#2B1E14`   | `--bg-panel` neighbourhood | Panel floors, sidebar depth                                    |
| **Sage**              | `#8AA899`   | `--green` replacement      | Success, accepted                                              |
| **Sage-dim**          | `#8AA89928` | `--green-dim` replacement  | Success halo                                                   |
| **Burnt**             | `#B85C38`   | danger-adjacent            | Fail (warmer than Prism red)                                   |
| **Warm stone**        | `#9A8C7A`   | `--text-faint`             | Ghost dividers                                                 |
| **Dust**              | `#D7CBB6`   | `--text-dim`               | Secondary type                                                 |

Additional Murmur-only: `--murmur-ember-*`, `--murmur-clay-*`, `--murmur-paper-*`, `--grain-*`, `--murmur-ember-glow`.

### Metaphor

- **Prism** = optics, refraction, spectrum, lab, precise, glass, neon on black.
- **Murmur** = flock, paper, embers, communal choreography, air that carries sound. Light is _emitted_ (embers) not _refracted_ (prisms). Motion is _collective_ (flock) not _geometric_ (prisms).

### Texture

Paper grain at 2-4% opacity over every large plane. Subtle, not noisy. Evokes deckled paper under warm light. Implemented as a single tiled SVG turbulence layer, not a per-component image. Grain is the only texture; everything else is flat color + soft shadow. No hard gradients.

### Contrast table — Prism vs Murmur

| Dimension            | Prism (current)                                                                  | Murmur (this plan)                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Base**             | OLED black `#06080f` / `#0a0e18` cold blue-black                                 | Warm charcoal-brown `#1A1410` / `#0E0B08`                                                                              |
| **Text**             | Cool `#e8ecf4`                                                                   | Cream `#FFFBF0`                                                                                                        |
| **Chrome**           | `vibrancy: 'under-window'`, translucent blue-black sidebar `rgba(10,14,24,0.72)` | No vibrancy or `hud` warm variant, **opaque** warm glass: `rgba(26,20,16,0.88)` + parchment grain + soft walnut shadow |
| **Shadow**           | Hard black `rgba(0,0,0,0.4-0.6)`                                                 | Warm umber `rgba(20,12,8,0.35-0.55)`                                                                                   |
| **Primary accent**   | Cyan `#5ad2dd` (cold, tech) + glow                                               | Ember `#FF7A3D` (warm, hearth) + ember-glow                                                                            |
| **Secondary accent** | Purple `#c89bff`                                                                 | Clay/terracotta `#C97A5A`                                                                                              |
| **Success**          | Green `#4ade80`                                                                  | Sage `#8AA899` (muted, papery)                                                                                         |
| **Fail**             | Red `#ff6f67`                                                                    | Burnt `#B85C38` / ember-red `#E85D3F`                                                                                  |
| **Motion hero**      | Geometric orb drift + grid, possible refractive shader                           | **Flocking birds** (50-100 boids) launching from ground line, flocking into window, communal drift                     |
| **Glass**            | Prism refraction, cyan glow, sharp                                               | Paper + soft shadow + parchment grain, **no refraction**                                                               |
| **Typography**       | Unchanged (SF Pro)                                                               | Same family, but warmer tracking: letter-spacing `+0.01em` on headings, slightly looser leading                        |
| **Feel**             | Lab, watch machines work                                                         | Hearth, watch a community arrive                                                                                       |

### Cinematic test

If you mute Prism, it should read as a laboratory monitor. If you mute Murmur, it should read as a single frame from a Kore-eda evening exterior: dark but breathable, light pooled in centers, edges fall to warm black. Both are dark; only the temperature changes.

---

## 2. Architecture for restart-required switch

Goal: brand flip **re-launches the app** (full CSS swap + window chrome). Theme decided at launch from `settings.brand`. No instant preview. Clean, no half-painted state.

Current plumbing (commit `b59f998`) already has:

- `BrandId = 'prism' | 'murmur'`, `settings.brand` default `prism`, `BRAND_LABELS`, `BRAND_IDS`.
- Assets fallback `assets/brands/{brand}/**` with `assets/**` fallback, `assetUrl(relPath)` in `AppContext` (`src/main/context.ts:brandedCandidates`), `useBrandedAsset` in renderer re-resolves on brand change.
- Settings picker in `SettingsScreen.tsx:brand-picker` and IPC `settings:patch` + `brand:applyDockIcon` in `src/main/ipc/settings.ts`. `AppContext.applyBrandDockIcon()` hot-swaps dock icon.
- `src/main/store/settings.ts` migration defaults to `prism`.

What changes for **restart-required theme**:

### 2.1 Boot sequence (no FOUC)

**Constraint:** Renderer is sandboxed (`sandbox: true`, `contextIsolation: true`, no `fs`). It cannot read `settings.json` synchronously. The only synchronous, pre-paint brand signal that avoids an IPC round-trip is the **load URL itself**.

Proposed sequence:

```
1. app.whenReady()
2.   read settings.json SYNC (fs.readFileSync) — do not use SettingsStore async path here.
     If missing/corrupt → brand = 'prism'.
3.   brand = settings.brand === 'murmur' ? 'murmur' : 'prism'
4.   applyBrandDockIcon(brand)  [already done, keep]
5.   createWindow(brand)
       - BrowserWindow.backgroundColor = brandBackground[brand]
         prism: '#06080f' (current)
         murmur: '#1A1410'   (warm brown-black, opaque so vibrancy does not muddy it)
       - BrowserWindow.vibrancy = brandVibrancy[brand]
         prism: 'under-window' (current, cold translucent)
         murmur: null / undefined  → opaque warm window. Alternative: 'hud' if translucency is
           desired for testing, but default to opaque for Murmur. This is a key visual difference.
       - titleBarStyle / trafficLightPosition unchanged.
6.   load renderer with brand in URL:
       DEV:  win.loadURL(`${DEV_URL}?brand=${brand}`)
       PROD: win.loadFile(join(here,'../renderer/index.html'), { search: `?brand=${brand}` })
             // electron-vite build outputs to out/renderer/index.html
             // Fallback if loadFile search not honored: loadURL(`file://${path}?brand=${brand}`)
             // Use pathToFileURL with searchParams; verify via manual test.
7.   Renderer: index.html contains <script> boot shim (see 2.2) that reads ?brand=
     SYNCHRONOUSLY before any CSS is evaluated and sets
       document.documentElement.dataset.brand = brand
     and injects the correct <link rel="stylesheet"> for tokens-{brand}.css.
     No React has mounted yet, so there is zero FOUC.
8.   main.tsx imports ONLY tokens-base.css (reset + primitives). Color tokens come from
     the injected tokens-{brand}.css. Never import tokens.css as a whole after split.
9.   Any later brand change: Settings picker patches settings.brand, shows
     "Relaunch to apply" banner, calls api.app.relaunch() (app.relaunch()+app.quit()).
     No hot-swap of tokens in the live window.
```

**Why URL query, not IPC:**

- `api.settings.get()` is async (preload `invoke` → IPC → disk). Awaiting it before first paint would require showing a blank window or flashing Prism then swapping to Murmur.
- `additionalArguments` (`--brand=murmur` appended to `webPreferences.additionalArguments`) is an alternative, but it is less visible in devtools and still requires parsing `window.process.argv` which is not available in sandboxed renderer without exposing via preload. Query param is trivially readable as `location.search` with zero bridge code.

**FOUC avoidance details:**

- The brand shim must be **the first script in `<head>`**, before any `<link>` or `<style>`. It does:

```html
<script>
  // brand-boot.js — inline, < 400 bytes, no dependencies
  (function () {
    try {
      var m = location.search.match(/[?&]brand=(prism|murmur)\b/);
      var b = (m && m[1]) || 'prism';
      document.documentElement.dataset.brand = b;
      // Preload correct tokens before renderer JS runs.
      var href = './design/tokens-' + b + '.css'; // vite will rewrite via asset handling
      // If using vite-bundled CSS, alternatively rely on JS import; see note below.
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      document.head.appendChild(l);
      // Set background immediately so window backgroundColor and doc match
      document.documentElement.style.backgroundColor = b === 'murmur' ? '#1A1410' : '#06080f';
    } catch (e) {}
  })();
</script>
```

- **Vite handling:** Two options for the implementer to choose, document the choice:

  **Option A (recommended — simpler, no Vite split config):**
  - Split `tokens.css` into `tokens-base.css` (everything except `:root` color tokens) + `tokens-prism.css` + `tokens-murmur.css`.
  - Keep imports static: `main.tsx` does `import './design/tokens-base.css'` (reset, scrollbars, primitives, keyframes). The brand-specific file is loaded via the inline shim's dynamic `<link>` pointing to a built asset. Vite must copy both `tokens-prism.css` and `tokens-murmur.css` as assets. Achieved by placing them under `src/renderer/design/` and referencing via `new URL('./design/tokens-prism.css', import.meta.url)` or by importing both but guarding with `data-brand`.

  **Option B (Vite-native, no inline link):**
  - `main.tsx` does:

```ts
const brand = new URLSearchParams(location.search).get('brand') === 'murmur' ? 'murmur' : 'prism';
document.documentElement.dataset.brand = brand;
// Synchronous import — Vite code-splits but the brand query ensures the right chunk is fetched
// before first paint by blocking React mount:
if (brand === 'murmur') await import('./design/tokens-murmur.css');
else await import('./design/tokens-prism.css');
import './design/tokens-base.css';
```

- Requires top-level `await` (Vite supports it) and hides `<div id="app">` via `html { visibility:hidden }` until import resolves, then `visibility:visible`. Slightly more complex; prefer Option A for clarity.

- **Plan mandates:** Pick one, document in PR, and ensure `npm run build` includes both `tokens-*.css` in `out/renderer/assets/`. Verify by `grep -r "tokens-murmur" out/`.

### 2.2 Files involved (architecture slice)

| Path                                            | Role                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/main.ts`                              | **Modify** — add sync brand read, `createWindow(brand)`, brand-specific `backgroundColor`/`vibrancy`, pass `?brand=` in loadURL/loadFile. Keep dock icon logic.                                                                                                                                                                                                                                                    |
| `src/main/store/settings.ts`                    | **Reference only** — for sync read, duplicate the minimal `brand` extraction logic (or expose `readBrandSync(supportDir)` helper) to avoid pulling `JsonStore` sync path.                                                                                                                                                                                                                                          |
| `src/main/context.ts`                           | **Modify** — optionally extract `readBrandSync()` utility so `main.ts` and `context.ts` agree; keep `brandedCandidates` unchanged.                                                                                                                                                                                                                                                                                 |
| `src/main/ipc/settings.ts`                      | **Modify** — `settings:patch` when `brand` changes should **not** hot-swap dock icon alone; also set a `needsRelaunch` flag. Simplify to `notifySettings` + return `{ needsRelaunch: brandChanged }`.                                                                                                                                                                                                              |
| `src/main/ipc/app.ts`                           | **No change** — `app.relaunch` already exists. Ensure it is called from Settings only on user confirmation.                                                                                                                                                                                                                                                                                                        |
| `src/renderer/index.html`                       | **Modify** — add inline brand boot shim as first `<head>` script (see above). Add `data-brand` handling, early background.                                                                                                                                                                                                                                                                                         |
| `src/renderer/main.tsx`                         | **Modify** — remove `import './design/tokens.css'`; import `tokens-base.css` only. Brand CSS is injected by shim (Option A) or conditionally imported (Option B).                                                                                                                                                                                                                                                  |
| `src/renderer/design/tokens.css`                | **Split** → `tokens-base.css` + `tokens-prism.css` + `tokens-murmur.css` (see §3). Delete original or keep as re-export with deprecation comment.                                                                                                                                                                                                                                                                  |
| `src/renderer/design/tokens-prism.css`          | **Create** — current palette extracted verbatim (so Prism is unchanged).                                                                                                                                                                                                                                                                                                                                           |
| `src/renderer/design/tokens-murmur.css`         | **Create** — warm palette (see §3).                                                                                                                                                                                                                                                                                                                                                                                |
| `src/renderer/screens/SettingsScreen.tsx`       | **Modify** — brand picker: on pick, `patchSettings({brand})`, then show persistent banner: "Theme will apply after relaunch — [Relaunch now] [Later]". Call `api.app.relaunch()` only on explicit click. Remove the previous "Switched to X — visuals updated instantly" + hot-swap dock success path for theme (keep dock icon instant for assets if desired, but theme requires relaunch). Keep `brandBusy` etc. |
| `src/renderer/App.tsx` / `OnboardingScreen.tsx` | **Read** — to verify they rely only on tokens, not hardcoded colors; no change unless hardcoded `#06080f` found.                                                                                                                                                                                                                                                                                                   |
| `electron.vite.config.ts`                       | **Check** — ensure `src/renderer/design/tokens-*.css` are included in build. May need `build.rollupOptions.output.assetFileNames` unchanged; just ensure imports are discovered.                                                                                                                                                                                                                                   |
| `assets/brands/murmur/**`                       | **Use** — `scenes/onboarding-hero.png` etc already exist per `ls` output. No theme code change needed; `assetUrl` fallback already brand-aware.                                                                                                                                                                                                                                                                    |

### 2.3 Window chrome difference (concrete)

In `src/main/main.ts:createWindow(brand)`:

```ts
const BRAND_CHROME: Record<
  BrandId,
  { backgroundColor: string; vibrancy: Electron.Vibrancy | null }
> = {
  prism: { backgroundColor: '#06080f', vibrancy: 'under-window' }, // current
  murmur: { backgroundColor: '#1A1410', vibrancy: null }, // warm, opaque
  // alternative murmur vibrancy: 'hud' or 'fullscreen-ui' if design wants subtle translucency
  // with warm tint — test visually; opaque is safer to keep brown true.
};

function createWindow(brand: BrandId): BrowserWindow {
  const chrome = BRAND_CHROME[brand];
  const win = new BrowserWindow({
    // ...
    backgroundColor: chrome.backgroundColor,
    vibrancy: chrome.vibrancy ?? undefined,
    visualEffectState: chrome.vibrancy ? 'followWindow' : undefined,
    // ...
  });
}
```

Also sync read helper (add to `src/main/store/settings.ts` or new `src/main/store/brand-boot.ts`):

```ts
export function readBrandSync(supportDir: string): BrandId {
  try {
    const raw = readFileSync(join(supportDir, 'settings.json'), 'utf8');
    const j = JSON.parse(raw);
    if (j.brand === 'murmur' || j.brand === 'prism') return j.brand;
  } catch {}
  return 'prism';
}
```

Use this in `main.ts` before `AppContext` is constructed (so it runs even if `AppContext` creation would otherwise lazy-read).

### 2.4 Settings UX for restart-required

- Picker is two-segment toggle (Prism | Murmur) — already exists.
- On change:
  - `patchSettings({brand})` → persist immediately (so relaunch lands on new brand).
  - `await api.brand.applyDockIcon()` → still apply dock icon instantly (cheap, reversible).
  - Show **non-dismissible banner** until relaunch: `Theme will apply after you relaunch — [Relaunch now]` (calls `api.app.relaunch()`).
  - Do NOT auto-relaunch without confirmation (data loss if a run is live — check `registry.liveRunCount()` via IPC and warn if >0).
- `api.app.relaunch` already does `app.relaunch(); app.quit();` — verify it propagates `--brand=` correctly on second launch (it will, because it re-reads settings.json).

---

## 3. Token redesign

### 3.1 Principle

**Keep semantic names, override values.** No component should need a `if (brand === 'murmur')` branch. `--bg-panel` means "panel floor" in both brands; only the hex changes. Murmur introduces a small set of **additive** tokens (`--murmur-*`, `--grain-*`) that Prism simply does not use.

### 3.2 File split

Current `src/renderer/design/tokens.css` is ~470 lines and contains:

- `:root` surfaces, lines, text, accents, status, type, space, shape, depth, motion, layout
- `@media (prefers-reduced-motion)`
- `*` reset, `html/body/#app`, scrollbar, focus, primitives (`.mono`, `.dim`, `.btn`, `.input`, etc), keyframes

Split into:

- **`tokens-base.css`** — everything that is **not** color (space, type, shape, depth shadows that are color-agnostic, motion, layout, reset, scrollbar structure, focus outline width, primitives layout, keyframes). Keep **no hex colors** here except structural ones that are brand-agnostic (e.g., `border-radius`).
- **`tokens-prism.css`** — `:root { /* all color tokens */ }` extracted verbatim from current `tokens.css`. This is the baseline; Murmur must match its shape.
- **`tokens-murmur.css`** — same `:root` block, warm values.

Both `tokens-prism.css` and `tokens-murmur.css` declare **the same set of CSS variables** (so components never see a missing token). Murmur adds extra variables at the end.

### 3.3 Full mapping — before/after table

#### Surfaces

| Token           | Prism (before)        | Murmur (after)        | Note                                                                            |
| --------------- | --------------------- | --------------------- | ------------------------------------------------------------------------------- |
| `--bg-void`     | `#06080f`             | `#0E0B08`             | Deepest well, titlebar fill. Must match `BrowserWindow.backgroundColor` approx. |
| `--bg-base`     | `#0a0e18`             | `#1A1410`             | **Spec lock**. Shell background, `body` fill.                                   |
| `--bg-panel`    | `#0f1420`             | `#241E19`             | Card / panel floors, `Inspector` lanes                                          |
| `--bg-raised`   | `#141a28`             | `#2E261E`             | Raised cards, buttons, roster cards                                             |
| `--bg-hover`    | `#1a2232`             | `#3A2F24`             | Hover state — keep +6-8% lightness lift                                         |
| `--bg-active`   | `#212b3d`             | `#463A2D`             | Pressed/active — + further lift, warm                                           |
| `--bg-input`    | `#080b13`             | `#0E0B08`             | Inputs — deepest, so focus ring pops                                            |
| `--bg-sidebar`  | `rgba(10,14,24,0.72)` | `rgba(26,20,16,0.88)` | Murmur sidebar is **more opaque** (paper needs opacity to read grain)           |
| `--bg-titlebar` | `rgba(6,8,15,0.6)`    | `rgba(14,11,8,0.92)`  | Warm, near-opaque                                                               |

**Depth shadows:** Re-tint from black to warm umber.

| Token                          | Prism                                                  | Murmur                                                                 |
| ------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `--shadow-sm`                  | `0 1px 3px rgba(0,0,0,0.4)`                            | `0 1px 3px rgba(20,12,8,0.35)`                                         |
| `--shadow`                     | `0 4px 16px rgba(0,0,0,0.45)`                          | `0 4px 16px rgba(20,12,8,0.42)`                                        |
| `--shadow-lg`                  | `0 16px 48px rgba(0,0,0,0.6)`                          | `0 16px 48px rgba(20,12,8,0.58)`                                       |
| `--glow-cyan` → `--glow-ember` | `0 0 0 1px var(--cyan-dim), 0 0 24px -6px var(--cyan)` | `0 0 0 1px var(--murmur-ember-dim), 0 0 22px -6px var(--murmur-ember)` |

Keep `--glow-cyan` alias for Prism compat; in Murmur alias it to ember so existing `box-shadow: var(--glow-cyan)` still works but reads warm. Better: define both but Murmur's `--glow-cyan` = ember values.

#### Lines (borders, dividers)

| Token           | Prism                    | Murmur                   | Note                                               |
| --------------- | ------------------------ | ------------------------ | -------------------------------------------------- |
| `--line-faint`  | `rgba(255,255,255,0.05)` | `rgba(255,248,235,0.06)` | Cream-tinted, slightly stronger for brown contrast |
| `--line`        | `rgba(255,255,255,0.09)` | `rgba(255,248,235,0.11)` | Default border                                     |
| `--line-strong` | `rgba(255,255,255,0.16)` | `rgba(255,248,235,0.18)` | Strong border, inputs                              |

#### Text

| Token          | Prism                    | Murmur                       |
| -------------- | ------------------------ | ---------------------------- |
| `--text`       | `#e8ecf4` (cool)         | `#FFFBF0` (cream, spec)      |
| `--text-dim`   | `#9aa6bd`                | `#D7CBB6` (warm stone light) |
| `--text-faint` | `#6b7689`                | `#9A8C7A`                    |
| `--text-ghost` | `#47506180` (cool ghost) | `#6B5E4A80` (walnut ghost)   |

**Contrast check:** `#FFFBF0` on `#1A1410` ≈ 17.2:1 (WCAG AAA). `#D7CBB6` on `#1A1410` ≈ 10.1:1 (AAA for large). `#9A8C7A` on `#1A1410` ≈ 5.6:1 (AA). All pass. Verify with `npx apca-w3` or Figma plugin before sign-off.

#### Accents (semantic stays, hue shifts warm)

| Token          | Prism       | Murmur                                                                                                | Usage                                         |
| -------------- | ----------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `--cyan`       | `#5ad2dd`   | `#FF7A3D` (ember) — **keep --cyan name** alias to ember for compat, but add `--murmur-ember: #FF7A3D` | Primary CTA, links, focus ring, phase running |
| `--cyan-dim`   | `#5ad2dd28` | `#FF7A3D28` (ember-dim)                                                                               | Glow                                          |
| `--purple`     | `#c89bff`   | `#C97A5A` (clay) — alias                                                                              | Secondary accent (roster, concept)            |
| `--purple-dim` | `#c89bff28` | `#C97A5A28`                                                                                           |                                               |
| `--amber`      | `#e8b64a`   | `#E8B64A` (keep, it is already warm)                                                                  | Warning, rejected                             |
| `--amber-dim`  | `#e8b64a28` | `#E8B64A2A` (slightly stronger for brown)                                                             |                                               |
| `--green`      | `#4ade80`   | `#8AA899` (sage)                                                                                      | Success, accepted                             |
| `--green-dim`  | `#4ade8028` | `#8AA8992E`                                                                                           |                                               |
| `--red`        | `#ff6f67`   | `#B85C38` (burnt) or `#E85D3F` — pick `#B85C38` for fail (muted), `#E85D3F` for error pulse           | Fail, error                                   |
| `--red-dim`    | `#ff6f6728` | `#B85C3828`                                                                                           |                                               |
| `--blue`       | `#6aa8ff`   | `#D4A373` (toasted almond) — warm alternative to blue; alias                                          | Info                                          |
| `--blue-dim`   | `#6aa8ff28` | `#D4A37328`                                                                                           |                                               |

**Additive Murmur tokens (prism ignores):**

```css
/* ── murmur additive ─────────────────────────────────────────────────── */
--murmur-ember: #ff7a3d;
--murmur-ember-strong: #ff6a24;
--murmur-ember-dim: #ff7a3d28;
--murmur-ember-glow: 0 0 0 1px var(--murmur-ember-dim), 0 0 22px -6px var(--murmur-ember);
--murmur-clay: #c97a5a;
--murmur-clay-dim: #c97a5a28;
--murmur-paper: #fff5e1;
--murmur-paper-dim: #fff5e11a;
--murmur-walnut: #2b1e14;
--murmur-sage: #8aa899;
--murmur-sage-dim: #8aa89928;
--murmur-burnt: #b85c38;
--murmur-ink: #1a1410; /* equals --bg-base, explicit alias */
--grain-opacity: 0.035; /* 2-4% — tuned per surface */
--grain-size: 180px; /* tile size for repeating grain */
--grain-blend: soft-light; /* or multiply — test on #1A1410 */
```

**Type tweak (warmth without new font):**

- Keep `--font` and `--font-mono` identical (do not swap typeface).
- Add `--tracking-warm: 0.01em` and apply only to `h1, h2, .eyebrow` in Murmur via `[data-brand="murmur"] h1 { letter-spacing: -0.025em; }` (slightly tighter display, warmer).
- Optionally bump `--leading-loose` from 1.7 to 1.72 for cream-on-brown readability; not required.

**Status tokens:** Derive from accents, so they auto-shift:

```css
--status-queued: var(--text-faint);
--status-running: var(--murmur-ember); /* was cyan */
--status-success: var(--murmur-sage);
--status-fail: var(--murmur-burnt);
--status-skipped: var(--text-faint);
--status-accepted: var(--murmur-sage);
--status-rejected: var(--amber);
--status-failed: var(--murmur-burnt);
--status-killed: var(--text-faint);
```

In `tokens-prism.css` keep `status-running: var(--cyan)` etc.

#### Component primitive overrides (layout unchanged, color only)

| Primitive                   | Prism detail                                                            | Murmur detail                                                                                           |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `.btn`                      | `background: var(--bg-raised); border: var(--line); color: var(--text)` | Same vars, auto warm. Add `box-shadow: var(--shadow-sm)` for paper lift.                                |
| `.btn.primary`              | `background: var(--cyan); color: #04212a`                               | `background: var(--murmur-ember); color: #2B1206` (deep walnut for contrast on ember) ; hover `#FF8A52` |
| `.btn.danger`               | `color: var(--red)`                                                     | `color: var(--murmur-burnt)`                                                                            |
| `.btn.ghost`                | `color: var(--text-dim)`                                                | Same                                                                                                    |
| `.input:focus`              | `border-color: var(--cyan)`                                             | `border-color: var(--murmur-ember)` ; add `box-shadow: 0 0 0 3px var(--murmur-ember-dim)`               |
| `:focus-visible` outline    | `2px solid var(--cyan)`                                                 | `2px solid var(--murmur-ember)`                                                                         |
| `::-webkit-scrollbar-thumb` | `var(--line-strong)`                                                    | Same var                                                                                                |
| `.card`                     | `background: var(--bg-panel); border: var(--line)`                      | Add grain overlay (see §5)                                                                              |
| `.badge`                    | background via component inline                                         | In Murmur, use warm `var(--murmur-paper-dim)` for neutral badges                                        |

**No em dash, no emoji** — preserve existing prose rule.

### 3.4 Grain texture approach (detail for §5 but tokenized here)

- **Technique:** Single SVG turbulence filter as CSS `background-image` data URI OR 512×512 pre-rendered PNG (8KB) tiled with `background-repeat: repeat` and `opacity: var(--grain-opacity)` via pseudo-element.
- **Implementation:** Add utility class `.grain` that a large plane uses:

```css
.grain::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' ...><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='0.9'/></svg>");
  background-size: var(--grain-size) var(--grain-size);
  opacity: var(--grain-opacity);
  mix-blend-mode: var(--grain-blend);
  pointer-events: none;
}
```

- Apply to `.shell`, `.card`, `.panel` in Murmur only: `[data-brand="murmur"] .card { position: relative; overflow: hidden; } [data-brand="murmur"] .card::after { /* grain */ }`.
- **Pre-rendered PNG** is simpler and faster (no filter per frame). Generate once at build (`scripts/generate-grain.mjs` or hand-export from Figma) as `assets/brands/murmur/grain.png` (data URI in CSS, not a file request). Recommend PNG tile: 256×256, 8-bit grayscale, 6% noise, blurred 0.7px, exported as `grain-tile.png` + inlined as base64 in `tokens-murmur.css` (≤ 12KB). This avoids `feTurbulence` perf hit on large windows.
- **Decision rule:** If `feTurbulence` measures >1ms per paint in Instruments, switch to PNG tile. Start with PNG tile; it is predictably cheap.

---

## 4. Flocking system — boids

### 4.1 Requirements restated

- **Count:** 50-100 boids (configurable, default 70 for MacBook Air M2, 90 for Studio).
- **Metaphor:** Birds launching from a ground line, flocking into the window, then dispersing to idle drift. Communal choreography, not particles.
- **Tech ceiling:** Full WebGL/Shaders + boids allowed. Must add a small lib only if justified.
- **Where it lives:** Onboarding hero entrance (cinematic burst) + subtle idle drift on `OnboardingScreen` and optionally `EmptyState` background. **Not** on `InspectorScreen`/`Waterfall` (performance and attention budget).
- **Lifecycle:** Theme launch bursts, onboarding entrance, idle drift, pause when occluded.
- **Reduced motion:** Static warm grain only, zero boids.

### 4.2 Library vs hand-rolled

**Recommendation: Hand-rolled ~180-230 lines of TypeScript, zero dependencies. No library.**

Justification:

| Criterion    | Library (e.g., `boids` npm, `flock` or `three/examples/jsm/Boids`)       | Hand-rolled                                                                                   |
| ------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Bundle size  | `boids` ~8KB, `three` + addons ~140KB, `ogl` ~20KB                       | 0KB vendor, ~2KB gz                                                                           |
| API shape    | Generic, 2D only, often assumes full-screen canvas, no spawn-from-ground | Exact spawn model, brand-specific easing, pause/idle                                          |
| Perf control | Opaque, often O(n²) naive                                                | Implement uniform grid for perception (optional for 100 boids, not needed)                    |
| Type safety  | JS, untyped                                                              | Typed `Boid {x,y,vx,vy,ax,ay}`                                                                |
| Maintain     | Extra dep, audit, `allow-scripts` nuance                                 | One file, no dep, matches project `allow-scripts` pin                                         |
| Shader need  | None for triangle sprites                                                | WebGL instancing would justify `ogl`, but Canvas 2D triangle sprites are sufficient (see 4.3) |

If later a **WebGL feathered PNG** flock is demanded, adopt `ogl` (not `three`) — minimal, ES modules, no `allow-scripts`. For this plan, Canvas 2D is enough and keeps the pipeline deterministic.

**Boundary case:** If implementer wants feathered sprites with soft blur and motion trails, propose switching to WebGL instanced triangles via `ogl` in a follow-up; keep the boid logic identical, only the renderer swaps.

### 4.3 Canvas 2D vs WebGL

**Recommendation: Canvas 2D `<canvas>` with triangle sprites (or tiny bird beak-tail triangles), 1 canvas per flock container.**

Why Canvas 2D wins for 50-100 boids:

- **Perf budget:** 100 boids × O(n) neighbour checks (naive O(n²) = 10k distance checks/frame). At 60fps, each check = ~5 flops + 1 sqrt (can avoid sqrt via squared distance). ~50k flops/frame ≈ 0.15ms on M-series. Canvas 2D draw: 100 × `translate + rotate + fill triangle` ≈ 0.4ms. Total <1ms, well under 3ms budget. WebGL would be ~0.2ms draw but adds shader compile, context lost handling, and overdraw complexity for negligible gain.
- **Visual need:** Murmur birds are **abstract**: small triangles (3-4px) with a trailing wing hint, tinted ember/clay/cream at 0.7-0.9 opacity. No texture bleeding, no feather PNG needed for cinematic effect. Triangle reads as bird at this scale and distance. WebGL would only pay off if birds are >14px with feather texture, shadow, and depth.
- **Integration:** Canvas 2D respects `prefers-reduced-motion` trivially, pauses with `visibilitychange`, and layers under content with `pointer-events:none`.
- **Overdraw:** One full-window canvas vs one onboarding-frame canvas. Onboarding frame is 280-400px tall; full-window would cover sidebar too, causing overdraw under vibrant sidebar. Limit to `.cinema .frame` region.

**Fallback:** If Instruments shows >2ms canvas paint on Intel Mac or large external 5K display, promote to WebGL instanced rendering: single `WebGL2` context, instanced attribute for position/angle, vertex shader drawing a triangle per boid, fragment shader tinting. Cost: +1 dependency (`ogl` ~20KB) + 200 lines shader. Keep boid logic identical.

### 4.4 Boid spec (Reynolds classic)

```ts
interface Boid {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
}
```

**Parameters (tuned for window 1440×940, flock area ~700×400 in onboarding frame):**

| Param                         | Value                                                                  | Rationale                                       |
| ----------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------- |
| `maxSpeed`                    | `1.9 - 2.4` (random per boid, warm variation)                          | Communal speed variance reads as life, not army |
| `maxForce`                    | `0.05` (steering)                                                      | Gentle turns, no jitter                         |
| `perceptionRadius.alignment`  | `52`                                                                   | Alignment — mid range                           |
| `perceptionRadius.cohesion`   | `78`                                                                   | Cohesion — largest, keeps flock together        |
| `perceptionRadius.separation` | `24`                                                                   | Separation — tight, avoid overlap               |
| `weights.separation`          | `1.35`                                                                 | Strongest — birds avoid collision first         |
| `weights.alignment`           | `1.0`                                                                  |                                                 |
| `weights.cohesion`            | `0.9`                                                                  |                                                 |
| `weights.groundAttract`       | `0.02` → `0` after lift                                                | Pulls launch up                                 |
| `count`                       | `72` default (55-90 via `?count=` debug param)                         | 70 is sweet spot for communal without noise     |
| `spawnSpread`                 | `x: 0.08W to 0.92W`, `y: groundY + rand(-4, 4)`                        | Ground line                                     |
| `spawnVelocity`               | `vx: ±0.7`, `vy: -1.6 to -2.8` (up) + slight convergence toward center | Launch                                          |
| `friction`                    | `0.998` per frame                                                      | Slight air drag, prevents infinite speed creep  |

**Algorithm per frame (60Hz via `requestAnimationFrame`):**

```
for each boid b:
  separation = avg( normalize(b.pos - other.pos) / dist ) over others within 24
  alignment  = avg(other.vel) over others within 52  → steer = alignment - b.vel
  cohesion   = avg(other.pos) over others within 78  → steer = (cohesion - b.pos) - b.vel
  // Weight and clamp steer to maxForce
  b.ax = separation*1.35 + alignment*1.0 + cohesion*0.9 + extra
  b.ay = ...

  // Extra forces
  // - Ground lift (first 1.8s): add upward bias 0.02
  // - Center pull (flock into window): 0.008 * (center - b.pos) when outside central band
  // - Edge wrap or soft bounce: bounce with 0.7 damping at canvas edges (not wrap — birds should not teleport)
  // - Idle gust (after 8s): every 6-10s inject a 0.06 gust vector for 0.6s to re-energize drift

  b.vx += b.ax; b.vy += b.ay
  clamp speed to maxSpeed
  b.x += b.vx; b.y += b.vy
  b.ax = b.ay = 0
```

**Naive O(n²) is fine for 100.** If count goes to 200 or window is 4K, add uniform grid (10×6 cells, O(n)): not required for v1.

### 4.5 Sprite design

**Chosen: Tiny bird triangle (vector), not PNG.**

- Shape: Isosceles triangle `points: (0,-4), (-2.2, 3), (2.2, 3)` (4px tall). Rotated to heading `atan2(vy, vx)`.
- Fill: `rgba(255,248,235, 0.82)` for 60% of boids (cream), `rgba(201,122,90,0.74)` (clay) for 25%, `rgba(255,122,61,0.76)` (ember) for 15% (leaders). Leader tint = boids with highest `maxSpeed`.
- Stroke: none (clean). Soft shadow: `ctx.shadowColor = 'rgba(43,30,20,0.22)'; shadowBlur = 4` — walnut shadow under warm light.
- Wing hint (optional, cheap): Draw a second smaller triangle offset `(-0.6,0)` and `(0.6,0)` with `globalAlpha 0.18` to hint wings without animating. **No flapping animation** per boid (would cost CPU and read as insect). If flapping is desired later, modulate `scaleY` by `sin(t * flapSpeed + id)` with `flapSpeed 12Hz` — but skip for v1, keep still triangles in flock translation; the flock motion itself provides life.
- **Why not PNG:** PNG would require texture load, atlas, retina handling, and would alias at 4px. Triangle is crisp at any DPR, inlines in JS, no `assetUrl` fetch.

**Size / DPR:** Canvas `width = rect.width * devicePixelRatio`, style `width = rect.width`. Scale `ctx` by `dpr`. Triangle size scales with `dpr` so retina stays sharp.

### 4.6 Lifecycle — spawn, flock, disperse, idle

```
Time 0.0s  Mount OnboardingScreen (step welcome)
  → spawn 72 boids along ground line y = canvas.height - 14 (inside .frame)
  → initial vy up, vx slight inward. Opacity 0→1 over 0.6s (fade in)

0.0-1.8s  LAUNCH phase
  → extra upward force 0.02, spread widens, flock climbs to middle of frame
  → camera: onboarding hero .orbit items still float; boids pass behind them (z-index: canvas under orbit)

1.8-4.5s  FLOCK phase
  → Reynolds weights active, center pull 0.008 toward frame center (0.5W, 0.45H)
  → flock compresses slightly; separation weight dips to 1.1 to allow density

4.5-7.0s  DISPERSE phase
  → cohesion weight 0.9 → 0.45, alignment 1.0 → 0.6, so flock loosens
  → boids arc toward top edge and side edges, thinning

7.0s+     IDLE DRIFT
  → weights: sep 0.85, ali 0.4, coh 0.25 (loose, airy)
  → speed 1.2-1.7 (slower drift), occasionally a gust (random 0.06 vector for 600ms every 7-12s)
  → if user advances onboarding step (factory/roster), trigger a 12-boid micro-burst
     from ground (re-seed 12 boids, others keep drifting) to keep motion tied to interaction

On unmount / step leaving welcome:
  → fade opacity 1→0 over 400ms, cancel RAF, remove canvas

On Inspector/Runs screens:
  → no flock. Grain only (static). Do not mount MurmurFlock component there.
```

### 4.7 Visibility & performance pausing

- Listen to `document.visibilitychange` → if `hidden`, cancel RAF, freeze boids (no tick). On `visible`, restart RAF, resync `lastTime`.
- Listen to `window` `blur` / `focus` → same freeze but with 1s debounce (user alt-tabbing should not thrash).
- Optional Electron-level: `BrowserWindow` `isVisible()` / `isMinimized()` could be exposed via `api.app.isVisible()` IPC and polled every 2s, but `visibilitychange` covers most cases. Only add if field reports show flock running on hidden window via `vibrancy` overlay.
- When canvas is off-screen (onboarding step not `welcome` but still mounted), use `IntersectionObserver` on the canvas container to pause.

### 4.8 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  /* tokens-murmur.css already sets --fast/--normal/--slow to 0ms */
}
@media (prefers-reduced-motion: reduce) {
  /* MurmurFlock.tsx: early return → render no canvas, only grain */
}
```

In code:

```ts
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if (prefersReducedMotion) return null; // render nothing, parent .frame shows grain only
```

This is a **hard disable**, not a slowdown.

### 4.9 Component interface (proposed)

```tsx
// src/renderer/components/MurmurFlock.tsx
export interface MurmurFlockProps {
  count?: number; // default 72
  enabled?: boolean; // default true; step === 'welcome'
  density?: 'sparse' | 'normal' | 'dense'; // 55/72/90
  className?: string; // positioning
}

// internal: MurmurFlockCanvas — owns <canvas ref>, RAF loop, boid array, resize observer
```

Mount points:

- `OnboardingScreen.tsx:cinema.frame` — primary. Flock canvas is `position:absolute; inset:0; pointer-events:none; z-index:1` (under `.orbit` which is `z-index:2`).
- Future: `EmptyState.tsx` subtle drift (12 boids, very slow, behind the `scenes/empty-state.png`) — **opt-in, behind flag**, not required for v1.

### 4.10 Tuning panel (dev-only)

Add Vite `import.meta.env.DEV` block:

- `window.__murmurFlock = { setCount(n), gust(), params }` — console tuner.
- Or small hidden `div` with `?murmurDebug=1` query enabling a Leva-like slider for separation/alignment/cohesion/maxSpeed. Not shipped in `npm run build` (tree-shaken via `if (import.meta.env.DEV)`).

---

## 5. Other animations

All animations respect `prefers-reduced-motion: reduce` → `0ms` durations, and the global tokens `--fast:120ms --normal:220ms --slow:400ms --ease:cubic-bezier(0.32,0.72,0,1)`.

### 5.1 Ember glow (buttons, focus, primary actions)

| Element                       | Prism                                                          | Murmur                                                                                                                                                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.btn.primary` idle           | Cyan fill `#5ad2dd`, glow `0 0 24px -6px cyan`                 | Ember fill `#FF7A3D`, glow `0 0 22px -6px #FF7A3D` + inner `0 0 0 1px #FF7A3D28`                                                                                                                                                                                             |
| Hover                         | `#74e0ea`                                                      | `#FF8A52` (6% lighter, + warm)                                                                                                                                                                                                                                               |
| Active                        | `#3fb8c2`                                                      | `#E86A2E` (8% darker)                                                                                                                                                                                                                                                        |
| Glow pulse (optional, subtle) | `pulse` keyframe opacity 1→0.35 loop on `.btn.primary.loading` | Same `pulse` but glow breathes: `box-shadow: 0 0 12px -4px ember` → `0 0 20px -4px ember` over `1.6s ease-in-out infinite` — **only on primary** and only when idle (not on every button). FPS budget: compositor-only (`box-shadow` is GPU-accelerated when not spreading). |
| Focus ring                    | `2px solid cyan`                                               | `2px solid ember` + `0 0 0 3px ember-dim`                                                                                                                                                                                                                                    |

Timing: `transition: background 120ms var(--ease), box-shadow 220ms var(--ease), border-color 120ms var(--ease)`. All under `--fast`/`--normal`.

### 5.2 Warm glass (not prism refraction)

Prism glass: translucent cold sidebar with `backdrop-filter: blur(14px)` + cyan glow + refraction illusion.

Murmur glass: **paper + soft shadow + parchment grain**, no refraction.

Spec for `[data-brand="murmur"]` surfaces:

```css
[data-brand='murmur'] .panel,
[data-brand='murmur'] .cinema .frame,
[data-brand='murmur'] .card,
[data-brand='murmur'] .sidebar {
  background: color-mix(in srgb, var(--bg-panel) 94%, var(--murmur-paper) 6%);
  border-color: color-mix(in srgb, var(--line) 70%, var(--murmur-clay) 30%);
  box-shadow:
    var(--shadow),
    0 1px 0 rgba(255, 248, 235, 0.04) inset;
  /* grain via ::after, see §3.4 */
}

[data-brand='murmur'] .sidebar {
  /* Opaque warm sidebar — no backdrop-filter blur needed if vibrancy is null */
  backdrop-filter: none;
  /* Optional subtle blur for depth when over content: blur(10px) but low */
}

[data-brand='murmur'] .frame {
  /* hero frame has deeper shadow */
  box-shadow: var(--shadow-lg), var(--murmur-ember-glow);
}
```

**Timing:** No transition needed for glass itself; it is the shell.

### 5.3 Communal pulse (presence / pending runs)

Used for the `pending` banner in `Sidebar.tsx` and `OutcomeBanner` accepted state.

- Prism: cyan pulse (opacity flicker).
- Murmur: **ember-warm pulse that expands slightly** (2% scale + glow) to evoke breathing together.

```css
@keyframes murmur-pulse {
  0%,
  100% {
    transform: scale(1);
    box-shadow:
      0 0 0 1px var(--murmur-ember-dim),
      0 0 16px -8px var(--murmur-ember);
  }
  50% {
    transform: scale(1.015);
    box-shadow:
      0 0 0 1px var(--murmur-ember-dim),
      0 0 22px -6px var(--murmur-ember);
  }
}
[data-brand='murmur'] .pending,
[data-brand='murmur'] .banner.accepted {
  animation: murmur-pulse 3.2s var(--ease) infinite;
}
```

Apply only to **one** element per view to avoid competing pulses.

### 5.4 Onboarding-specific (orb vs flock)

- **Prism** has drifting orbs (`.orb` blur blobs) — cold, geometric.
- **Murmur** keeps orbs but re-tints them warm and adds flock canvas underneath:

```css
[data-brand='murmur'] .orb-a {
  background: color-mix(in srgb, var(--murmur-ember) 30%, transparent);
}
[data-brand='murmur'] .orb-b {
  background: color-mix(in srgb, var(--murmur-clay) 24%, transparent);
}
[data-brand='murmur'] .orb-c {
  background: color-mix(in srgb, var(--amber) 16%, transparent);
}
[data-brand='murmur'] .grid {
  opacity: 0.22; /* dimmer, warmer */
}
```

Orbit items (agent avatars) keep `float` keyframe; Murmur adds `0.02` scale breathe to feel airier.

### 5.5 FPS budget

| Layer                                       | Budget                     | Measured target (M2 Air)            |
| ------------------------------------------- | -------------------------- | ----------------------------------- |
| Boids tick + draw (72 boids)                | `<1.2ms`                   | ~0.8ms                              |
| Grain composite (tiled PNG via pseudo)      | `0ms` tick, `<0.3ms` paint | static, GPU cached                  |
| Ember glow pulse (one element)              | compositor only            | `<0.2ms`                            |
| Orb drift (CSS `transform` + `filter:blur`) | compositor only            | `<0.4ms`                            |
| Total frame allowance @60fps                | `16.6ms`                   | headroom `~15ms` for React          |
| Idle (no flock)                             | `0ms` JS                   | 60fps idle with only CSS animations |

Cap flock RAF at 60fps via `requestAnimationFrame`; if `performance.now()` drift shows frame >16ms for 3 consecutive frames, drop count from 72→55 automatically (adaptive).

---

## 6. File manifest

Every file to create or modify, one line purpose. Paths relative to `apps/desktop/`.

### Create

| Path                                                               | Purpose                                                                                                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/design/tokens-base.css`                              | Non-color tokens: space, type, shape, layout, motion, reset, primitives layout, keyframes; imported by `main.tsx` in both brands.                               |
| `src/renderer/design/tokens-prism.css`                             | Prism `:root` color tokens extracted verbatim from current `tokens.css` (OLED black baseline).                                                                  |
| `src/renderer/design/tokens-murmur.css`                            | Murmur `:root` warm tokens + additive `--murmur-*` / `--grain-*` (see §3.3). Same shape as prism file.                                                          |
| `src/renderer/components/MurmurFlock.tsx`                          | Flock container + `<canvas>` RAF loop, boid physics, visibility pause, DPR handling, `prefers-reduced-motion` guard.                                            |
| `src/renderer/components/MurmurFlock.boids.ts`                     | Pure boid math: `createBoids(count, rect)`, `tick(boids, dt)` with Reynolds separation/alignment/cohesion, clamping, optional uniform grid. No React, testable. |
| `src/renderer/design/grain.css` (or inline in `tokens-murmur.css`) | Grain overlay utility `.grain`/pseudo rules; if separate, imported only by murmur tokens.                                                                       |
| `assets/brands/murmur/grain-tile.png` (optional)                   | 256×256 warm noise tile, 8-bit, ~8KB, inlined as base64 in CSS; fallback if `feTurbulence` is slow.                                                             |
| `docs/plans/murmur-theme-plan.md`                                  | This plan (copy).                                                                                                                                               |

### Modify

| Path                                            | Purpose                                                                                                                                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/index.html`                       | Prepend inline brand boot shim `<script>` before any CSS; reads `?brand=` and sets `data-brand` + injects `tokens-{brand}.css` `<link>` + early bg.                                                 |
| `src/renderer/main.tsx`                         | Remove `import './design/tokens.css'`; add `import './design/tokens-base.css'`; brand CSS now injected by shim (Option A) or conditionally imported (Option B) — pick one and comment why.          |
| `src/renderer/design/tokens.css`                | **Delete or re-export** — after split, either delete (recommended) or keep as `/* deprecated: use tokens-base + tokens-{brand}.css */` re-export for 1 commit to catch stray imports.               |
| `src/main/main.ts`                              | Add `readBrandSync(supportDir)`, brand-specific `BrowserWindow` `backgroundColor`/`vibrancy`, pass `?brand=` in `loadURL`/`loadFile`; extract `BRAND_CHROME` map.                                   |
| `src/main/store/settings.ts`                    | Add exported `readBrandSync(supportDir)` helper (sync fs read of `settings.json` → BrandId) so `main.ts` does not duplicate Zod logic.                                                              |
| `src/main/context.ts`                           | Import `readBrandSync` if extracted; keep `brandedCandidates`/`applyBrandDockIcon` unchanged. Optionally expose `readBrandSync` wrapper.                                                            |
| `src/main/ipc/settings.ts`                      | On `brand` patch, return `needsRelaunch:true` and do not claim instant theme; keep dock-icon swap.                                                                                                  |
| `src/renderer/screens/SettingsScreen.tsx`       | Replace instant "Switched to X — visuals updated" with persistent "Theme will apply after relaunch — [Relaunch now]" banner; guard with `liveRunCount` warning; call `api.app.relaunch()` on click. |
| `src/renderer/screens/OnboardingScreen.tsx`     | Import and mount `<MurmurFlock>` inside `.cinema .frame` when `brand==='murmur'` and `step==='welcome'`; pass `enabled`; add `data-brand` styling for warm orbs if not covered by CSS alone.        |
| `src/renderer/components/EmptyState.tsx`        | **Maybe** add subtle 12-boid drift behind `art` when `brand==='murmur'` (behind flag, low priority; gate on prop `flock?: boolean`).                                                                |
| `src/renderer/App.tsx`                          | **If needed** — read `data-brand` for global grain class or pass brand to shell (`<div className="shell" data-brand={brand}>`); otherwise CSS `[data-brand="murmur"]` on `html` suffices.           |
| `electron.vite.config.ts`                       | Verify `design/tokens-*.css` are emitted; no code change expected, but add comment linking to brand boot.                                                                                           |
| `src/preload/bridge.ts` / `src/renderer/api.ts` | **No change** — `app.relaunch` already exposed; do not add new IPC for theme.                                                                                                                       |

### No change / reference

| Path                                                                                                                          | Why not                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/shared/types.ts`                                                                                                         | `BrandId`, `BRAND_IDS`, `BRAND_LABELS` already correct.                                                 |
| `src/main/ipc/app.ts`                                                                                                         | `app.relaunch` exists.                                                                                  |
| `assets/brands/murmur/**` (agents, concepts, icon, scenes)                                                                    | Already populated with Murmur pack; flock does not need new assets.                                     |
| `src/renderer/design/tokens.css` consumers (`OnboardingScreen`, `Sidebar`, `OutcomeBanner`, `Waterfall`, `PhaseDrawer`, etc.) | They must use tokens, not hardcoded hex; audit but do not change unless a hardcoded `#06080f` is found. |
| Tests `tests/**`                                                                                                              | Add `murmur-theme.test.ts` only if testing `readBrandSync` or boid math; no existing test needs change. |
| `package.json`                                                                                                                | No new dependency for v1; if `ogl` is adopted later, add explicitly with `allow-scripts` check.         |

### Deletion after verification

- Once `tokens.css` split is verified via `npm run build` + `out/renderer/assets` listing, delete `src/renderer/design/tokens.css` entirely. Keep git history.

---

## 7. Risks & verification

### 7.1 Risks

| Risk                                                       | Likelihood                  | Impact                      | Mitigation                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **FOUC (Prism flash before Murmur)**                       | High if brand read is async | High — breaks cinematic bar | Sync `readBrandSync` in main + inline shim in `index.html` before any CSS; verify throttling CPU 6× in devtools shows no flash.                                                                                                   |
| **100 boids jank on Intel / 5K / battery**                 | Medium                      | Medium — dropped frames     | Adaptive count (72→55 if 3 frames >16ms); pause when `visibilitychange:hidden`; limit flock to onboarding frame only; Canvas 2D is already cheap.                                                                                 |
| **Overdraw (full-window canvas under sidebar)**            | Medium                      | Low-med                     | Mount flock only in `.cinema .frame` (700×400), not `body`; `pointer-events:none`; grain is pseudo, not extra canvas.                                                                                                             |
| **Grain overdraw / blur cost**                             | Low-med                     | Medium                      | Use tiled PNG data URI, not live `feTurbulence` per frame; measure paint in Instruments; cap `background-size` to 180-256px.                                                                                                      |
| **Color contrast regression**                              | Medium                      | High (a11y)                 | Run WCAG check for every text token on every bg token (matrix). Cream `#FFFBF0` passes; sage on brown must be verified; iterate highs until AA.                                                                                   |
| **`vibrancy` muddying warm brown**                         | Medium                      | Medium                      | Default Murmur to `vibrancy: null` (opaque). Provide `hud` as experiment behind flag, not default.                                                                                                                                |
| **`loadFile` with `?brand=` not honored on Windows/Linux** | Low (macOS target)          | Medium                      | App is macOS-only, but still test `file://` + search; fallback is `loadURL(pathToFileURL(...).href + '?brand=murmur')`.                                                                                                           |
| **Settings picker auto-relaunch loses unsaved run**        | Low                         | High                        | Before relaunch, check `registry.liveRunCount()` via `api.runs.list` or new `api.app.liveRunCount` IPC; if >0 show confirm: "A run is live — relaunching will not kill it but will detach UI until next launch. Relaunch anyway?" |
| **Hardcoded hex in components**                            | Medium                      | Low                         | Grep `rg -n "#06\|#0a\|#0f\|#5ad" src/renderer --type ts --type tsx` before PR; replace with tokens.                                                                                                                              |
| **Memory leak (RAF not cancelled)**                        | Medium                      | Low                         | `useEffect` cleanup cancels RAF and removes `ResizeObserver`; boid array is GC'd on unmount.                                                                                                                                      |
| **Reduced-motion not honored**                             | Low                         | High (a11y)                 | Gate flock on `matchMedia('(prefers-reduced-motion: reduce)')` + CSS durations to 0; test in macOS Accessibility → Reduce motion.                                                                                                 |
| **Build omits one tokens-\*.css**                          | Low                         | High — blank theme          | `grep -R "tokens-murmur" out/renderer` in CI; vite must emit both. Add `knip` check.                                                                                                                                              |
| **Grain PNG not inlined, 404**                             | Low                         | Low — missing texture       | Inline as `data:image/png;base64,` in CSS; no file fetch.                                                                                                                                                                         |

### 7.2 Verification checklist (must pass before PR)

#### Automated

- [ ] `npm run typecheck` — zero errors (new files typed, no `any`).
- [ ] `npm run lint` — `max-warnings 0`, no `eslint-disable`.
- [ ] `npm run format:check` — prettier pass.
- [ ] `npm run knip` — no unused file/exports (ensure new boids module is imported).
- [ ] `npm test` — `vitest run` green; add `readBrandSync` unit test if helper is extracted (corrupt JSON → prism, missing file → prism, `murmur` → murmur).
- [ ] `npm run build` — succeeds; `out/main/main.js` contains `readBrandSync`/`BRAND_CHROME`; `out/renderer/assets` contains both `tokens-prism.*.css` and `tokens-murmur.*.css` (or shim `<link>` resolves).
- [ ] `npm run audit:deps` — no new dep, so pass.
- [ ] `rg -n "tokens\.css" src` — no stale import remains except shim.

#### Manual visual

- [ ] **Cold launch Prism:** `settings.json` `brand:prism` → launch → shell `#06080f`, sidebar translucent blue-black, cyan primary, no warm grain visible, dock icon Prism.
- [ ] **Cold launch Murmur:** `settings.json` `brand:murmur` → relaunch → shell `#1A1410`, sidebar opaque warm walnut, cream text, ember primary, sage success, burnt fail, grain visible on `.card`/`.panel` at 3% opacity, dock icon Murmur. No FOUC (screen record at 60fps, scrub first 8 frames).
- [ ] **Brand switch UX:** In Settings → Brand → pick other → banner appears "Theme will apply after relaunch — [Relaunch now]". Click → app relaunches → landed on other brand. Dock icon updated. No auto-relaunch without click.
- [ ] **Live-run guard:** Start a run, switch brand, banner warns if live runs (if implemented) and still relaunches safely (run stays `running` in SQLite, visible after relaunch).
- [ ] **Onboarding flock (Murmur):** On `step=welcome`, 72 birds launch from ground line (bottom 14px of `.frame`), climb 1.8s, flock 1.8-4.5s, disperse 4.5-7s, drift after. Advance to `factory` → micro-burst 12 boids. Return to `welcome` → burst again. No flock on `Inspector`/`Runs`/`Roster`.
- [ ] **Grain:** In Murmur, every `.card`/`.panel`/`.frame` shows fine paper grain at 2-4% opacity, not posterized, not moiré on scroll. In Prism, no grain.
- [ ] **Ember glow:** Primary button hover/press shows warm ember glow, not cyan. Focus ring ember.
- [ ] **Reduced motion (macOS Settings → Accessibility → Display → Reduce motion ON):** Relaunch Murmur → no flock canvas (`document.querySelector('canvas.murmur-flock')` is null), only static grain; durations 0; orbs static (no `drift` animation).
- [ ] **Occlusion pause:** `Cmd+Tab` away or minimize window → flock RAF pauses (check `performance` timeline, no JS after hidden). Return → resumes without snap.
- [ ] **Window chrome:** `BrowserWindow.backgroundColor` matches CSS `--bg-void` (eyedropper before first paint). Resize to 1080×720 and 1920×1200 — boids rescale via `ResizeObserver`, no stretching, spawn line stays at bottom.
- [ ] **DPR:** On Retina (2×), triangles are crisp (no aliasing), canvas size = CSS×dpr, `ctx.scale(dpr,dpr)`.
- [ ] **EmptyState (Murmur, optional):** If implemented, 12 boids drift behind `scenes/empty-state.png` at 0.8× speed, not competing with hero.
- [ ] **Perf:** With `?murmurDebug` → count 100, Instruments JS CPU <4% on M2 Air, frame time p50 <12ms, no long tasks >16ms. Adaptive drop to 55 if sustained >16ms.
- [ ] **Package:** `npm run package` → `Foundry.dmg` → install → theme persistence across updates (settings.json survives).
- [ ] **No hardcoded colors:** `rg -n "#[0-9a-fA-F]{6}" src/renderer/components src/renderer/screens | rg -v "tokens|grain|murmur|Brand"` — should be near zero.

#### A11y / correctness

- [ ] Text contrast matrix: `FFFBF0`/`#1A1410`, `D7CBB6`/`#1A1410`, `9A8C7A`/`#1A1410`, `FF7A3D`/`#2B1206` (button text) all ≥ AA (4.5:1). Document in PR.
- [ ] Keyboard: brand picker reachable, `Enter` triggers relaunch, `Esc` dismisses banner.

---

## 8. Effort estimate & sequencing

### LOE

| Phase                                                  | Effort                  | Owner      | Depends                               |
| ------------------------------------------------------ | ----------------------- | ---------- | ------------------------------------- |
| **P0 — Tokens & boot**                                 | 1 day (6-8h)            | 1 engineer | None                                  |
| **P1 — Flock math + canvas**                           | 1.5 days (10-12h)       | Same       | P0 (needs warm colors for bird tints) |
| **P2 — Integration (Onboarding, grain, warm glass)**   | 0.75 day (5-6h)         | Same       | P0, P1                                |
| **P3 — Settings relaunch UX + window chrome + polish** | 0.5 day (3-4h)          | Same       | P0                                    |
| **P4 — Verify + package + docs**                       | 0.5 day (3-4h)          | Same       | All                                   |
| **Total**                                              | **4-4.5 days** (28-34h) | 1 engineer | —                                     |

**T-shirt:** M. No dependency on Prism planner; can merge independently (both touch `tokens.css` split, so coordinate the split point to avoid conflict).

Buffer: +0.5 day if `loadFile` with search requires workaround, or if `feTurbulence` → PNG tile pivot.

### Sequencing (implementer order — do not parallelize, each phase is a checkpoint)

1. **P0 — Split tokens, build shim** (highest risk is FOUC, so do first)
   1. `tokens-base.css` + `tokens-prism.css` (verbatim) + `tokens-murmur.css` (warm). Verify `npm run build` emits both.
   2. Add `readBrandSync()` to `src/main/store/settings.ts`.
   3. Modify `src/main/main.ts` to read brand sync, `BRAND_CHROME`, `?brand=` URL.
   4. Modify `src/renderer/index.html` inline shim (read `location.search`, `data-brand`, early bg).
   5. Modify `src/renderer/main.tsx` to import `tokens-base.css` only.
   6. Verify FOUC-free cold launch in Prism and Murmur (screen record).
   7. Commit: `feat(murmur): warm tokens + restart-required boot` (or combine with settings).

2. **P1 — Boids core** (purest logic, testable without UI)
   1. Create `MurmurFlock.boids.ts` with `createBoids`, `tick`, `clamp`, `dist2`, weights/params as constants, no React.
   2. Add tiny unit test: 2-boid separation, alignment average, cohesion pull, speed clamp (vitest, no git temp needed).
   3. Create `MurmurFlock.tsx` canvas: `useRef<canvas>`, `ResizeObserver`, `dpr` scale, `requestAnimationFrame` loop calling `tick` + `draw`, `visibilitychange` pause, `prefers-reduced-motion` guard, `count`/`enabled` props.
   4. Draw routine: `ctx.clearRect`, for each boid `ctx.save(); translate(x,y); rotate(atan2(vy,vx)); fill triangle; restore();` with walnut shadow, tint palette.
   5. Tune weights by eye in onboarding frame (use `?murmurDebug=1` console tuner if added).
   6. Verify 72 boids <1ms tick+draw in `performance.measure`.

3. **P2 — Mount and texture**
   1. In `OnboardingScreen.tsx`, mount `<MurmurFlock enabled={step==='welcome' && brand==='murmur'}>` inside `.cinema .frame` (read brand via `location.search` or `useApp().settings.brand` after mount — first burst should not wait for settings IPC; use shim brand for immediate canvas, settings brand for later idle).
   2. Add `grain.css` or inline grain in `tokens-murmur.css`; add `[data-brand="murmur"] .card::after`/`.panel::after` grain pseudo.
   3. Warm glass CSS: `[data-brand="murmur"] .sidebar`/`.panel`/`.card` background mix + shadow re-tint.
   4. Warm orbs: `[data-brand="murmur"] .orb-*` re-tint.
   5. Verify grain is static, not animating, 2-4% opacity.

4. **P3 — Settings relaunch + chrome polish**
   1. `SettingsScreen.tsx` brand picker → `needsRelaunch` banner + `api.app.relaunch()` on click, live-run guard.
   2. `src/main/ipc/settings.ts` return `needsRelaunch`.
   3. Warm button/inputs/focus: verify `.btn.primary`, `.input:focus`, `:focus-visible` use ember.
   4. `OutcomeBanner` / `Sidebar pending` ember pulse (one element only).
   5. Optional `EmptyState` flock behind art (12 boids, low speed).

5. **P4 — Verify, package, ship**
   1. Run full `npm run check` (typecheck, lint, format, knip, test, build, audit).
   2. Run manual visual checklist (§7.2) including reduced-motion, occlusion, DPR, `loadFile` on packaged build.
   3. `npm run package` → smoke install → repeat cold-launch checks.
   4. Write PR description with before/after screenshots (Prism vs Murmur side-by-side, onboarding burst frame, button focus, card grain) + contrast matrix.
   5. Attach `docs/plans/murmur-theme-plan.md` copy in PR body.
   6. Clean up: delete `tokens.css` if any shim remains, remove `?murmurDebug` tuner (keep if `DEV`-only).

### Parallelism note

If Prism planner chose Option A (shim + split) as well, the `tokens.css` split should be **landed once, shared** — do not duplicate. If Prism PR lands first, start P0 by rebasing onto it and only author `tokens-murmur.css` + Murmur chrome. If this PR lands first, Prism planner rebases onto it.

---

## 9. Appendix

### 9.1 Exact token files (skeleton)

**`tokens-base.css`** — keep:

```css
/* non-color: motion, type, space, shape, layout, reset, primitives layout, keyframes */
:root {
  --font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
  --font-mono: 'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, monospace;
  --text-xs: 12px;
  --text-sm: 14px;
  --text-base: 16px; /* ... */
  --s1: 4px;
  --s2: 8px; /* ... */
  --r-sm: 6px;
  --r: 10px; /* ... */
  --ease: cubic-bezier(0.32, 0.72, 0, 1);
  --fast: 120ms;
  --normal: 220ms;
  --slow: 400ms;
  --sidebar-w: 264px;
  --titlebar-h: 52px;
}
@media (prefers-reduced-motion: reduce) {
  :root {
    --fast: 0ms;
    --normal: 0ms;
    --slow: 0ms;
  }
}
* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
html,
body,
#app {
  height: 100%;
  overflow: hidden;
}
body {
  background: transparent;
  color: var(--text);
  font-family: var(--font); /* ... */
}
.btn {
  /* layout only, no hex */
}
/* ... rest of non-color */
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
```

**`tokens-prism.css`** — verbatim current `:root` colors.

**`tokens-murmur.css`** — warm replacement with additive tokens (§3.3). Ends with:

```css
[data-brand='murmur'] .shell,
[data-brand='murmur'] .content,
[data-brand='murmur'] .sidebar {
  /* warm glass */
}
@media (prefers-reduced-motion: reduce) {
  :root {
    --fast: 0ms;
    --normal: 0ms;
    --slow: 0ms;
  }
}
```

### 9.2 Boid pseudocode (for copy-paste)

```ts
export const MURMUR_FLOCK = {
  count: 72,
  maxSpeed: 2.2,
  maxForce: 0.05,
  sepR2: 24 * 24,
  aliR2: 52 * 52,
  cohR2: 78 * 78,
  wSep: 1.35,
  wAli: 1.0,
  wCoh: 0.9,
};

export function tick(
  boids: Boid[],
  w: number,
  h: number,
  phase: 'launch' | 'flock' | 'disperse' | 'drift',
  dt: number,
) {
  for (const b of boids) {
    let sepX = 0,
      sepY = 0,
      aliX = 0,
      aliY = 0,
      cohX = 0,
      cohY = 0,
      nSep = 0,
      nAli = 0,
      nCoh = 0;
    for (const o of boids)
      if (o !== b) {
        const dx = b.x - o.x,
          dy = b.y - o.y,
          d2 = dx * dx + dy * dy;
        if (d2 < MURMUR_FLOCK.sepR2 && d2 > 1) {
          const inv = 1 / Math.sqrt(d2);
          sepX += dx * inv;
          sepY += dy * inv;
          nSep++;
        }
        const d2c = (b.x - o.x) ** 2 + (b.y - o.y) ** 2; // reuse
        if (d2 < MURMUR_FLOCK.aliR2) {
          aliX += o.vx;
          aliY += o.vy;
          nAli++;
        }
        if (d2 < MURMUR_FLOCK.cohR2) {
          cohX += o.x;
          cohY += o.y;
          nCoh++;
        }
      }
    let ax = 0,
      ay = 0;
    if (nSep) {
      sepX /= nSep;
      sepY /= nSep;
      const m = Math.hypot(sepX, sepY) || 1;
      sepX /= m;
      sepY /= m;
      sepX *= MURMUR_FLOCK.maxSpeed;
      sepY *= MURMUR_FLOCK.maxSpeed;
      ax += (sepX - b.vx) * MURMUR_FLOCK.wSep;
      ay += (sepY - b.vy) * MURMUR_FLOCK.wSep;
    }
    if (nAli) {
      aliX /= nAli;
      aliY /= nAli;
      const m = Math.hypot(aliX, aliY) || 1;
      aliX /= m;
      aliY /= m;
      aliX *= MURMUR_FLOCK.maxSpeed;
      aliY *= MURMUR_FLOCK.maxSpeed;
      ax += (aliX - b.vx) * MURMUR_FLOCK.wAli;
      ay += (aliY - b.vy) * MURMUR_FLOCK.wAli;
    }
    if (nCoh) {
      cohX /= nCoh;
      cohY /= nCoh;
      cohX -= b.x;
      cohY -= b.y;
      const m = Math.hypot(cohX, cohY) || 1;
      cohX /= m;
      cohY /= m;
      cohX *= MURMUR_FLOCK.maxSpeed;
      cohY *= MURMUR_FLOCK.maxSpeed;
      ax += (cohX - b.vx) * MURMUR_FLOCK.wCoh;
      ay += (cohY - b.vy) * MURMUR_FLOCK.wCoh;
    }
    if (phase === 'launch') ay -= 0.02 * 60 * dt;
    // soft edge bounce
    if (b.x < 8 && b.vx < 0) ax += 0.14;
    if (b.x > w - 8 && b.vx > 0) ax -= 0.14;
    if (b.y < 8 && b.vy < 0) ay += 0.14;
    if (b.y > h - 8 && b.vy > 0) ay -= 0.14;
    const f = Math.hypot(ax, ay);
    if (f > MURMUR_FLOCK.maxForce) {
      ax = (ax / f) * MURMUR_FLOCK.maxForce;
      ay = (ay / f) * MURMUR_FLOCK.maxForce;
    }
    b.vx += ax;
    b.vy += ay;
    const sp = Math.hypot(b.vx, b.vy);
    const cap = b.maxSpeed ?? MURMUR_FLOCK.maxSpeed;
    if (sp > cap) {
      b.vx = (b.vx / sp) * cap;
      b.vy = (b.vy / sp) * cap;
    }
    b.x += b.vx;
    b.y += b.vy;
  }
}
```

No `sqrt` avoidance via squared compare is already shown (`*R2`).

### 9.3 Draw routine (copy-paste)

```ts
function draw(ctx: CanvasRenderingContext2D, boids: Boid[]) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.scale(devicePixelRatio, devicePixelRatio);
  for (const b of boids) {
    const a = Math.atan2(b.vy, b.vx);
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(a);
    ctx.shadowColor = 'rgba(43,30,20,0.22)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = b.tint; // pre-assigned
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(-2.2, 3);
    ctx.lineTo(2.2, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}
```

### 9.4 Reference values for verification

- Window brand read path: `~/Library/Application Support/foundry/projects/<hash>/trace.db` is not relevant; brand lives in `~/Library/Application Support/foundry/settings.json` (macOS `app.getPath('userData')/foundry`). Confirm via `ls -la ~/Library/Application\ Support/foundry/settings.json`.
- Dev URL: `process.env.ELECTRON_RENDERER_URL` (e.g., `http://localhost:5173`), set by `electron-vite dev`.
- Packaged renderer path: `join(__dirname, '../renderer/index.html')`.
- Asset fallback already tested via `useBrandedAsset('scenes/onboarding-hero.png')`.

### 9.5 What NOT to do

- Do not add a new IPC channel for theme or flock. Use the URL shard and brand shim.
- Do not import `electron`, `fs`, `better-sqlite3` in renderer. Do not add `three` or any `allow-scripts` dep.
- Do not animate the flock on `Inspector`/`Waterfall` (user attention + perf).
- Do not ship the grain as a per-card PNG fetch; inline as base64 or SVG data URI.
- Do not use emoji, em dash (per AGENTS.md invariants).
- Do not implement — this plan is the deliverable; code changes belong to the implementer.

### 9.6 Open questions for implementer to close (not blockers)

- Exact clay/ember contrast tuning after first visual pass — adjust ember from `#FF7A3D` to `#FF7440` if cream-on-ember button fails contrast on some displays; iterate.
- Whether to keep Murmur vibrancy `null` or `hud` — quick visual A/B with warm `backgroundColor` will decide.
- Whether `EmptyState` gets 12-boid drift — cheap if spare time, but not required for cinematic bar.
- Whether to keep `allow-scripts` exception for a future `ogl` — defer.

---

## Plan completeness

This plan gives an implementer enough to build Murmur solo without follow-ups: vision with hex-precise palette and Prism contrast table, restart-required boot architecture with file-accurate file paths and FOUC-proof shim, complete before/after token mapping with new `--murmur-*`/`--grain-*` tokens, hand-rolled boid algorithm with params/weights/lifecycle/visibility/reduced-motion, warm glass/ember/pulse animations with timing and FPS budget, exhaustive file manifest, risks with mitigations and checkbox verification, and a 4.5-day phased schedule. It is a re-theming with cinematic depth, not a recolor.
