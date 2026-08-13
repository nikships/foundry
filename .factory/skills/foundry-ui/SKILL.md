---
name: foundry-ui
description: Launch the Foundry native Electron app and drive it with agent-browser for UI testing, navigation, and screenshots. Use when asked to launch Foundry, look at / verify the app UI, navigate its screens (Runs, Run detail, Inspector, Pipelines, Roster, Settings, Onboarding), or capture screenshots of the desktop app. Never use a web browser for this; drive the real Electron app.
---

# Foundry Desktop App: Launch, Navigate, Screenshot

Foundry is the native macOS Electron app at the repo root. This skill covers
launching the real Electron binary with CDP enabled, connecting agent-browser,
and navigating every screen.

**Do not open the renderer in a web browser.** The renderer needs the preload
bridge (`window.foundry` IPC); in a plain browser every screen is dead.
**Do not use computer-use / accessibility** either: the Electron window
exposes only chrome buttons (close/minimize) to the AX tree, none of the UI.
agent-browser over CDP is the only workable driver.

## Launch

Build output must exist (`npm run build` emits `out/`; `electron .` loads
`out/main/main.js`, so rebuild after source changes). The app enforces a
single-instance lock per user-data dir.

The automated counterpart of this skill is `npm run test:e2e` (Playwright
`_electron.launch()` against isolated fixtures in `tests/e2e/`). Use that for
regression; use this skill for interactive exploration. Do not open a web
browser either way.

```bash
cd /path/to/foundry

# 0. Check nothing is already running (single-instance lock)
pgrep -fl "electron ." || true

# 1. Build if out/ is missing or stale
[ -d out/main ] || npm run build

# 2. Launch with CDP (background it; it never exits on its own)
./node_modules/.bin/electron . --remote-debugging-port=9250 &

# 3. Connect (wait for the window)
sleep 4
agent-browser connect 9250
agent-browser tab   # expect: [t1] Foundry - file://.../out/renderer/index.html
```

Variants:

```bash
# Isolated instance with fresh state (triggers Onboarding, bypasses the
# single-instance lock, leaves real state untouched):
./node_modules/.bin/electron . --remote-debugging-port=9251 \
  --user-data-dir=/tmp/foundry-test-state &
agent-browser --session onboard connect 9251   # named session = second app

# Narrow window for responsive testing (min width 600, default 1440x940):
FOUNDRY_WIDTH=700 ./node_modules/.bin/electron . --remote-debugging-port=9250 &
```

Real state lives at `~/Library/Application Support/foundry/foundry/`
(`settings.json`, `pipelines.json`, `roster.json`, `projects.json`,
per-project trace DBs under `projects/`). Don't edit while the app runs.

Cleanup when done: `kill <electron pid>` (and `rm -rf` any temp
`--user-data-dir` you created).

## Driving it

Standard agent-browser snapshot/ref workflow:

```bash
agent-browser snapshot -i          # interactive elements with @refs
agent-browser click @eN
agent-browser screenshot /tmp/shot.png
```

- Refs renumber on every snapshot; always re-snapshot after navigating.
- There is exactly one CDP target (no webviews); `tab` shows one page.
- `click "text=..."` selectors are unreliable here; click sidebar/@refs.
- The UI is the dark Factory theme; screenshots are mostly black with
  light text. That is correct, not a rendering failure.
- View shortcuts work through CDP: `agent-browser press Meta+1` (Runs),
  `Meta+2` (Pipelines), `Meta+3` (Roster), `Meta+4` (Inspector),
  `press "Meta+,"` (Settings — quote the comma). Handled in the renderer, so
  they fire for synthetic input even though the native menu also claims them.
- Escape ladder: an open overlay (Dry run / Prompt preview) closes first;
  otherwise a focused field blurs; otherwise Run detail goes back to Runs.
- Tab strips (Pipelines / Roster / Settings) are roving-tabindex tablists:
  focus the selected tab and use ArrowLeft/ArrowRight (wrap), Home/End;
  selection follows focus.

## Navigation model

No URL routing; one window, view state in React. The left sidebar is always
present (except during Onboarding):

| Sidebar button (snapshot label) | View                     | CDP shortcut     |
| ------------------------------- | ------------------------ | ---------------- |
| `button "Runs ⌘1"`              | Runs list + run composer | `press Meta+1`   |
| `button "Pipelines ⌘2"`         | Pipeline editor          | `press Meta+2`   |
| `button "Roster ⌘3"`            | Agent roster editor      | `press Meta+3`   |
| `button "Inspector ⌘4"`         | Live trace viewer        | `press Meta+4`   |
| `button "Settings ⌘,"`          | Settings panes           | `press "Meta+,"` |

The sidebar also has the project `combobox` (switch active project) and
`button "Add another project…"` — **do not click the latter in automation**:
it opens a native folder picker CDP cannot drive (if stuck, `press Escape`
won't help; you must dismiss it manually or kill the app).

## Screens

### Runs (home, default view)

- Heading "Runs", `checkbox "Show archived"`.
- Composer: `textbox "What should the factory build? ..."`, pipeline
  `combobox` (Prompt / Scout / Plan / Plan → Build / Plan → Build → Test /
  Plan → Build → Review / Full SDLC), `button "Start run"` (disabled while
  the textbox is empty).
- One button per past run; the label packs status, pipeline, age, prompt
  excerpt, `run_*` id, duration, tokens. Click it to open Run detail.

**Warning:** filling the composer and clicking "Start run" spawns real agent
CLIs and spends real tokens. Never start a run unless explicitly asked.

### Run detail

Click a run row on Runs. Contains:

- `button "← Runs"` (back), `button "Inspector"` (deep-link this run into the
  Inspector), `button "Cost"` (toggles per-phase cost table: Model / Turns /
  In / Out / Cache read / Thinking / Credits; becomes `"Hide cost"`).
- Outcome banner ("Accepted — 'review' approved the work", `merged` chip).
- Phase Gantt: one `button` per phase, labels like `planner plan 1m 34s`,
  `builder build ×2 3m 17s`, `commit_plan 1.1s`. Click to select a phase.
- Right pane for the selected phase: tab buttons `Timeline`, `Envelope`,
  `Gates`, `Prompt` (labels include counts, e.g. `button "Timeline29"`).
  Timeline rows are expandable buttons: `⚙ read: path`, `· assistant`,
  `$ cmd`, `⛨ gate_name`, `∑ agent` (envelope), `▸/→/▪` phase markers.

### Inspector

Live trace viewer, cards per phase in a two-column masonry. Top bar:

- `combobox "Follow latest run"` — bare navigation follows whatever is live;
  options list past runs (`Full SDLC · accepted · 04:51:20 · 12h ago`).
- Filters `All` / `Running` / `Failed`, toggle `button "Raw files"` (shows a
  flat chronological list of every file READ/EDIT/CREATE/SEARCH and `$`
  command across the run; toggle again to go back).
- `⤢` buttons expand individual tool-call cards.

### Pipelines

Tabs across the top, one per pipeline with phase count: `tab "Prompt 1"`,
`tab "Scout 1"`, `tab "Plan 2"`, ... `tab "Full SDLC 8"`, plus
`button "+ New pipeline"`, `button "Dry run"`, `button "Duplicate"`.

- Editor: name/description textboxes, a horizontal phase ribbon
  (`button "01 plan AGENT droid planner · plan"` ...), add buttons `Agent` /
  `Command` / `Checkpoint`.
- PHASES region: each phase row expands to name textbox, agent combobox
  (planner/builder/scout/reviewer/documenter), envelope combobox
  (plan/build/review/scout/document/generic), description, input chips,
  gate checkboxes (`artifacts_exist`, `files_non_empty`, `json_parses`,
  `diff_matches_claims`, `verdict_consistent`), failure-routing combobox,
  `Optional` checkbox, reorder `↑`/`↓` and delete `✕`.
- ACCEPTANCE region: policy combobox (Every phase passed / The last phase
  passed / envelope reports success / envelope sets a flag + phase & flag
  comboboxes), `Isolated git worktree` checkbox.
- `Dry run` opens an overlay showing the exact SYSTEM/USER prompt each agent
  phase would receive against a sample request. Nothing is sent; safe to
  click. Close with `Esc` or the `Close` button.
- Edits save automatically ("Changes save automatically" in the footer);
  validation status bottom-left ("This pipeline is ready to run").

### Roster

Tabs per agent (`tab "planner ..."`, builder, scout, reviewer, documenter) +
`button "+ New agent"`. Per agent:

- `button "Preview prompt"` — overlay with the rendered SYSTEM/USER prompt
  (safe, close with Esc). `button "Duplicate"`.
- IDENTITY: name, purpose, accent color buttons.
- EXECUTION: CLI vendor combobox (Factory droid / Claude Code / OpenAI Codex /
  JetBrains Junie / Grok Build), model combobox + `Refresh`, reasoning-effort
  radios (OFF/LOW/MEDIUM/HIGH), envelope-kind combobox.
- PROMPTS: two large textboxes (system prompt, user template).

Renaming a shipped agent copies it under the new name (pipelines keep
working); changing CLI vendor resets the model choice.

### Settings

Tabs: `General`, `Agent CLIs`, `Agent defaults`, `Project`, `Maintenance`,
`About`.

- General: identity (engineer name), environment checks + `Re-check`,
  notification checkboxes, `Check for updates`, `Relaunch Foundry`,
  `Quit Foundry` (avoid the last two in automation unless intended).
- Agent CLIs: per-vendor binary path textbox + extra-args textbox +
  `Install docs`; environment checks.
- Agent defaults: default model + reasoning effort, autonomy combobox,
  limits (envelope retries, gate retries, turn timeout, trace poll cadence).
- Project: project name, path + `Reveal in Finder`, repository checks
  (git repo, base ref, submodules, clean worktree, project commands,
  leftover run worktrees + `Fix`), base ref, merge policy.
- Maintenance: run-history retention, `Apply retention now`,
  `Compact trace databases`, leftover worktrees with `Remove` buttons
  (destructive: deletes branch + uncommitted work; don't click casually).
- About: version info.

Deep-linking: RunsScreen surfaces problems as "Open Settings" links that land
on a specific pane.

### Onboarding

Shown instead of the whole shell when settings have `onboarded: false`
(always on a fresh `--user-data-dir`). Stepper nav: Welcome → Factory →
Roster → CLIs → Ready → Project.

- Welcome: `button "Begin"`.
- Factory / Roster: info pages, `Back` / `Continue`.
- CLIs: radios per vendor showing detection (`Ready` / `Not installed` /
  `Needs sign-in`), pick the default harness.
- Ready (doctor): per-CLI checks, `Re-check environment`, `Continue`.
- Project: name textbox + `button "Choose a repository…"` (native folder
  picker — automation dead end) and `Enter Foundry` (disabled until a repo is
  chosen). To test the main UI without picking a repo, use the real state
  instead, or pre-seed the temp dir's `settings.json` with `"onboarded": true`.

## Troubleshooting

- **`connect` refused**: app not up yet (`sleep 4`), or launched without the
  flag, or another instance held the single-instance lock so your process
  exited immediately (`pgrep -fl "electron ."` to check; use a separate
  `--user-data-dir` to run alongside).
- **Blank/stale UI after code changes**: `electron .` serves the last build;
  run `npm run build` and relaunch. For live HMR use `npm run dev` (but flag
  passthrough for the debug port is unreliable; prefer built launches).
- **Buttons do nothing**: an overlay (Dry run / Prompt preview / interrupt
  sheet) may be capturing input — `agent-browser press Escape` — or a native
  dialog is open, which CDP cannot see or dismiss.
- **electron binary missing** (`electron/dist` not installed):
  `node node_modules/electron/install.js`.
