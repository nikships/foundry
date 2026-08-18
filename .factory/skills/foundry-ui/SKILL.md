---
name: foundry-ui
description: Use when you want to run the app like a human.
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

**Do not write a throwaway Playwright spec to stand in for this skill.** They
are not interchangeable: `tests/e2e/` holds committed regression specs, while
validating your own change is what this skill is for (AGENTS.md: "Use
foundry-ui skill to validate larger changes", "do not add a second harness").
If launching seems blocked, work the checklist below rather than switching
harnesses — every reported "the launch is blocked" case so far has been one of
the traps listed there.

```bash
cd /path/to/foundry

# 0. Check nothing already holds the lock. Match BOTH the packaged app and
#    a leftover `electron .` — either one will make the next launch exit.
pgrep -fl "electron \." || true
pgrep -fli "/Applications/Foundry.app" || true

# 1. Build if out/ is missing or stale
[ -d out/main ] || npm run build

# 2. Launch with CDP. Plain `&` is correct. Redirect output so the DevTools
#    listener line on stderr does not look like a crash.
./node_modules/.bin/electron . --remote-debugging-port=9250 \
  > /tmp/electron.log 2>&1 &

# 3. Connect (wait for the window). Safe to run in a later shell call.
sleep 4
curl -s http://127.0.0.1:9250/json/version   # liveness proof, not $?
# If that is empty, the packaged app almost certainly won the lock. See below.
agent-browser connect 9250
agent-browser tab   # expect: [t1] Foundry - file://.../out/renderer/index.html
```

**Backgrounding works, including across separate tool calls.** A plain `&`
launch keeps running after the shell call that started it returns; step 3 above
connects fine from a later call. Before concluding the app was killed, prove it
with `pgrep -fl "electron \."` and a `curl` of the CDP port. Four things
routinely masquerade as an environment blocker:

- **Packaged `/Applications/Foundry.app` holds the lock.** `electron .` then
  prints `DevTools listening on ws://127.0.0.1:9250/...` and exits 0. `curl`
  of `/json/version` is empty, `pgrep -fl "electron \."` is empty, and
  `pgrep -fli Foundry` shows the packaged PID. **Do not kill the packaged
  app** — it is the user's live install. Relaunch isolated instead:

  ```bash
  ./node_modules/.bin/electron . --remote-debugging-port=9251 \
    --user-data-dir=/tmp/foundry-ui-state \
    > /tmp/electron-ui.log 2>&1 &
  sleep 4
  curl -s http://127.0.0.1:9251/json/version
  agent-browser --session foundry-ui connect 9251
  ```

  A fresh `--user-data-dir` starts Onboarding. To skip it, seed
  `<dir>/foundry/settings.json` with `"onboarded": true` (and a project if
  you need the main shell), or use the user's real state only when Foundry.app
  is not running.

- **`setsid` does not exist on macOS.** `nohup setsid electron . &` fails with
  `nohup: setsid: No such file or directory` — nothing ever launched. Do not
  reach for `setsid`; plain `&` is what works here.
- **`$!` is often the wrong PID.** `nohup` and `setsid` fork, and `open -n -a`
  hands off to launchd and exits immediately. In all three the app may be
  running while the PID you captured is gone. Match on `pgrep -fl` instead.
- **stderr is not death.** Electron prints `DevTools listening on ws://…` to
  stderr at startup. That line means Chromium started; it does **not** mean
  the instance won the lock. Confirm with `curl` of `/json/version`.

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

Cleanup when done: `kill` the `electron .` PID from `pgrep` (and `rm -rf` any
temp `--user-data-dir` you created). Never kill `/Applications/Foundry.app`.

## Driving it

Standard agent-browser snapshot/ref workflow:

```bash
agent-browser snapshot -i          # interactive elements with @refs
agent-browser screenshot /tmp/shot.png
```

### `click` is 30x slower than alternatives — avoid it

**`agent-browser click` takes ~5 seconds every time** due to a DOM-stability
wait that never resolves early in this app. `press`, `fill`, `type`, and `eval`
all complete in ~0.17s. Measured:

| Method      | Time     | When to use                                 |
| ----------- | -------- | ------------------------------------------- |
| `press`     | 0.17s    | All navigation (shortcuts)                  |
| `fill`      | 0.17s    | Text fields                                 |
| `type`      | 0.17s    | Keystroke-level input                       |
| `eval`      | 0.17s    | Clicking elements with no keyboard shortcut |
| **`click`** | **5.2s** | **Last resort only**                        |

**Click an element via `eval` instead of `click`.** Wrap the script in an IIFE
so `return` is legal — a top-level `return` throws `Illegal return statement`:

```bash
# By data-testid (preferred — stable across label changes):
agent-browser eval 'document.querySelector("[data-testid=\"agent-tab-builder\"]").click()'

# Confirm where you landed (no snapshot needed):
agent-browser eval 'document.querySelector("[data-testid=\"app-view\"]")?.dataset.view'

# Open a past run by id (do not match concatenated snapshot text):
agent-browser eval 'document.querySelector("[data-testid=\"run-row-run_260808_475d93\"]")?.click()'

# By role + text (when no data-testid):
agent-browser eval '(() => { const t = [...document.querySelectorAll("[role=tab]")].find(el => (el.textContent||"").includes("builder")); t?.click(); return !!t; })()'
```

`button.textContent` concatenates every descendant with no spaces
(`AcceptedFull SDLC4d ago…`). Snapshot labels insert spaces. Never search
`textContent` for a `run_*` id that only appears as a visual child — use
`data-testid="run-row-{runId}"` or `data-run-id`.

### Fast navigation cheat sheet

Every screen is reachable via keyboard shortcuts, which are instant. After
each jump, read `data-view` instead of snapshotting just to confirm arrival:

```bash
# Top-level views (sidebar):
agent-browser press Meta+1        # Runs          → data-view="runs"
agent-browser press Meta+2        # Inspector     → data-view="inspector"
agent-browser press Meta+3        # Design        → data-view="design"
agent-browser press Meta+4        # Pull Requests → data-view="prs"
agent-browser press "Meta+,"      # Settings      → data-view="settings"

# Design sub-tabs (must be on Design first, or they switch you there):
agent-browser press 'Meta+Shift+1'  # Design → Pipelines  (+ data-design-tab="pipelines")
agent-browser press 'Meta+Shift+2'  # Design → Agents     (+ data-design-tab="agents")
agent-browser press 'Meta+Shift+3'  # Design → Envelopes  (+ data-design-tab="envelopes")

# Confirm without a snapshot:
agent-browser eval 'const el = document.querySelector("[data-testid=\"app-view\"]"); el && {view: el.dataset.view, run: el.dataset.openRun, design: el.dataset.designTab, settings: el.dataset.settingsPane}'
```

Settings panes have no chord. Once on Settings, eval the tab — do not walk
ArrowRight from a guessed selected tab:

```bash
agent-browser eval 'document.querySelector("[data-testid=\"settings-tab-project\"]")?.click()'
# data-settings-pane becomes "project"
```

### `data-testid` reference

Stable selectors on key interactive elements. Use with `eval` +
`querySelector` for reliable, instant clicks:

| `data-testid`              | Element                                     |
| -------------------------- | ------------------------------------------- |
| `app-view`                 | `<main>` — current view + sub-state         |
| `nav-runs`                 | Sidebar → Runs button                       |
| `nav-inspector`            | Sidebar → Inspector button                  |
| `nav-design`               | Sidebar → Design button                     |
| `nav-prs`                  | Sidebar → Pull Requests button              |
| `nav-smith`                | Sidebar → Smith button                      |
| `nav-settings`             | Sidebar → Settings button                   |
| `project-selector`         | Project dropdown trigger                    |
| `sidebar-collapse`         | Collapse/expand sidebar toggle              |
| `tab-pipelines`            | Design → Pipelines tab                      |
| `tab-agents`               | Design → Agents tab                         |
| `tab-envelopes`            | Design → Envelopes tab                      |
| `agent-tab-{name}`         | Agent roster tab (e.g. `agent-tab-builder`) |
| `agent-new`                | "+ New agent" button                        |
| `pipeline-selector`        | Pipeline picker dropdown trigger            |
| `pipeline-option-{id}`     | Pipeline option in the picker dropdown      |
| `pipeline-new`             | "New pipeline" button in the picker         |
| `run-request`              | Run composer request textarea               |
| `run-pipeline`             | Run composer pipeline dropdown              |
| `run-start`                | "Start run" button                          |
| `run-row-{runId}`          | One past-run row on Runs                    |
| `run-back`                 | Run detail ← Runs button                    |
| `run-open-inspector`       | Run detail → Inspector deep-link button     |
| `phase-tab-timeline`       | Run detail → Timeline                       |
| `phase-tab-envelope`       | Run detail → Envelope                       |
| `phase-tab-gates`          | Run detail → Gates                          |
| `phase-tab-prompt`         | Run detail → Prompt                         |
| `inspector-run`            | Inspector run picker                        |
| `inspector-filter-all`     | Inspector filter: All                       |
| `inspector-filter-running` | Inspector filter: Running                   |
| `inspector-filter-failed`  | Inspector filter: Failed                    |
| `inspector-raw-files`      | Inspector "Raw files"                       |
| `prs-refresh`              | Pull Requests refresh (`data-loading`)      |
| `settings-tab-general`     | Settings → General                          |
| `settings-tab-clis`        | Settings → Agent CLI                        |
| `settings-tab-defaults`    | Settings → Agent defaults                   |
| `settings-tab-mcp`         | Settings → MCP Servers                      |
| `settings-tab-project`     | Settings → Project                          |
| `settings-tab-maintenance` | Settings → Maintenance                      |
| `settings-tab-about`       | Settings → About                            |

`app-view` attributes (read via `dataset`, no snapshot):

| Attribute            | When set        | Values                                                            |
| -------------------- | --------------- | ----------------------------------------------------------------- |
| `data-view`          | always          | `runs` `run-detail` `inspector` `design` `prs` `settings`         |
| `data-open-run`      | run detail only | the full `run_*` id                                               |
| `data-design-tab`    | Design only     | `pipelines` `agents` `envelopes`                                  |
| `data-settings-pane` | Settings only   | `general` `clis` `defaults` `mcp` `project` `maintenance` `about` |

### Other driving notes

- Refs renumber on every snapshot; always re-snapshot after navigating. Prefer
  `data-view` over a snapshot when you only need to confirm arrival.
- There is exactly one CDP target (no webviews); `tab` shows one page.
- `click "text=..."` selectors are unreliable and slow; use `eval` with
  `data-testid` or `press` for all interaction.
- The UI is the dark Factory theme; screenshots are mostly black with
  light text. That is correct, not a rendering failure.
- Escape ladder: an open overlay (Dry run / Prompt preview) closes first;
  otherwise a focused field blurs; otherwise Run detail goes back to Runs.
- Tab strips (Design / Agents / Settings) are roving-tabindex tablists:
  focus the selected tab and use ArrowLeft/ArrowRight (wrap), Home/End;
  selection follows focus. Prefer the `settings-tab-*` / `tab-*` testids.
- **Do not `agent-browser wait --text` across a long-running refresh.** The
  CLI has been SIGKILL'd mid-wait while the app stayed up. Poll with `eval`
  instead (`[data-testid="prs-refresh"]` has `data-loading="true"` while gh
  is in flight). If a command is SIGKILL'd, `connect` again — do not relaunch.
- Keep `eval` scripts tiny. Combining screenshot + multi-statement eval in one
  shell call is how the CLI has been killed; split them.

## Navigation model

No URL routing; one window, view state in React. The left sidebar is always
present (except during Onboarding):

| Sidebar button              | View                           | CDP shortcut     |
| --------------------------- | ------------------------------ | ---------------- |
| `button "Runs ⌘1"`          | Runs list + run composer       | `press Meta+1`   |
| `button "Inspector ⌘2"`     | Live trace viewer              | `press Meta+2`   |
| `button "Design ⌘3"`        | Pipeline/agent/envelope editor | `press Meta+3`   |
| `button "Pull Requests ⌘4"` | PR list                        | `press Meta+4`   |
| `button "Settings ⌘,"`      | Settings panes                 | `press "Meta+,"` |

Design has three sub-tabs, each with its own shortcut:
`press 'Meta+Shift+1'` (Pipelines), `'Meta+Shift+2'` (Agents),
`'Meta+Shift+3'` (Envelopes).

The sidebar also has the project dropdown (`data-testid="project-selector"`,
shows the active project name) and the Add Project option inside it — **do not
trigger the Add Project flow in automation**: it opens a native folder picker
CDP cannot drive (if stuck, `press Escape` won't help; you must dismiss it
manually or kill the app).

**Do not click Smith** (`nav-smith`) unless you intend to launch the user's
preferred terminal. It is a handoff, not an in-app view — and with Ghostty
preferred it opens a window and spawns a real agent CLI immediately, with no
modal to back out of. The `SmithLauncher` modal appears only when that start
could not run (no project, a terminal that takes no command, a missing agent
CLI, or a failed launch).

## Screens

### Runs (home, default view)

- Heading "Runs", `checkbox "Show archived"`.
- Composer: `data-testid="run-request"` textarea, pipeline dropdown
  (`data-testid="run-pipeline"`), `data-testid="run-start"` button
  (disabled while the textarea is empty).
- One button per past run (`data-testid="run-row-{runId}"`); the visible
  label packs status, pipeline, age, prompt excerpt, `run_*` id, duration,
  tokens. Open it with eval on that testid, not by matching the packed label.

**Warning:** filling the composer and clicking "Start run" spawns real agent
CLIs and spends real tokens. Never start a run unless explicitly asked.

### Run detail

Open via `run-row-{runId}`. `data-view` becomes `run-detail` and
`data-open-run` is the full id. Contains:

- `data-testid="run-back"` (← Runs), `data-testid="run-open-inspector"`
  (deep-link this run into the Inspector).
- Outcome banner ("Accepted — 'review' approved the work", `merged` chip).
- Phase Gantt: one `button` per phase, labels like `planner plan 1m 34s`,
  `builder build ×2 3m 17s`, `commit_plan 1.1s`. Click to select a phase.
- Right pane for the selected phase: `phase-tab-timeline` / `envelope` /
  `gates` / `prompt` (visible labels include counts, e.g. `Timeline29`).
  Timeline rows are expandable buttons: `⚙ read: path`, `· assistant`,
  `$ cmd`, `⛨ gate_name`, `∑ agent` (envelope), `▸/→/▪` phase markers.

### Inspector

Live trace viewer, cards per phase in a two-column masonry. Top bar:

- `data-testid="inspector-run"` — bare navigation follows whatever is live;
  options list past runs (`Full SDLC · accepted · 04:51:20 · 12h ago`).
- Filters `inspector-filter-all` / `running` / `failed`, toggle
  `inspector-raw-files` (shows a flat chronological list of every file
  READ/EDIT/CREATE/SEARCH and `$` command across the run; toggle again to
  go back).
- `⤢` buttons expand individual tool-call cards.

### Design (Pipelines / Agents / Envelopes)

Three sub-tabs under one view, switched via `Meta+Shift+1/2/3` or
`data-testid="tab-pipelines"`, `tab-agents`, `tab-envelopes`.

**Pipelines** (`tab-pipelines`):

- Pipeline picker: `data-testid="pipeline-selector"` (shows current pipeline
  name + phase count), `data-testid="pipeline-option-{id}"` per pipeline,
  `data-testid="pipeline-new"` to create one.
- Editor: name/description textboxes (`aria-label="Pipeline name"`,
  `aria-label="Pipeline description"`), a horizontal phase ribbon, add
  buttons Agent / Command / Checkpoint.
- `Dry run` opens an overlay showing the exact SYSTEM/USER prompt each agent
  phase would receive. Nothing is sent; safe to click. Close with `Esc`.
- Edits save automatically; validation status bottom-left.

**Agents** (`tab-agents`):

- Agent tabs: `data-testid="agent-tab-{name}"` (e.g. `agent-tab-builder`).
  `data-testid="agent-new"` to create one.
- `Preview prompt` — overlay with the rendered SYSTEM/USER prompt (safe,
  close with Esc). `Duplicate`.
- IDENTITY: `aria-label="Agent name"`, `aria-label="Agent purpose"`,
  accent color buttons.
- EXECUTION: CLI vendor combobox, model combobox + Refresh, reasoning-effort
  radios, envelope-kind combobox.
- PROMPTS: `aria-label="System prompt"` and `aria-label="User prompt template"`
  textareas.

Renaming a shipped agent copies it under the new name (pipelines keep
working); changing CLI vendor resets the model choice.

### Settings

Tabs (`settings-tab-{id}`): `General`, `Agent CLI`, `Agent defaults`,
`MCP Servers`, `Project`, `Maintenance`, `About`. `data-settings-pane`
mirrors the selected id (`clis` is the Agent CLI pane).

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
  **Do not click `Remove project`.**
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
  exited immediately. Check `pgrep -fl "electron \."` **and**
  `pgrep -fli "/Applications/Foundry.app"`. If only the packaged app is
  running, use `--user-data-dir` (see Launch). Do not kill Foundry.app.
- **"the launch keeps getting killed"**: check this before believing it. Run
  `pgrep -fl "electron \."` and `curl -s http://127.0.0.1:9250/json/version`.
  Plain `&` backgrounding survives across tool calls, so a vanished `$!` is
  usually `setsid` (absent on macOS), a fork, or `open -n -a` handing off to
  launchd — not the app dying. The most common real death is the packaged
  app winning the lock: DevTools printed, then the process is gone. See the
  traps under **Launch**. If the app is genuinely not running, the log you
  redirected to `/tmp/electron.log` says why; read it rather than switching
  to another harness.
- **`agent-browser` command SIGKILL'd**: the Electron app is usually still
  up. `connect` again and continue. Do not treat this as a launch failure.
- **Blank/stale UI after code changes**: `electron .` serves the last build;
  run `npm run build` and relaunch. For live HMR use `npm run dev` (but flag
  passthrough for the debug port is unreliable; prefer built launches).
- **Buttons do nothing**: an overlay (Dry run / Prompt preview / interrupt
  sheet) may be capturing input — `agent-browser press Escape` — or a native
  dialog is open, which CDP cannot see or dismiss.
- **electron binary missing** (`electron/dist` not installed):
  `node node_modules/electron/install.js`.
