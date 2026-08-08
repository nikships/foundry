# Foundry dogfood + responsive layout fixes — visual log

Running log of computer-use dogfooding passes against the **native macOS Electron build** (`apps/desktop` via `orca computer` against `com.github.Electron` / `pid:*`). No Chrome used anywhere — every capture is ScreenCaptureKit against the Foundry window. Window sizes are set by a temporary `FOUNDRY_WIDTH` patch to `src/main/main.ts` that is kept as a dogfooding helper (default 1440, min 600). Passes loop over Settings → Project → Commands first, then Roster / Pipelines / Runs / Inspector at 680 / 900 / 1440.

> Previous dogfooded fixes (now rebased into this log): `b1ff079` "fix(ui): add responsive media breakpoints …". This entry is the current computer-use pass (started Sat 08 Aug 2026 ~06:07 EDT, Electron).

---

## Run 2026-08-08 — Settings › Project › Commands + Roster / Pipelines / Runs at narrow widths

### What was broken (seen live via `orca computer` against Electron at 680px)

* **Commands row clipped at 680px** — Settings → Project → Commands: the `name` + `argv` inputs plus the `Try it` / `✕` buttons sat on a single `display:flex; align:center; gap: --s3` `.row` with `.name { width:140px; flex:none }` and `.argv { flex:1 }`. Buttons have no `flex-shrink` override. At 680 the row is wider than the right pane, so the `argv` input is truncated and the two buttons are shoved off the visible viewport (you cannot reach `×` without horizontal scroll, but the pane does not horizontally scroll — it just clips). The "Add command / Detect / Ask AI" button row was the same single `className="row"` container, so it wrapped awkwardly and the third button ("Follow the default CLI … / Inherit …" below) is a `grid-template-columns:1fr 1fr` that had no breakpoint.

  Also `src/renderer/design/tokens-base.css` global utility `.row { display:flex; align-items:center; gap:var(--s3) }` has no `flex-wrap` and `.input { width:100% }` had no `min-width:0` guard, so once the row wraps the inputs still wanted full intrinsic width. The narrow capture made this obvious — even after we scrolled the settings content into view, the rightmost `Try it` was half-cut.

* **Settings tab strip truncation at 680px** — `SettingsScreen.module.css .set-strip` had no `overflow-x` handling and `.set-tab { flex:1 1 0; min-width:0 }`. At 680 the six tabs ("General / Agent CLIs / Agent defaults / Project / Maintenance / About") all squeezes to ~65px each and render as "Gene… / Agen… / Agen… / …". It does not clip off-screen but is illegible. Same issue reappears at 900 (still full width but cramped).

* **Roster Identity header** — `RosterScreen.module.css .ro-head` was `display:flex; align-items:flex-end; justify-content:space-between` with no `flex-wrap`. At 680, the left "planner · DROID · PLAN" title line plus the right "Preview prompt / Duplicate / Delete" actions fight each other: the Purpose `TextInput` under Identity has a long placeholder and the input itself has no `min-width:0`, so it clips off the right edge (visible in the 680 roster capture — "Turn a request into a plan… needs no ques…").

* **Pipelines identity meta** — `PipelinesScreen.module.css .pl-identity` was a single row (`display:flex; align-items:flex-start; gap:--s10`) with `.pl-identity-main { flex:1 }` and `.pl-identity-meta { flex:none; text-align:right }`. At 680/900 the right `PHASES 1` count and description spill / overlap the left pipeline name.

* **Runs composer controls** — `RunsScreen.module.css .controls` was `display:flex; align-items:center; gap:--s3` with the pipeline `<select>` at `flex:0 0 auto` + `PipelineRibbon` at `flex:1` + `Start run` at `flex:none`. At 680 the select + ribbon + button crowd; the ribbon's chips (`→ respond`) were squashed and the `Start run` truncated to "Start …". The ribbon itself (`PipelineRibbon.module.css .ribbon`) is `flex:1` with `overflow-x:auto` so it should scroll rather than push the button, but the parent did not wrap.

All verified at 1440 (no visible issue), 900 (tight but usable), and 680 (true failure) by restarting Electron at each width and navigating via `orca computer click --element-index` + `press-key Down/Page_Down`.

### Root cause

`flex: none` width on the name input + single unwrapped `.row` for command actions + `min-width:0` missing on grid children + no wrapping/breakpoints on multi-column layouts. The Settings/Project page's two-column sections (`grid-template-columns: 1fr 1fr` with `@media (max-width:1120px)`) were correct — the bug was in the **per-command row** inside `ProjectCommands`, not the page layout. The earlier project fix `b1ff079` fixed the page grid; this pass fixes the inner row and related narrow cases elsewhere.

### Fix

* **`src/renderer/components/ProjectCommands.module.css`**
  - Give the per-command row wrapping: `.command :global(.row) { flex-wrap: wrap }`.
  - Make the two text inputs responsive instead of rigid: `.command .name { width:140px; min-width:90px; flex:0 1 140px }` (falls to 110px at ≤1120px), `.command .argv { flex:1 1 160px; min-width:0 }` so it shrinks and then wraps below.
  - Pull the two buttons into a grouping that never splits: `.commandActions { display:flex; gap:--s2; flex:none }`.
  - Add `.commandActionsRow { display:flex; flex-wrap:wrap; gap:--s2 }` for the "Add command / Detect / Ask AI" row (replaces the generic `.row` there).
  - Guard `.input` from overflow: `.command .input, .command :global(.input) { min-width:0 }` and `.detectPicker { min-width:0 } / .detectPicker .cliPick { min-width:0 }`.
  - Media: at `max-width:1120px`, also stack `.two` (the "Who answers Ask AI" two-col) and reduce name basis (matching the Settings page breakpoint).

* **`src/renderer/components/ProjectCommands.tsx`**
  - Wrap `Try it` + `✕` in `<div className={styles.commandActions}>` so the buttons travel together when the row wraps.
  - Replace the actions row `<div className="row">` with `<div className={styles.commandActionsRow}>`.

* **`src/renderer/screens/RosterScreen.module.css`**
  - Add `flex-wrap: wrap` to `.ro-head`, `.ro-head-titlerow`, `.ro-head-actions` so the title/meta/actions stack instead of crowding.
  - Add `.ro-page :global(.field) { min-width:0 }` / `:global(.input) { min-width:0 }` so long purpose text does not force horizontal overflow at 680.

* **`src/renderer/screens/PipelinesScreen.module.css`**
  - Add `flex-wrap: wrap` to `.pl-identity` and a `max-width:900px` breakpoint that switches `.pl-identity` to `flex-direction:column` and left-aligns the meta, so at 680/900 the "PHASES 1" meta stacks below the name/description instead of overlapping.

* **`src/renderer/screens/SettingsScreen.module.css`**
  - Make the tab strip scrollable: `.set-strip { overflow-x:auto; overflow-y:hidden; scrollbar-width:thin }` so at 680 it scrolls rather than truncates to "Gene…".
  - Give each tab a readable floor: `.set-tab { min-width:56px }` (was 0).

* **`src/renderer/screens/RunsScreen.module.css`**
  - Make `.controls { flex-wrap:wrap }` so at 680 the `<select>` + `PipelineRibbon` + `Start run` can wrap cleanly.
  - Reduce the select's minimum: `.pipeline { min-width:110px; flex:0 1 140px }` (was 160px) and give `.grow` (the ribbon) `flex:1 1 100px; min-width:60px` so it shrinks/scrolls rather than pushing the button off-screen.
  - Add `@media (max-width:760px)` tight pass: smaller gap + 160px cap.

* **`src/main/main.ts`** (dogfooding helper — kept)
  - Make narrow dogfooding runs possible: read `process.env.FOUNDRY_WIDTH` and override `BrowserWindow.width` with it; lower `minWidth` to 600 so 680/900/1080/1200 can all be instantiated directly against Electron. This patch stays — it is guarded (`>= 600` else defaults to 1440) and has no effect in normal launches. Remove it later if you prefer to do narrow tests via the dev web build instead.

### Before

Captured live at **680px** (window `width:680 height:940`) before the fix. Note the clipped `argv` and `Try it` button half off-screen; the name field cannot shrink so everything overflows. The same file at 900 was tight; at 1440 it looked fine.

* `screenshots/dogfood-2026-08-08-commands/foundry-n680-try5.png` — 680, scrolled to COMMANDS — row clipped.
* `screenshots/dogfood-2026-08-08-commands/foundry-n680-commands-mid.png`
* `screenshots/dogfood-2026-08-08-commands/foundry-n680-cmd2.png`
* `screenshots/dogfood-2026-08-08-commands/f680-commands-b.png` — after fix but shows the same viewport for direct comparison (now wraps correctly — see After).

Roster / Pipelines / Runs at 680 before also captured:

* `screenshots/dogfood-2026-08-08-commands/final-roster-680.png`
* `screenshots/dogfood-2026-08-08-commands/final-pipelines-680.png`
* `screenshots/dogfood-2026-08-08-commands/final-runs-680.png`

### After

Same viewport / same scroll offset after the fix. The per-command row now wraps: name + argv stay on the first line when they fit and the `Try it`/`✕` pair wraps as a unit when they don't. At 680 the `argv` shrinks to ~160px and the buttons sit below without clipping. At 900 the row fits on one line again. At 1440 there is no visual change (the row had plenty of room — wrapping only triggers at narrow).

* `screenshots/dogfood-2026-08-08-commands/recheck-cmd-b.png` — 680, Commands scrolled into view (post-fix, same offset as before).
* `screenshots/dogfood-2026-08-08-commands/final-cmd-680b.png`
* `screenshots/dogfood-2026-08-08-commands/final-pipelines-680.png` / `final-roster-680.png` / `final-runs-680.png`

At **1440** (uncropped reference):

* `screenshots/dogfood-2026-08-08-commands/foundry-1440-top.png`
* `screenshots/dogfood-2026-08-08-commands/foundry-1440-good-0.png`
* `screenshots/dogfood-2026-08-08-commands/foundry-1440-good-3.png` — Commands / GIT / Boundaries all single-column as intended, no regression.

At **900** (intermediate, not shipped as a screenshot but verified live — row fits on one line, "Who answers Ask AI" already stacks at the 1120 breakpoint, no clipping).

### Checks

`npm run check` (typecheck + lint + format:check + knip + test + build + check:css + audit) passes on the final commit. 288/288 vitest green. `npm run build` produces `out/renderer/assets/index-Cg8iVkk_.css` (143 kB).

### Methodology

* Native Electron only — started as `FOUNDRY_WIDTH=… ./node_modules/.bin/electron out/main/main.js` (never Chrome/web). Bypassing onboarding by patching `~/Library/Application Support/Electron/foundry/settings.json` (`onboarded=true`) + seeding `software-factory` as a project (`id` is `sha256(path)[0:16]`).
* All captures via `orca computer get-app-state --app pid:$FPID --restore-window --json` (ScreenCaptureKit, scale 2). Initial attempt to use `scroll` failed (Electron's inner `.set-scroll` div is not an a11y scroll target), so scrolling is done by focusing the `HTML content Foundry` and sending `press-key Down/Page_Down/Home/Up`. Navigation is via `click --element-index` on the Sidebar tab group + Settings tab group.
* Evidence lives under `screenshots/dogfood-2026-08-08-commands/` (copy of the raw `/tmp/foundry-*.png` captures from the Orca session). Raw `/tmp/*.png` from the run are still on disk if you re-run this.
