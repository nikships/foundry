# UI Consolidation — Implementation Plan

**Scope:** `apps/desktop/src/renderer` (+ the brand plumbing it reaches into: `src/main`, `src/shared`, `assets/`)
**Date:** 2026-08-08
**Status:** plan only — no source edits beyond this file
**Decision baked in:** Murmur is removed. Prism is the only brand. Phase 1 is a deletion, not an abstraction.

---

## 0) How to use this plan

Execute **top to bottom**. Each phase is independently shippable, ends with an acceptance check, and leaves `npm run check` green. Run everything from `apps/desktop/`, never the repo root.

```
npm run check   # typecheck → lint → format:check → knip → test → build → audit:deps
```

Do not batch phases into one commit. Phase 1 is a large deletion and must be reviewable on its own. Phases 2-4 each touch shared surfaces and want their own diff.

Every line number in this document was verified against the working tree at commit `15abe84`, **including the uncommitted changes present in `src/main/` and `src/shared/` at the time of writing**. Those parallel edits do not touch brand code, but they do shift line numbers. If a number has drifted, re-grep for the symbol rather than trusting it.

---

## 1) Why this exists

Two audits of the renderer turned up one structural problem and two live bugs.

### 1.1 The structural problem: CSS is not where the repo says it is

`design/tokens-base.css` is **322 lines**. The `<style>{\`...\`}</style>`blocks embedded in`.tsx` files total **2,555 lines across 35 files** — roughly 8x the shared stylesheet. Several files are more stylesheet than component:

| File                                   | CSS lines | Total lines | Ratio |
| -------------------------------------- | --------- | ----------- | ----- |
| `screens/onboarding/DoctorScreen.tsx`  | 332       | 559         | 59%   |
| `screens/onboarding/WelcomeScreen.tsx` | 331       | 479         | 69%   |
| `screens/onboarding/ProjectScreen.tsx` | 306       | 651         | 47%   |
| `screens/onboarding/RosterScreen.tsx`  | 244       | 349         | 70%   |
| `screens/onboarding/CliScreen.tsx`     | 200       | 358         | 56%   |
| `screens/onboarding/FactoryScreen.tsx` | 193       | 647         | 30%   |
| `screens/PipelinesScreen.tsx`          | 167       | 861         | 19%   |
| `screens/RosterScreen.tsx`             | 133       | 661         | 20%   |

These are **plain global `<style>` tags**, not CSS Modules and not scoped. Whatever mounts last wins. Parsing every block yields:

- **567** distinct class names defined inside `.tsx` files
- **61** class names defined in **2 or more** files
- **22** lines that redefine a class already owned by `tokens-base.css`

### 1.2 Bug A: colliding classes on co-mounted components

Three of these collisions are between components that are in the DOM **at the same time**, so the override is real, not theoretical:

| Parent                        | Child (rendered inside it)       | Colliding class                      |
| ----------------------------- | -------------------------------- | ------------------------------------ |
| `screens/SettingsScreen.tsx`  | `components/ProjectCommands.tsx` | `.row`                               |
| `screens/RosterScreen.tsx`    | `components/BoundaryEditor.tsx`  | `.hint`                              |
| `screens/PipelinesScreen.tsx` | `components/PhaseEditor.tsx`     | `.field`, `.hint`, `.modes`, `.mode` |

`.row` concretely disagrees:

```css
/* screens/SettingsScreen.tsx:1049 */
.row {
  display: flex;
  gap: var(--s3);
}
/* components/ProjectCommands.tsx:128 — mounted inside Settings */
.row {
  display: flex;
  gap: var(--s2);
  align-items: center;
}
```

And nothing actually uses the base `.field`. All four definitions disagree with it and with each other:

```css
/* design/tokens-base.css:260  */
.field {
  gap: var(--s2);
  margin-bottom: var(--s5);
}
/* screens/SettingsScreen.tsx:1044 */
.field {
  gap: var(--s1);
  margin-bottom: var(--s4);
}
/* screens/RosterScreen.tsx:646    */
.field {
  gap: var(--s1); /* no margin */
}
/* components/PhaseEditor.tsx:500  */
.field {
  gap: var(--s1);
  margin-bottom: var(--s3);
}
```

### 1.3 Bug B: `KIND_COLOR` duplicated 4x, one copy inverted

```
components/PhaseEditor.tsx:8      { code: 'var(--blue)',  engineer: 'var(--amber)' }
components/Waterfall.tsx:8        { code: 'var(--blue)',  engineer: 'var(--amber)' }
components/PipelineRibbon.tsx:4   { code: 'var(--blue)',  engineer: 'var(--amber)' }
screens/PipelinesScreen.tsx:18    { code: 'var(--amber)', engineer: 'var(--blue)' }   ← swapped
```

`PipelinesScreen`'s phase track paints commands amber and checkpoints blue. Every other surface in the app does the exact opposite. A user comparing the pipeline editor to the run waterfall sees two different colour languages for the same two phase kinds.

### 1.4 What the audits explicitly cleared

Recorded so nobody re-investigates:

- **`BrandIcon.tsx`'s 285-line provider map** — hand-written on purpose per `src/renderer/AGENTS.md`, guarded by `tests/brand-icons.test.ts`. Leave it.
- **`useAsync`** — only 1 of ~12 async effects fits the canonical `T + loading + error` shape. A generic hook nets _negative_ lines.
- **`usePersistedState`** — exactly 2 `localStorage` keys. Costs ~11 more lines than it saves.
- **Merging `UpdateBanner` + `OutcomeBanner`, or `PhaseEditor` + `PhaseDrawer`** — genuinely different surfaces and data types (`PhaseDef` vs `PhaseRow`).
- **Unifying the `ro-` / `pl-` / `ob-` / `te-` prefix families** — real visual overlap, but that is a design decision, not a refactor. Out of scope.

---

## Phase 1 — Remove Murmur

Prism becomes the only brand. This is the single largest line and byte reduction available, and it shrinks the surface every later phase has to touch: no brand-gated CSS, no `[data-brand]` selectors, no dual-asset resolution.

### P1.1 What Murmur currently costs

| Item                                                                                  | Size      |
| ------------------------------------------------------------------------------------- | --------- |
| `assets/brands/murmur/` (15 files, tracked in git)                                    | **38 MB** |
| `assets/brands/prism/` (15 files, byte-identical to `assets/` root — verified by md5) | **28 MB** |
| `src/renderer/design/tokens-murmur.css`                                               | 213 lines |
| `src/renderer/components/MurmurFlock.tsx`                                             | 190 lines |
| `src/renderer/components/MurmurFlock.boids.ts`                                        | 222 lines |
| Brand picker UI + CSS in `SettingsScreen.tsx`                                         | ~55 lines |
| Brand plumbing across main/shared/preload                                             | ~60 lines |

**Total: ~66 MB of assets and ~740 lines of code.**

The asset finding is important and was verified, not assumed:

```bash
cd apps/desktop/assets
for f in $(cd brands/prism && find . -type f | sed 's|^\./||'); do
  [ "$(md5 -q "$f")" = "$(md5 -q "brands/prism/$f")" ] || echo "DIFF: $f"
done
# → identical: 15, differing: 0
```

Every file in `assets/brands/prism/` is a **byte-for-byte duplicate** of the file at the corresponding `assets/` root path. Once Murmur is gone, the entire `assets/brands/` tree is dead weight and the root fallback is already the Prism artwork.

### P1.2 Files to delete outright

```
apps/desktop/src/renderer/design/tokens-murmur.css
apps/desktop/src/renderer/components/MurmurFlock.tsx
apps/desktop/src/renderer/components/MurmurFlock.boids.ts
apps/desktop/assets/brands/                              (whole tree — both brands, 66 MB)
apps/desktop/docs/plans/murmur-theme-plan.md
```

`assets/brands/prism/` goes too. Its contents already exist at `assets/agents/`, `assets/concepts/`, `assets/scenes/`, `assets/icon/`, which is where `assetUrl` falls through to once the branded candidate list is removed.

Keep `docs/plans/prism-theme-plan.md` — it documents the surviving brand.

### P1.3 `src/shared/types.ts` — collapse the brand type

Lines 172-177 currently:

```ts
  /** Visual brand. Prism is the default; both packs ship in `assets/brands/*`. */
  brand: BrandId;
...
export type BrandId = 'prism' | 'murmur';
export const BRAND_IDS: BrandId[] = ['prism', 'murmur'];
export const BRAND_LABELS: Record<BrandId, string> = { prism: 'Prism', murmur: 'Murmur' };
```

Delete `BrandId`, `BRAND_IDS`, `BRAND_LABELS`, and the `brand` field on `AppSettings` entirely.

**Do not** keep `type BrandId = 'prism'` as a single-member union. A one-value type invites the picker to grow back and forces every consumer to keep importing it. Remove the concept.

### P1.4 `src/main/store/settings.ts` — schema, default, migration

Four edits:

1. **Delete `readBrandSync`** (starts line 25). Its whole reason for existing was choosing a window background before `SettingsStore` was readable. With one brand the background is a constant.
2. **Line 70:** remove `brand: z.enum(['prism', 'murmur']),` from the zod schema.
3. **Line 103:** remove `brand: 'prism',` from defaults.
4. **Lines 130-131:** remove the brand-repair migration block.

**Migration requirement.** Existing installs have `"brand": "prism"` or `"brand": "murmur"` in `~/Library/Application Support/foundry/settings.json`. Confirm how the zod schema treats unknown keys before shipping:

- If the schema is `.strict()`, an existing `brand` key will **throw on load and wipe user settings**. You must add a strip step for the legacy key.
- If it is the zod default (strip unknown keys), the field is silently dropped on first save and no migration is needed.

Verify this explicitly. A settings-wipe on upgrade is the one genuinely destructive failure mode in this whole plan.

### P1.5 `src/main/main.ts` — constant background, no query param

- **Line 29:** replace the `BRAND_BACKGROUND` record with `const WINDOW_BACKGROUND = '#000000';` and keep the comment explaining that the pre-paint colour must match the void.
- **Line 34:** `createWindow(brand: BrandId)` → `createWindow()`.
- **Line 44:** `backgroundColor: BRAND_BACKGROUND[brand]` → `backgroundColor: WINDOW_BACKGROUND`.
- **Line 64:** `loadURL(\`${DEV_URL}?brand=${brand}\`)`→`loadURL(DEV_URL)`.
- **Line 66:** `loadFile(..., { query: { brand } })` → `loadFile(...)`.
- **Line 174:** drop the `readBrandSync` call and the comment above it.
- **Line 186:** drop the `applyBrandDockIcon()` launch call.
- **Lines 197, 204:** `createWindow(brand)` → `createWindow()`.
- **Line 11:** drop the `BrandId` type import; **line 14:** drop the `readBrandSync` import.

### P1.6 `src/main/context.ts` — flatten asset resolution

- **Lines 90-104:** delete `brandedCandidates` entirely. `assetUrl` resolves straight against `assetsRoot`.
- **Lines 106-119:** simplify `assetUrl` to a single `existsSync` check plus the existing `console.warn` miss path. Keep the warning — it is the only signal for a packaging error.
- **Lines 123-145:** delete `applyBrandDockIcon`. The packaged icon comes from `electron-builder.yml` (`mac.icon: assets/icon/app-icon.icns`), which is already brand-free and stays as is.
- **Line 12:** drop `BrandId` from the type import.

### P1.7 IPC surface — remove the `brand` channel

`src/shared/ipc-contract.ts`

- Line 223: delete the `brand: { ... }` group.
- Line 306: delete `brandApplyDockIcon: 'brand:applyDockIcon',`.

`src/main/ipc/settings.ts`

- Line 8: `Pick<AppContext, 'settings' | 'broadcast' | 'applyBrandDockIcon'>` → drop `applyBrandDockIcon`.
- Lines 13, 23-26: delete the `brandChanged` detection and the dock-icon hot-swap.
- Lines 31-33: delete the `IPC.brandApplyDockIcon` handler.

`src/preload/bridge.ts`

- Lines 107-108: delete the `brand: { applyDockIcon }` group.

Per `src/main/AGENTS.md`, every channel is named in `ipc-contract.ts` first. Removal runs the same path in reverse: contract → handler → bridge. `tests/ipc-surface.test.ts` asserts contract/bridge parity and will catch a half-removal.

### P1.8 Renderer

**`src/renderer/main.tsx`** — the brand gate disappears. Import the three Prism sheets statically:

```tsx
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './design/tokens-base.css';
import './design/tokens-prism.css';
import './design/prism/prism.css';
import './design/prism/prism-animations.css';

document.documentElement.setAttribute('data-brand', 'prism');
document.documentElement.style.colorScheme = 'dark';

const container = document.getElementById('app');
if (!container) throw new Error('Missing #app container');
createRoot(container).render(<App />);
```

Note the top-level `await` and the `Promise.all` both go away, which is a real simplification of module init.

**Keep `data-brand="prism"` on `<html>`.** Two reasons:

1. `src/renderer/index.html:22` uses `html:not([data-brand]) #app` as the FOUC guard. That mechanism still works and still matters.
2. `design/prism/prism.css` and `tokens-prism.css` scope their rules with `[data-brand='prism']`. Stripping the attribute means rewriting every selector in those files — unnecessary churn in this phase. Fold that into Phase 2 if desired.

**`src/renderer/hooks/useBrand.ts`** — delete the file. `resolveBrand()` and `useBrand()` both become constants.

**`src/renderer/hooks/useBrandedAsset.ts`** — keep the hook (`OutcomeBanner`, `EmptyState`, `AgentAvatar` all use it) but drop the brand dependency:

- Remove the `useApp()` call and the `const brand = settings?.brand` line.
- Change the effect deps from `[relPath, brand]` to `[relPath]`.
- Update the doc comment: it no longer "re-resolves whenever the brand flips".

**`src/renderer/App.tsx`**

- Line 14: drop the `MurmurFlock` import; line 15: drop the `useBrand` import.
- Lines 128-129: delete `const brand = useBrand()` and `const isPrism = brand === 'prism'`.
- Lines 164-167: delete the Murmur comment block and `{!isPrism && <MurmurFlock />}`.
- Line 168: `{isPrism && <div className="prism-header-rule" aria-hidden />}` → render it unconditionally.

**`src/renderer/hooks/useReducedMotion.ts`** — **delete the file.** Verified: `MurmurFlock.tsx:54` is its only consumer. Its other user, the Prism field, was already removed in `094b077`. With the flock gone the hook is orphaned, and `knip` (configured `files: "error"`) will fail the build if it is left behind.

**`src/renderer/screens/SettingsScreen.tsx`** — remove the picker:

- Line 3: drop `BrandId` from the type import; line 12: drop `BRAND_LABELS`.
- Lines 70-71: delete `brandBusy` / `brandNote` state.
- Lines 330-348: delete `applyBrand`.
- Lines 420-455: delete the entire Brand `<div className="field">` block.
- Lines 1081-1088: delete `.brand-picker`, `.brand-btn`, `.brand-btn:hover`, `.brand-btn.on`, `.brand-btn:disabled`, `.brand-active`, `.brand-relaunch`.
- **`needsRelaunch` (line 72) becomes dead — delete it.** Verified: the brand switch was its only writer, and its only reader is the block at lines 448-455 being removed here.
- **`relaunchApp` (line 201) survives — keep it.** It has a second, brand-unrelated consumer at line 568, so `api.app.relaunch` and the `appRelaunch` IPC channel both stay.

**`src/renderer/screens/onboarding/WelcomeScreen.tsx`**

- Line 1: drop the `useBrand` import; line 49: drop `const brand = useBrand()`.
- Line 52: `<div className="fdy-welcome" data-brand={brand}>` → `<div className="fdy-welcome">`.
- Lines 160-166: delete the `.fdy-welcome[data-brand='murmur']` block. The `var(--murmur-ember, var(--cyan))` fallbacks resolve to the Prism values already, so no visual change.

**`src/renderer/mockFoundry.ts`**

- Line 11: drop `BrandId`; lines 31-32: delete the `BRAND` constant.
- Lines 153, 176, 180: drop `brand` from `defaultMockSettings` and its call.
- Lines 413-421: drop the brand-first path hint and the `brand` mock group.

**`src/renderer/design/tokens-base.css`** — line 3 comment references `tokens-murmur.css`. Update to name only `tokens-prism.css`.

### P1.9 Documentation

**`src/renderer/AGENTS.md`** — this file states the invariant that is being retired. Rewrite the two affected bullets:

- Replace _"Structural tokens in `design/tokens-base.css`, colours in `design/tokens-{prism,murmur}.css`. Exactly one brand sheet is imported, in `main.tsx`, chosen from `?brand=`... Never import a brand sheet from a component: a Prism build must not ship Murmur's palette."_ with a single-brand statement: structural tokens in `tokens-base.css`, colours in `tokens-prism.css`, all imported statically in `main.tsx`.
- Delete _"Brand is fixed per window (switching requires a relaunch). Read it with `useBrand()`, never from settings."_ — no longer true, and `useBrand` will not exist.

Leaving this file stale is the highest-cost documentation error in the repo: it is the first thing an agent reads before touching the renderer.

### P1.10 Phase 1 acceptance

```bash
cd apps/desktop
rg -i murmur src/ tests/ assets/ docs/ --stats     # expect: 0 matches
rg -i 'brandid|brand_labels|brand_ids|usebrand|applybranddockicon|readbrandsync' src/  # expect: 0
rg -i "data-brand" src/renderer                    # expect: only prism sheets + index.html guard
npm run check                                      # must be fully green
du -sh assets                                      # expect ~27 MB, was 93 MB
```

Then, manually:

1. Launch with an existing `settings.json` containing `"brand": "murmur"`. **Settings must load, not reset.** This is the destructive failure mode from §P1.4.
2. Launch with no `settings.json` (fresh install) and complete onboarding.
3. Confirm no white flash on launch — the FOUC guard still holds via `data-brand="prism"`.
4. Confirm the dock icon is correct in a packaged build (`npm run package`).

**Expected reduction: ~740 lines and ~66 MB.**

> Note on repo size: `.git` is 86 MB and `assets/brands/` is tracked. Deleting the tree removes it from the working copy and all future clones' checkouts, but the blobs stay in history, so `.git` will not shrink. That is fine and is not worth a history rewrite.

---

## Phase 2 — Hoist inline CSS out of `.tsx`

The 2,555-line problem from §1.1 (diagnosis). Phase 1 already removed one brand's worth of `[data-brand]` selectors, so the surviving CSS is simpler to relocate.

### 2.1 Strategy

The renderer has `css-modules.d.ts` and Vite is already configured for CSS. **Do not** introduce a CSS-in-JS dependency; the fix is moving existing global CSS into files, not changing the styling model.

For each component with a `<style>` block, in descending size order:

1. Create `ComponentName.module.css` next to the component.
2. Move the block's contents in verbatim.
3. Replace `className="foo"` with `className={styles.foo}`.
4. **Exception:** classes owned by `tokens-base.css` (`.btn`, `.field`, `.hint`, `.input`, `.select`, `.textarea`, `.row`, `.spread`, `.card`, `.badge`, `.mono`, `.faint`, `.dim`, `.scroll`, `.selectable`) stay as global strings. Delete the local redefinition and let the base rule apply.

Step 4 is the one that fixes Bug A. It will cause **visible spacing changes** wherever a component was silently overriding the base — the four `.field` variants in §1.2 differ in `gap` and `margin-bottom`. Two options, pick one and apply consistently:

- **(a)** Accept the base values and eyeball each screen. Cheapest, and arguably the point of having tokens.
- **(b)** Widen `tokens-base.css` with modifier classes (`.field.tight`) and opt the outliers in. Preserves pixels exactly, costs a little more CSS.

Recommend **(a)**, with (b) reserved for any case where (a) looks actually broken.

### 2.2 Order

Onboarding first — biggest blocks, most self-contained, lowest collision risk:

| Order | File                                     | CSS lines |
| ----- | ---------------------------------------- | --------- |
| 1     | `screens/onboarding/DoctorScreen.tsx`    | 332       |
| 2     | `screens/onboarding/WelcomeScreen.tsx`   | 331       |
| 3     | `screens/onboarding/ProjectScreen.tsx`   | 306       |
| 4     | `screens/onboarding/RosterScreen.tsx`    | 244       |
| 5     | `screens/onboarding/CliScreen.tsx`       | 200       |
| 6     | `screens/onboarding/FactoryScreen.tsx`   | 193       |
| 7     | `screens/onboarding/OnboardingShell.tsx` | 56        |

Then the three co-mounted collision pairs from §1.2, each as its own commit so a visual regression is bisectable:

| Order | Pair                                 | Colliding                            |
| ----- | ------------------------------------ | ------------------------------------ |
| 8     | `PipelinesScreen` + `PhaseEditor`    | `.field`, `.hint`, `.modes`, `.mode` |
| 9     | `RosterScreen` + `BoundaryEditor`    | `.hint`                              |
| 10    | `SettingsScreen` + `ProjectCommands` | `.row`                               |

Then the remaining 25 files, smallest first.

### 2.3 Guard against regression

Add a check that fails CI if a base-owned class is redefined inside a `<style>` block. The audit script that found these 22 lines:

```python
import re, glob
base = set(re.findall(r'^\.([a-z0-9-]+)', open('src/renderer/design/tokens-base.css').read(), re.M))
for f in glob.glob('src/renderer/**/*.tsx', recursive=True):
    for block in re.findall(r'<style>\{`(.*?)`\}</style>', open(f).read(), re.S):
        for line in block.split('\n'):
            m = re.match(r'\s*\.([a-z0-9-]+)\b[^{]*\{', line)
            if m and m.group(1) in base:
                print(f'{f}: redefines base class .{m.group(1)}')
```

Port it to `scripts/` as a Node script (the repo has no Python and `AGENTS.md` forbids adding any) and wire it into `npm run check`.

### 2.4 Phase 2 acceptance

- Inline `<style>` line count drops from 2,555 to under 400 (a few genuinely dynamic blocks may remain).
- The cross-file collision count drops from 61 to 0 for co-mounted pairs.
- New guard script passes and is part of `npm run check`.
- Manual pass over all six onboarding screens plus Pipelines, Roster, Settings.

**Expected reduction: ~300 lines net**, and the collisions stop being possible.

---

## Phase 3 — The two bug fixes

Small, high-value, independent of Phases 1-2. Can land first if you want a quick win.

### 3.1 `KIND_COLOR` → `derive.ts`

Add to `src/renderer/derive.ts`:

```ts
/** Phase-kind hues. `agent` is per-agent, so callers pass the resolved owner colour. */
const KIND_COLOR: Record<string, string> = { code: 'var(--blue)', engineer: 'var(--amber)' };

export function phaseKindColor(kind: string, ownerColor: string): string {
  return kind === 'agent' ? ownerColor : (KIND_COLOR[kind] ?? 'var(--cyan)');
}
```

The helper stays pure and takes `ownerColor` rather than calling `useApp()` itself, so it is usable from `derive.ts` without dragging a hook into a non-component module.

Update all four call sites to `phaseKindColor(phase.kind, agentColor(...))` and delete their local maps:

| File                            | Local map            | Call site |
| ------------------------------- | -------------------- | --------- |
| `components/PhaseEditor.tsx`    | line 8               | line 42   |
| `components/Waterfall.tsx`      | line 8               | line 35   |
| `components/PipelineRibbon.tsx` | line 4               | line 9    |
| `screens/PipelinesScreen.tsx`   | line 18 (`KIND_HUE`) | line 102  |

**`PipelinesScreen` changes colour.** Commands go amber → blue, checkpoints blue → amber, matching every other view. That is the fix, not a side effect. Note it in the commit message so it is not mistaken for a regression.

### 3.2 `PromptPreview` is missing its Esc handler

`InterruptSheet` and `DryRunSheet` both close on Escape. `PromptPreview` — same `.scrim` + `.sheet` structure — does not. Add:

```ts
// hooks/useEscapeToClose.ts
export function useEscapeToClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, enabled]);
}
```

Adopt in `PromptPreview` (fixes the bug) and `DryRunSheet` (dedupes). **Leave `InterruptSheet` alone for now** — its handler is guarded by `sendingRef` and maps Escape to `answer('reject')` rather than a plain dismiss. Fold it in during Phase 4 when `ModalShell` can express that.

### 3.3 One-line cleanup

`components/inspector/TranscriptLane.tsx:82` reimplements `derive.ts:55 phaseDuration` inline:

```ts
const elapsed = phase.startedAt
  ? new Date(phase.endedAt ?? now).getTime() - new Date(phase.startedAt).getTime()
  : null;
```

Replace with `const elapsed = phaseDuration(phase, now);`.

---

## Phase 4 — Extract shared components

Only after Phases 1-3. Extracting a component while its CSS still lives in five colliding `<style>` blocks means extracting the collision too.

Ordered by verified value:

| #   | Extract                                                          | Target                               | Sites                            | Net lines |
| --- | ---------------------------------------------------------------- | ------------------------------------ | -------------------------------- | --------- |
| 1   | `<Field label hint error>` + `TextInput` / `Select` / `Textarea` | `components/ui/Field.tsx`            | 39 `field`, 43 `hint`            | ~95       |
| 2   | `useDebouncedSave`                                               | `hooks/useDebouncedSave.ts`          | Pipelines, Roster, Settings      | ~52       |
| 3   | `<Button variant size>`                                          | `components/ui/Button.tsx`           | 22 `btn sm` + variants           | ~30       |
| 4   | `ModalShell` (scrim + sheet + Esc)                               | `components/ui/ModalShell.tsx`       | Interrupt, DryRun, PromptPreview | ~26       |
| 5   | `CodeBlock` (mono `pre`)                                         | `components/ui/CodeBlock.tsx`        | 6 files, verbatim CSS            | ~20       |
| 6   | `SegmentedControl`                                               | `components/ui/SegmentedControl.tsx` | PhaseEditor, BoundaryEditor      | ~11       |
| 7   | `useConfirmAction`                                               | `hooks/useConfirmAction.ts`          | 9 `window.confirm`               | ~30       |

### 4.1 Notes per item

**`Field`** must spread `className` and support the existing escape hatches: `field-warn` and `field-note ok` (Settings), `span2` grid span (Roster), and the `mono` input variant. Without those it will not cover all 39 sites.

**`useDebouncedSave`** is the highest-risk item. All three call sites use `JSON.stringify` dirty-checking plus a flush-on-unmount that re-saves pending edits. Getting the flush wrong **silently loses user edits** when switching pipeline or agent. Parameterise `delay` (Settings 400 ms, Pipelines/Roster 350 ms), `validate?`, `compare`, `save`, `onSuccess`, `onError`. Keep `plain()` at the call site per the `api.ts` invariant. Test by typing fast and navigating away mid-debounce.

**`ModalShell`** needs `dismissible={false}` for `InterruptSheet`, which must not close on backdrop click and maps Escape to `answer('reject')`. z-index (90 vs 100) and blur (6px vs 8px) become props or tokens.

**`SegmentedControl`** is the cleanest win: `.modes` / `.mode` / `.mode.on` are byte-identical between `PhaseEditor.tsx:510-512` and `BoundaryEditor.tsx:97-100`, differing only by a `margin-bottom` and a `:hover`.

**`useConfirmAction`** should keep `window.confirm` inside the hook. Swapping to an async dialog changes UX and is a separate decision. Only the `try/catch` → `setErrors` → `refresh` plumbing gets deduped; per-site guards like `selected.builtin` stay at the call site.

---

## Phase 5 — Dead CSS sweep

After Phase 1 removes `tokens-murmur.css`, these Prism selectors have **zero** `className` matches anywhere in `.tsx` (verified by grep):

| File                                | Selector                                 | Lines |
| ----------------------------------- | ---------------------------------------- | ----- |
| `design/prism/prism.css`            | `.glass`                                 | 53-65 |
| `design/prism/prism.css`            | `.glass-strong`                          | 70-73 |
| `design/prism/prism.css`            | `.glass::after`, `.cinema .frame::after` | 83-97 |
| `design/prism/prism-animations.css` | reduced-motion rules for the above       | 18-28 |

`.cinema` and `.frame` are relics of the PrismField background removed in `094b077` / `7ab6214`. `.glass` was documented as "opt-in via `.glass`" and never opted into.

`.dim` in `tokens-base.css:103-105` **is not dead** — verify before deleting. The earlier grep matched substrings (`sum-dim`, `pl-tr-meta-dim`); re-check for a standalone `dim` token in a `className` list.

Keep `.prism-header-rule` — used at `App.tsx:168`.

**Expected reduction: ~30 lines.**

---

## Totals

| Phase                 | Lines      | Bytes      |
| --------------------- | ---------- | ---------- |
| 1 — Remove Murmur     | ~740       | ~66 MB     |
| 2 — Hoist inline CSS  | ~300       | —          |
| 3 — Bug fixes         | ~10        | —          |
| 4 — Shared components | ~264       | —          |
| 5 — Dead CSS          | ~30        | —          |
| **Total**             | **~1,344** | **~66 MB** |

Against 13,264 lines in `src/renderer`, that is roughly a **10% reduction**, plus two user-visible bugs fixed and a class of CSS collision made structurally impossible.

---

## Risk register

| Risk                                                                          | Phase | Severity | Mitigation                                                                                                            |
| ----------------------------------------------------------------------------- | ----- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| Settings wipe on upgrade from a legacy `brand` key                            | 1     | **High** | Verify zod strict-vs-strip behaviour before shipping; test with a real `settings.json` containing `"brand": "murmur"` |
| Visual drift when components stop overriding base `.field` / `.row` / `.hint` | 2     | Medium   | One commit per file; manual pass per screen; option (b) modifiers where (a) looks broken                              |
| `useDebouncedSave` flush bug loses in-flight edits                            | 4     | **High** | Mirror existing cleanup semantics exactly; test fast-typing then immediate navigation                                 |
| `PipelinesScreen` colour flip read as a regression                            | 3     | Low      | Intentional; call it out in the commit message                                                                        |
| `knip` failing on orphaned `useReducedMotion` / `needsRelaunch`               | 1     | Low      | Both confirmed orphaned by the flock/picker removal; delete in the same commit                                        |
| FOUC on launch if `data-brand` is dropped                                     | 1     | Medium   | Keep `data-brand="prism"`; `index.html:22` depends on it                                                              |
| Broken asset paths after `assets/brands/` deletion                            | 1     | Medium   | Root fallbacks are md5-identical to Prism (verified); test packaged build                                             |

---

## Commit sequence

```
1.  chore: remove Murmur brand assets and stylesheet
2.  refactor: collapse brand plumbing to Prism-only (main, shared, preload)
3.  refactor: remove brand picker and MurmurFlock from renderer
4.  docs: update renderer AGENTS.md for single-brand model
5.  fix: unify phase-kind colours in derive.ts (PipelinesScreen was inverted)
6.  fix: add missing Escape handler to PromptPreview
7.  refactor: TranscriptLane uses derive.phaseDuration
8.  refactor: onboarding screens to CSS modules          (7 commits, one per screen)
9.  refactor: resolve co-mounted class collisions        (3 commits, one per pair)
10. build: fail check on base-class redefinition in <style>
11. refactor: extract Field / Button / ModalShell / ...  (7 commits, one per component)
12. chore: drop dead .glass and .cinema selectors
```

`npm run check` green at every step.
