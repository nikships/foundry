# Plan — run_260914_e4b9c9: user font preference + bundled Nerd Font coverage

## 1. Goal

Add an Appearance font preference (interface + monospace faces chosen from fonts
already installed on the operator's Mac) and ship Nerd Font symbol coverage out
of the box, without bloating or breaking the signed, installable macOS app.

Observable acceptance (all verified in the running app):

1. Settings → Appearance lists installed Mac fonts and lets the operator pick
   the interface and monoscope faces, including reset-to-default.
2. A choice visibly changes app typography immediately, no relaunch; the same
   choice is active after a full restart.
3. A stored choice naming a now-missing font falls back to a safe default —
   no broken text, blank UI, or startup failure.
4. Font choice coexists with the theme picker: switching themes preserves the
   font; switching fonts preserves the theme.
5. On a fresh install with no user fonts, representative Nerd Font symbols used
   by the app render out of the box.
6. The packaged app still installs, launches, and updates with no license
   violation and no unreasonable size/startup regression from bundled fonts.

## 2. Current-state findings (read, not changed)

- Settings shape: `AppSettings` in `apps/desktop/src/shared/types.ts`; schema,
  defaults, and file migration in `apps/desktop/src/main/store/settings.ts`
  (`defaultSettings()`, `migrate()`, `SettingsStore.patch()` with
  `appSettingsSchema`). Unknown keys dropped, missing/invalid fall back to
  shipped defaults. Font fields must follow this exact pattern.
- Theme precedent: catalog in `apps/desktop/src/shared/themes.ts`, picker
  `apps/desktop/src/renderer/components/ui/ThemePicker.tsx`, Appearance section
  in `apps/desktop/src/renderer/screens/SettingsScreen.tsx`, native chrome via
  `AppContext.applyTheme()` in `apps/desktop/src/main/context.ts`, renderer
  application via `document.documentElement.dataset.theme` effect in
  `apps/desktop/src/renderer/stores/app.tsx`.
- Type tokens: `--font` / `--font-mono` in
  `apps/desktop/src/renderer/design/tokens-base.css`; shipped faces are
  vendored Geist + Geist Mono in `apps/desktop/src/renderer/design/fonts/`
  (SIL OFL 1.1) loaded with `@font-face` + `font-display: swap`. Boot fallback
  in `apps/desktop/src/renderer/main.tsx` sets `data-theme="dark"` before
  settings load.
- IPC seam (the only legal path for the new capability):
  `apps/desktop/src/shared/ipc-contract.ts` → `apps/desktop/src/main/ipc/*.ts`
  (+ registration in `apps/desktop/src/main/ipc/index.ts`) →
  `apps/desktop/src/preload/bridge.ts` (named methods only, CJS output) →
  `apps/desktop/src/renderer/api.ts` (auto via `guard(window.foundry)`).
  Settings precedent: `IPC.settingsGet/settingsPatch` in
  `apps/desktop/src/main/ipc/settings.ts`.
- Child spawning: `resolveEnv()` finishes in `apps/desktop/src/main/main.ts`
  before any spawn; every spawn uses `spawnEnv()` from
  `apps/desktop/src/main/system/env.ts`. Font enumeration must obey this.
- Packaging: `electron-builder.yml` (`files: out/**/*`, `extraResources:
  assets/`, bridge, pi-packages). Renderer fonts ride the Vite bundle, not
  `extraResources`. `assets/` dir is for native resources; do not put fonts
  there.
- Search registry: `apps/desktop/src/renderer/view-models/settings-search.tsx`
  (`SETTINGS_PANES`, `SETTINGS_SECTIONS`, `sectionId()` derived from the
  `Section label=` call site — keep labels in step).
- Existing tests to extend (do not invent parallel harnesses):
  `apps/desktop/tests/main/store/settings-store.test.ts`,
  `apps/desktop/tests/main/ipc/settings.test.ts`,
  `apps/desktop/tests/renderer/settings-search.test.ts`,
  `apps/desktop/tests/e2e/settings.spec.ts`,
  `apps/desktop/tests/helpers/*` (scripted-transport pattern; no Git mocks,
  no model/network calls in tests).
- No Nerd Font, icon-font, PUA-glyph, or `font-family` override machinery
  exists today (`grep font` hits only Geist wiring and incidental
  `font-size`/`font-family: var(--font-mono)` consumers). Components consume
  `var(--font)` / `var(--font-mono)` and never name a concrete face — the plan
  preserves that invariant.

## 3. Key design decisions (builder: do not deviate without reason)

1. **Two nullable settings, not one, not an enum.** Add
   `interfaceFont: string | null` and `monoFont: string | null` to
   `AppSettings`. `null` = shipped default (Geist / Geist Mono). Free-form
   nullable strings (validated: trimmed, length-bounded, charset-sanitized —
   see §4.1) because the installed-font universe cannot be an enum and the
   schema must accept values enumerated on another machine/profile. Never store
   `""`; normalize empty/whitespace to `null` on write and on read.
2. **Font enumeration is main-side, cached, best-effort.** New module
   `apps/desktop/src/main/system/fonts.ts` (pure parse function exported for
   tests + async list function). Primary mechanism: absolute-path
   `/usr/sbin/system_profiler SPFontsDataType -json` via `execFile` with
   `spawnEnv()` env and a timeout (~10 s), parse family names, dedupe, sort
   (locale-aware, case-insensitive). Fallback on failure/timeout: directory
   scan of `~/Library/Fonts`, `/Library/Fonts`,
   `/System/Library/Fonts{,/Supplemental}` for `*.ttf/*.otf/*.ttc/*.woff*`
   mapped through `mdls -name com_apple_ats_name_family` only if cheap —
   else filename stems. Cache per process (invalidate never; fonts rarely
   change mid-session; document this). Failure returns `[]`, never throws
   across IPC. No `fontconfig` dependency, no network, no new native module.
3. **Fonts apply renderer-side via CSS variables; no main window-chrome
   change.** Unlike theme (which paints native `backgroundColor`), fonts only
   touch the web contents. `AppProvider` effect (already owns
   `dataset.theme`) also sets `--font` / `--font-mono` custom properties on
   `document.documentElement` from settings on every settings change
   (covers immediate apply + restart restore). Missing-font safety falls out
   of the CSS font stack, not JS detection: user face first (quoted), then
   bundled Nerd symbols face, then shipped default, then system fallbacks.
4. **Sanitize before injecting into CSS.** Family names originate from the OS
   listing or a hand-edited `settings.json`; both are untrusted for CSS
   injection (`"; …` sequences, quotes). Allowlist: letters, digits, space,
   `-`, `_`, `.`, `(`, `)`, `+`; max 128 chars; quote with `"` and escape
   `"`/`\`; anything else → drop the override (fall back to default). Share
   the sanitizer between the settings-write path (normalize) and the
   renderer-apply path (defense in depth) — put it in
   `apps/desktop/src/shared/fonts.ts` (new, side-effect-free, importable by
   both processes) with unit tests.
5. **Bundle ONE Nerd Font file, not "all the nerd fonts".** Literally bundling
   every Nerd Font is hundreds of MB and violates the installable/performant
   constraint; the bounded set that preserves the requested coverage is the
   single `Symbols Nerd Font Mono` face ("SymbolsOnly", ~1–3 MB woff2, SIL
   OFL 1.1) which carries the full PUA symbol range (codicons/devicons/
   octicons/FA/material) with no Latin glyphs. Declare `unicode-range` on its
   `@font-face` restricted to the symbol/PUA blocks so the browser only uses
   it for symbol codepoints (zero impact on normal text shaping/perf) and
   `font-display: swap`. If the exact upstream asset is TTF-only at build
   time, convert to woff2 offline once and commit the woff2 (document the
   conversion in the provenance file); do not add a build-time converter
   dependency.
6. **Picker UX scales: dropdowns, not a ThemePicker-style radiogroup.**
   Hundreds of families cannot be swatch cards. New `FontPicker.tsx` with two
   labeled `<select>`-based rows (reuse existing `Dropdown`/`Field` UI
   primitives) + per-row "Reset to default". Mount inside the existing
   Appearance `Section` under the `ThemePicker` — no new pane, no new section
   label (keeps `sectionId`/`data-sec` and the search registry stable;
   only keywords change).
7. **Do not touch `apps/website`, `apps/android`, or `src/main/pi/`.**

## 4. Workstream A — font preference (settings → IPC → UI)

### 4.1 Shared contract: `apps/desktop/src/shared/fonts.ts` (NEW)

- Export `DEFAULT_INTERFACE_FONT = 'Geist'`, `DEFAULT_MONO_FONT = 'Geist Mono'`,
  `NERD_SYMBOLS_FAMILY = 'Symbols Nerd Font Mono'` (exact string must match
  the `font-family` in the new `@font-face`; builder verifies from the
  downloaded file's name table and updates both places together).
- Export `sanitizeFontFamily(value: unknown): string | null` — trim; reject
  non-strings, empties, >128 chars; allowlist
  `/^[\p{L}\p{N} .\-_()+]+$/u`; return the trimmed name or `null`.
- Export `fontStack(family, kind: 'ui' | 'mono'): string` returning the full
  `font-family` value: `"<sanitized or default>", "<nerd>", <defaults...>`.
  Stacks:
  - ui: `'<choice|Geist>', 'Symbols Nerd Font Mono', 'Geist', -apple-system,
    BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif`
  - mono: `'<choice|Geist Mono>', 'Symbols Nerd Font Mono', 'Geist Mono',
    ui-monospace, 'SF Mono', Menlo, monospace`
  - Builders: keep these lists identical to the `:root` fallbacks in
    `tokens-base.css` (§5.1); add a comment in both files pointing at the
    other.
- Export `isDefaultFont(value): value is null` helper for the picker.
- Tests: `apps/desktop/tests/shared/fonts.test.ts` (NEW) — sanitizer table
  (injection strings, overlong, unicode names like `ヒラギノ角ゴ`,
  empty/whitespace), stack ordering (user face first, nerd second, default
  present, system tail intact), null default behavior.

### 4.2 Settings persistence

**`apps/desktop/src/shared/types.ts`**

- Add to `AppSettings` with doc comments:
  `interfaceFont: string | null;` ("PostScript/family name of an installed
  Mac font for UI text; null = shipped default") and
  `monoFont: string | null;` (same for monospace).

**`apps/desktop/src/main/store/settings.ts`**

- Schema: `interfaceFont: z.string().trim().max(128).nullable(),`
  `monoFont: z.string().trim().max(128).nullable()` — nullable (not optional)
  so the key is always present after write. Stricter charset rejected here?
  No: keep schema loose (length only); `sanitizeFontFamily` normalizes to
  `null` on write/read so a hand-edited hostile value repairs rather than
  blocking the whole patch.
- `defaultSettings()`: both `null`.
- `migrate()`: after the existing repairs, add
  `merged.interfaceFont = sanitizeFontFamily(merged.interfaceFont);`
  `merged.monoFont = sanitizeFontFamily(merged.monoFont);`
  (import from `@shared/fonts.js`). Import must be type+pure-function only
  (shared stays side-effect-free per repo rules).
- `patch()`: normalize `patch.interfaceFont/monoFont` through
  `sanitizeFontFamily` before merge (empty/hostile → `null`), so the write
  path and the read path agree. `withoutHiddenPins` untouched. No interaction
  with theme/hidden-model logic.
- Tests (extend `apps/desktop/tests/main/store/settings-store.test.ts`):
  defaults null; patch persists a normal family (`"Hoefler Text"`,
  `"SF Mono"`); patch normalizes `""`/`"   "` to `null`; hostile
  `'"); evil'` → `null` with `ok:true` (repairs, doesn't fail the patch);
  overlong → `null`; `migrate()` on legacy file without the keys yields
  `null`s; `migrate()` on garbage values yields `null`s; theme value
  untouched by font patch and vice versa.

### 4.3 Font enumeration (main)

**`apps/desktop/src/main/system/fonts.ts` (NEW)**

- `export interface ListedFont { family: string }` — keep minimal; renderer
  needs names only. (If builder finds `system_profiler` also cheaply yields
  monospace-ness, may add `mono?: boolean`, but do not block on it: both
  pickers share one list.)
- `export function parseSystemProfiler(json: string): string[]` — pure:
  parse `SPFontsDataType[*]._items[*]` family fields (exact key path verified
  against a real run during build; tolerate missing/shape drift → `[]`
  entries skipped), trim, drop empties, dedupe case-insensitively keeping
  first-seen casing, sort with `localeCompare` (`sensitivity:'base'`).
  Cap at ~2000 entries.
- `export async function listInstalledFonts(): Promise<string[]>` — in-memory
  cached; `execFile('/usr/sbin/system_profiler', ['SPFontsDataType',
  '-json'], { timeout: 10_000, maxBuffer: 32MB, env: spawnEnv() })`;
  on success `parseSystemProfiler`; on any error/timeout/parse failure →
  directory-scan fallback → still failing → `[]`. Never rejects.
- `export function clearFontCacheForTest()` seam.
- Tests: `apps/desktop/tests/main/system/fonts.test.ts` (NEW) — pure parser
  table with inline fixture JSON (no spawn, no network): duplicates,
  case-dedup, unsorted input, missing keys, garbage JSON → `[]`, cap.
  `listInstalledFonts` failure path tested by pointing at an invalid binary
  via an injected runner param (do not spawn the real profiler in tests).
  Note the orb caveat in AGENTS.md for `env.test.ts`; run that suite
  standalone if touched (it isn't — new file only).

**IPC wiring (all four hops, no generic passthrough):**

1. `apps/desktop/src/shared/ipc-contract.ts`: add
   `fonts: { list(): Promise<string[]> }` to `FoundryApi`; add
   `fontsList: 'fonts:list'` to `IPC`. No new event channel (one-shot read
   per Settings mount; no push needed).
2. `apps/desktop/src/main/ipc/fonts.ts` (NEW): `register(ctx, handle)` with
   `handle(IPC.fontsList, () => listInstalledFonts())`. Keep the `Ctx` type
   `Pick<AppContext, never>`-style (no ctx use — match `shared.ts` idioms;
   check `apps/desktop/src/main/ipc/index.ts` for the `registerIpc` signature
   and add the call there).
3. `apps/desktop/src/preload/bridge.ts`: add
   `fonts: { list: () => call(IPC.fontsList) }` in matching position.
4. `apps/desktop/src/renderer/api.ts`: no edit (flows through `guard`);
   add web-mock entry in `apps/desktop/src/renderer/mockFoundry.ts` returning
   `[]` (check that file's shape first) so `vite web` still renders.
5. Tests (extend `apps/desktop/tests/main/ipc/settings.test.ts` or new
   `apps/desktop/tests/main/ipc/fonts.test.ts`): handler returns stubbed
   list; handler never rejects (stub lister to throw → `[]`).

### 4.4 Renderer application + UI

**`apps/desktop/src/renderer/stores/app.tsx`**

- Import `fontStack` from `@shared/fonts.js`. Extend the existing
  `useEffect(() => { … }, [settings])` that sets `dataset.theme` to also set
  `root.style.setProperty('--font', fontStack(settings.interfaceFont, 'ui'))`
  and `root.style.setProperty('--font-mono', fontStack(settings.monoFont,
  'mono'))`. Setting inline custom properties overrides `:root` defaults
  immediately (acceptance #2) and re-applies from `settings.json` on every
  launch (acceptance #2-restart). Do not remove `dataset.themeReady` flow.
  Missing font (acceptance #3) needs no JS: CSS falls through the stack.
- Guard: wrap in try/catch? No — `fontStack` is total (never throws on any
  input); assert that in its tests instead.

**`apps/desktop/src/renderer/components/ui/FontPicker.tsx` (NEW)**

- Props: `{ interfaceFont: string | null; monoFont: string | null;
  onChange: (patch: { interfaceFont?: string | null; monoFont?: string | null }) => void }`.
- Behavior: on mount calls `api.fonts.list()`, stores families + loading /
  error state. Two `Field` rows ("Interface font", "Monospace font") each a
  `Dropdown`/native select: first option `Default (Geist)` / `Default (Geist
  Mono)` value `""`, then one option per family. Selected value = current
  setting if present in list, else `""` with a hint `"<name>" isn't installed —
  using default` (acceptance #3 visibility). `onChange` maps `""` → `null`.
  Per-row "Reset" button (or the Default option suffices — include both only
  if trivial; the Default option is the required reset path). Error/loading:
  show hint text, never block the rest of Appearance. `data-testid`s:
  `settings-font-ui`, `settings-font-mono`, `settings-font-ui-reset`,
  `settings-font-mono-reset`.
- Must not import `fs`/`child_process`/`electron`/anything under `src/main`
  (boundary lint will fail the build otherwise).

**`apps/desktop/src/renderer/screens/SettingsScreen.tsx`**

- In the `preferences` pane Appearance `Section` (after the `ThemePicker`
  `Field`), add a second `Field label="Fonts"` rendering `<FontPicker
  interfaceFont={settings.interfaceFont} monoFont={settings.monoFont}
  onChange={(patch) => void set(patch)} />` reusing the pane's `set()`
  helper (same save banner/error semantics as theme). Do not rename the
  `Section label="Appearance"` (would break `sectionId` jumps + search
  registry + `tests/design-navigation.test.ts` literals).

**`apps/desktop/src/renderer/view-models/settings-search.tsx`**

- Append `font typeface typography interface monospace` to the preferences
  pane `keywords` and to the Appearance section `keywords` (keep its `label`
  and `note` byte-identical). Extend
  `apps/desktop/tests/renderer/settings-search.test.ts`: query `"font"`
  hits the Appearance section.

**Renderer tests (NEW/extend):**

- `apps/desktop/tests/renderer/font-picker.test.ts` (NEW): stub
  `api.fonts.list` (check how existing renderer tests stub `api` — follow
  that seam); renders options incl. Default; selecting fires patch with the
  family; `""` fires `null`; current value absent from list shows fallback
  hint and selects Default; list failure renders hint, doesn't throw.
- App-store effect: extend whatever covers `stores/app` (search tests dir;
  if none, add `apps/desktop/tests/renderer/app-fonts.test.ts` asserting
  `document.documentElement.style.getPropertyValue('--font')` contains the
  chosen family after settings load, and that theme dataset is untouched).

## 5. Workstream B — bundled Nerd Font coverage

### 5.1 Scope (why one file satisfies "bundle all the nerd fonts")

- Ship exactly one face: **Symbols Nerd Font Mono (SymbolsOnly)**. Rationale
  for the builder's commit message and PR description: the full Nerd Fonts
  collection is ~50+ patched families / hundreds of MB — incompatible with
  "keep the app installable and performant". The SymbolsOnly face contains
  the entire Nerd symbol PUA range with no Latin glyphs, so a single
  ~1–3 MB woff2 preserves every glyph the app can reference regardless of
  which family a symbol came from. This is the standard upstream-supported
  subset for exactly this use case (upstream: `nerd-fonts` repo,
  `SymbolsOnly` / `NerdFontsSymbolsOnly`).
- Budget: added install size ≤ 5 MB; zero new runtime deps; no measurable
  main-process startup cost (font loads lazily via `font-display: swap` +
  `unicode-range`).

### 5.2 Files to add/change

1. **Binary (NEW):**
   `apps/desktop/src/renderer/design/fonts/SymbolsNerdFontMono-Regular.woff2`
   (exact filename per what upstream ships; builder picks the Mono Symbols
   woff2 from the pinned Nerd Fonts release — check
   `github.com/ryanoasis/nerd-fonts` releases, `NerdFontsSymbolsOnly`).
   If upstream ships TTF only, convert offline (`fonttools`/`woff2_compress`
   locally, not as a repo dependency) and commit only the woff2.
2. **Provenance (NEW, license gate):**
   `apps/desktop/src/renderer/design/fonts/README.md` — upstream name,
   version/release tag, download URL, SHA-256 of the committed file,
   license (SIL OFL 1.1), statement that the file is unmodified except
   format conversion (or unmodified, whichever is true).
   `apps/desktop/src/renderer/design/fonts/OFL.txt` — full license text if
   not already covered (Geist comment claims OFL; check whether an OFL text
   already exists in the repo — if yes, one shared copy + pointer suffices;
   Nerd symbols are likewise OFL so a single shared `OFL.txt` with a note
   covering both is acceptable).
3. **`apps/desktop/src/renderer/design/tokens-base.css`:**
   - Add `@font-face { font-family: 'Symbols Nerd Font Mono';
     src: url('./fonts/SymbolsNerdFontMono-Regular.woff2') format('woff2');
     font-weight: 400; font-style: normal; font-display: swap;
     unicode-range: U+E000-E0FF, U+E500-E5FF, U+EA60-EBFF, U+F000-F8FF,
     U+1F300-1FAFF, U+23FB-23FE, U+2B58, U+E900-E9FF; }`
     (builder: verify/adjust ranges against the file's actual cmap with
     `fonttools ttx -t cmap` or `fc-query`; goal = cover Nerd PUA + common
     symbol blocks, exclude basic Latin so normal text never matches it.
     Comment the source of the ranges.)
   - Append `'Symbols Nerd Font Mono'` to `--font` and `--font-mono`
     immediately after the Geist faces (mirrors `fontStack()`; cross-comment
     both files).
4. **`electron-builder.yml`:** no change expected (Vite emits renderer fonts
   into `out/`; verify in the built bundle — see §7). Only touch if the
   built app doesn't include the woff2, and then prefer Vite asset config
   over `extraResources` (fonts are web assets, not native resources).
5. **Glyph inventory (builder's first step in this workstream):** grep the
   renderer for existing PUA/private-use chars and icon-ligature usage to
   confirm which symbols must render; record 5–10 representative codepoints
   in the verification notes (§7.4). If the app currently uses no Nerd
   glyphs, the bundled face is still the forward-cover + acceptance #5
   vehicle — state that explicitly rather than inventing new icon usage.

### 5.3 Licensing / signing / size gates

- License: SymbolsOnly is SIL OFL 1.1 (same as vendored Geist) — redistribution
  permitted with license text + provenance file above. No attribution UI
  needed beyond the fonts README.
- Signing/notarization: woff2 inside the Vite bundle is data, not executable;
  no `binaries`/entitlement change. Verify `pnpm run package` output still
  passes gatekeeper assessment per repo docs.
- Size: run `pnpm run check:files` before/after; report delta. If the woff2
  exceeds 5 MB, subset further with `fonttools pyftsubset --unicodes=<ranges>`
  to the PUA/symbol blocks and document the subset command in the README.

## 6. Workstream C — coexistence, migration, and edge cases

- **Theme coexistence (acceptance #4):** font and theme are independent
  settings keys applied by independent mechanisms (CSS vars vs
  `data-theme` + native `backgroundColor`). No shared code path except the
  one `useEffect` in `app.tsx`, which sets both unconditionally from the
  same `settings` object — switching one never clears the other. Tests:
  patch theme → fonts unchanged in store; patch fonts → theme unchanged;
  e2e toggles both (§7).
- **Missing font (acceptance #3):** CSS fallback handles rendering; picker
  shows the "isn't installed — using default" hint; `migrate()` never
  deletes the stored value (so reinstalling the font restores it silently).
  Startup with hostile/missing values: `migrate()` sanitizes to `null`-or-
  safe-name; app never renders without a font.
- **Old installs:** `settings.json` without the keys → `migrate()` fills
  `null` (defaults). No data migration script, no version bump.
- **Fresh-install Nerd coverage (acceptance #5):** pure CSS (`@font-face` +
  stacks) — works before/without any setting.
- **Performance:** font list cached per main-process lifetime; `unicode-range`
  prevents the symbols face from participating in normal text layout;
  `font-display: swap` prevents icon-font blocking. No polling, no new
  event channel.
- **Web (`vite web`) build:** `mockFoundry.ts` returns `[]` for `fonts.list`;
  picker degrades to Default-only with hint; Nerd `@font-face` works
  identically (same CSS).
- **Docs:** update only if behavior/instructions changed per repo guidance —
  likely just the fonts `README.md` (new) and possibly a line in the
  Settings-related docs if a doc enumerates Appearance controls (check;
  don't boilerplate).

## 7. Verification plan (builder: run all, report exactly)

### 7.1 Static gates (authoritative)

```bash
pnpm install --frozen-lockfile
pnpm run check            # typecheck + lint + format + knip + tests + coverage + css/docs/files/duplicate/audit
```

- Never run concurrent `pnpm run check`/coverage jobs in one checkout
  (shared `coverage/.tmp`). Vitest: default adaptive workers, no fixed cap.

### 7.2 Focused suites while iterating

```bash
pnpm exec vitest run apps/desktop/tests/main/store/settings-store.test.ts
pnpm exec vitest run apps/desktop/tests/main/system/fonts.test.ts
pnpm exec vitest run apps/desktop/tests/shared/fonts.test.ts
pnpm exec vitest run apps/desktop/tests/main/ipc/fonts.test.ts
pnpm exec vitest run apps/desktop/tests/renderer/font-picker.test.ts
pnpm exec vitest run apps/desktop/tests/renderer/settings-search.test.ts
pnpm exec vitest run apps/desktop/tests/e2e/settings.spec.ts
pnpm run typecheck && pnpm run lint
pnpm run check:css && pnpm run check:files && pnpm run check:docs
```

### 7.3 Running-app acceptance script (maps 1:1 to §1)

1. `pnpm run dev`, open Settings → Appearance: two font dropdowns list
   installed Mac families; Default options present.
2. Pick an unmistakable UI face (e.g. a serif) + a monospace face: whole-app
   typography changes without relaunch (check body text + a `.mono`
   surface); theme unchanged.
3. Fully quit + relaunch: same faces still applied (read `settings.json` —
   `interfaceFont`/`monoFont` persisted).
4. Switch theme: fonts persist. Reset fonts to Default: Geist returns.
5. Hand-edit `settings.json` to a bogus family, relaunch: app starts, text
   renders in defaults, picker shows the not-installed hint.
6. Fresh profile (or uninstall the test fonts): render a screen containing
   the §5.2 representative Nerd codepoints — all glyphs render, no tofu,
   no user font install.
7. `pnpm run build && pnpm run test:e2e` (after build, per AGENTS.md), then
   packaged `pnpm run package` smoke: installs, launches, no signing errors;
   report installer size delta.

### 7.4 Evidence to report in the PR

- `[component] Brief description` title + `.github/pull_request_template.md`.
- `pnpm run check` result + any skipped/failed checks with reasons.
- Installer/bundle size before/after (fonts binary size + `check:files`).
- The §5.2 representative codepoint list + screenshot(s) of Nerd glyphs and
  of a non-default font applied.
- Font provenance (release tag, SHA-256) inline or via the fonts README.

## 8. File touch list (authoritative)

NEW:

- `apps/desktop/src/shared/fonts.ts` (+ `apps/desktop/tests/shared/fonts.test.ts`)
- `apps/desktop/src/main/system/fonts.ts` (+ `apps/desktop/tests/main/system/fonts.test.ts`)
- `apps/desktop/src/main/ipc/fonts.ts` (+ `apps/desktop/tests/main/ipc/fonts.test.ts`)
- `apps/desktop/src/renderer/components/ui/FontPicker.tsx` (+ `apps/desktop/tests/renderer/font-picker.test.ts`)
- `apps/desktop/src/renderer/design/fonts/SymbolsNerdFontMono-Regular.woff2` (name per upstream)
- `apps/desktop/src/renderer/design/fonts/README.md` (+ `OFL.txt` if not already present)

EDIT:

- `apps/desktop/src/shared/types.ts` (2 nullable fields)
- `apps/desktop/src/main/store/settings.ts` (schema + defaults + migrate + patch normalize)
- `apps/desktop/src/shared/ipc-contract.ts` (fonts namespace + IPC key)
- `apps/desktop/src/main/ipc/index.ts` (register fonts handler)
- `apps/desktop/src/preload/bridge.ts` (named fonts.list)
- `apps/desktop/src/renderer/mockFoundry.ts` (fonts.list → `[]`; verify filename/shape first)
- `apps/desktop/src/renderer/stores/app.tsx` (apply `--font`/`--font-mono`)
- `apps/desktop/src/renderer/screens/SettingsScreen.tsx` (FontPicker in Appearance)
- `apps/desktop/src/renderer/view-models/settings-search.tsx` (keywords only)
- `apps/desktop/src/renderer/design/tokens-base.css` (`@font-face` + stacks)

EXTEND (tests): `tests/main/store/settings-store.test.ts`,
`tests/renderer/settings-search.test.ts`, `tests/e2e/settings.spec.ts`.

DO NOT TOUCH: `apps/website/**`, `apps/android/**`, `src/main/pi/**`,
`electron-builder.yml` (unless §5.2 verification forces it),
`assets/entitlements.mac.plist`, any `.foundry-worktrees/` engine dirs.

## 9. Risks / non-goals

- `system_profiler SPFontsDataType` can take seconds on first call — mitigated
  by cache + async-after-paint fetch + timeout + `[]` fallback. If profiling
  shows it janking Settings open, move the call earlier (post-window idle) —
  do not add a worker.
- `system_profiler` output shape drift across macOS 26.x — mitigated by
  tolerant parser + directory-scan fallback + never-reject contract.
- PostScript-vs-family naming mismatches (stored family not matchable later)
  — harmless by design: CSS fallback + hint; value preserved for later.
- Web-font foundries with restrictive licenses — avoided by shipping only the
  OFL SymbolsOnly face; user-installed fonts are never redistributed.
- Out of scope: per-pane/per-project fonts, font size/weight controls,
  downloading fonts from the network (in app or tests), custom font upload,
  touching the theme catalog.
