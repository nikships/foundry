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
agent-browser press 'Meta+Shift+3'  # Design → Envelopes/Reports (+ data-design-tab="envelopes")

# Settings search palette, from any view (a dialog owns it while open):
agent-browser press Meta+k          # → [role=dialog] data-testid="settings-palette"

# Confirm where you are without a snapshot:
agent-browser eval 'const el = document.querySelector("[data-testid=\"app-view\"]"); el && {view: el.dataset.view, run: el.dataset.openRun, design: el.dataset.designTab, settings: el.dataset.settingsPane}'
```

Settings panes have no chord. Once on Settings, eval the tab — do not walk
ArrowDown from a guessed selected tab. Pane ids are `models`, `project`, `app`:

```bash
agent-browser eval 'document.querySelector("[data-testid=\"settings-tab-project\"]")?.click()'
# data-settings-pane becomes "project"
```

Legacy deep links still resolve but land elsewhere: `general`,
`maintenance`, and `about` normalize to `app`; everything else to
`models`. Prefer the current ids.

### `data-testid` reference

Stable selectors on key interactive elements. Use with `eval` +
`querySelector` for reliable, instant clicks:

Shell and sidebar:

| `data-testid`         | Element                                      |
| --------------------- | -------------------------------------------- |
| `app-view`            | `<main>` — current view + sub-state          |
| `nav-runs`            | Sidebar → Runs button                        |
| `nav-inspector`       | Sidebar → Inspector button                   |
| `nav-design`          | Sidebar → Design button                      |
| `nav-prs`             | Sidebar → Pull Requests button               |
| `nav-smith`           | Sidebar → Smith chat (safe to open)          |
| `nav-settings`        | Sidebar → Settings button                    |
| `sidebar-run-{runId}` | Activity row → opens run pinned in Inspector |
| `project-selector`    | Project dropdown trigger                     |
| `sidebar-collapse`    | Collapse/expand sidebar toggle               |
| `companion-pill`      | Companion phone pill (`data-running`)        |

Runs:

| `data-testid`      | Element                                   |
| ------------------ | ----------------------------------------- |
| `run-request`      | Run composer request textarea (⌘↵ starts) |
| `run-pipeline`     | Run composer pipeline dropdown            |
| `run-start`        | "Start run" button                        |
| `runs-archived`    | "Show archived" checkbox                  |
| `readiness-banner` | Readiness strip (`data-ready` yes/no)     |
| `base-sync`        | Local base-ref vs remote status bar       |
| `base-sync-update` | Fast-forward the local base ref           |
| `base-sync-check`  | Re-fetch and compare the remote base ref  |
| `run-row-{runId}`  | One past-run row on Runs                  |

Run detail:

| `data-testid`          | Element                                     |
| ---------------------- | ------------------------------------------- |
| `run-back`             | ← Runs button                               |
| `run-open-inspector`   | Deep-link this run into the Inspector       |
| `run-kill`             | Kill run (live runs only; in-app confirm)   |
| `phase-lane-{phaseId}` | Waterfall phase lane (`data-phase-name`)    |
| `outcome-resume`       | Outcome banner → Continue run               |
| `outcome-fix-merge`    | Outcome banner → Fix & merge with agent     |
| `outcome-open-pr`      | Outcome banner → Open PR… form toggle       |
| `pr-title` / `pr-body` | Inline PR form inputs                       |
| `pr-create`            | Inline PR form submit                       |
| `outcome-merge`        | Merge branch into base ref (in-app confirm) |
| `outcome-discard`      | Discard worktree + branch (in-app confirm)  |
| `phase-tab-timeline`   | Phase drawer → Timeline                     |
| `phase-tab-envelope`   | Phase drawer → Envelope                     |
| `phase-tab-gates`      | Phase drawer → Gates                        |
| `phase-tab-prompt`     | Phase drawer → Prompt                       |

Inspector:

| `data-testid`              | Element                                    |
| -------------------------- | ------------------------------------------ |
| `inspector-run`            | Run picker (bare nav follows what is live) |
| `inspector-filter-all`     | Filter: All                                |
| `inspector-filter-running` | Filter: Running                            |
| `inspector-filter-failed`  | Filter: Failed                             |
| `inspector-raw-files`      | Raw files toggle                           |
| `inspector-collapse-all`   | Collapse every visible tool call           |
| `inspector-lanes`          | Lane-density range slider (1–6)            |

Pull Requests:

| `data-testid`     | Element                                        |
| ----------------- | ---------------------------------------------- |
| `prs-refresh`     | Refresh (`data-loading` while gh is in flight) |
| `prs-merge-{n}`   | Merge button for PR #n (**native confirm**)    |
| `prs-method-{n}`  | Merge-method dropdown for PR #n                |
| `prs-fix-{n}`     | Fix-with-agent on a conflicting foundry PR     |
| `prs-run-tag-{n}` | "foundry run" tag → open the run               |

Design:

| `data-testid`                                     | Element                                         |
| ------------------------------------------------- | ----------------------------------------------- |
| `tab-pipelines`                                   | Design → Pipelines tab                          |
| `tab-agents`                                      | Design → Agents tab                             |
| `tab-envelopes`                                   | Design → Envelopes tab (labelled Reports)       |
| `pipeline-selector`                               | Pipeline picker trigger                         |
| `pipeline-option-{id}`                            | Pipeline option in the picker dropdown          |
| `pipeline-new`                                    | New pipeline button                             |
| `pipeline-add-agent` / `-command` | Ribbon add buttons                              |
| `pipeline-phase-{name}`                           | Phase card on the canvas                        |
| `pipeline-dry-run`                                | Dry run overlay opener (safe, Esc closes)       |
| `pipeline-settings`                               | Pipeline acceptance/validation sheet opener     |
| `agent-tab-{name}`                                | Agent roster tab (e.g. `agent-tab-builder`)     |
| `agent-new`                                       | "+ New agent" button                            |
| `agent-preview`                                   | Prompt preview overlay opener (safe, Esc)       |
| `agent-duplicate`                                 | Duplicate agent                                 |
| `agent-delete`                                    | Delete agent (custom agents only)               |
| `agent-reset`                                     | Reset edited builtin to shipped version         |
| `agent-mark-picker`                               | Agent mark/emblem picker overlay                |
| `envelope-new`                                    | Reports → New report                            |
| `envelope-item-{name}`                            | Custom report in the library rail               |
| `envelope-builtin-{kind}`                         | Built-in report inspector entry (e.g. `review`) |

Smith (chat screen + titlebar launcher):

| `data-testid`                                 | Element                              |
| --------------------------------------------- | ------------------------------------ |
| `smith-input` / `smith-send` / `smith-cancel` | Screen composer (send spends tokens) |
| `smith-model`                                 | Header model picker                  |
| `smith-new-chat`                              | New chat (wipes the conversation)    |
| `smith-transcript`                            | Chat transcript container            |
| `smith-proposal-card`                         | Inline entity-approval card          |
| `smith-proposal-approve`                      | Approve + save the proposed entity   |
| `smith-proposal-reject`                       | Reject (unblocks Smith to revise)    |
| `smith-bubble`                                | Titlebar launcher on other screens   |
| `smith-bubble-input` / `-send` / `-cancel`    | Bubble composer                      |
| `smith-bubble-expand`                         | Bubble → full Smith screen           |
| `smith-bubble-close`                          | Dismiss the bubble                   |

Settings:

| `data-testid`            | Element                                |
| ------------------------ | -------------------------------------- |
| `settings-tab-models`    | Settings → Models & Providers          |
| `settings-tab-project`   | Settings → Project                     |
| `settings-tab-app`       | Settings → App                         |
| `settings-search`        | Rail search input                      |
| `settings-palette`       | ⌘K palette dialog                      |
| `settings-palette-input` | ⌘K palette input                       |
| `bridge-status`          | Bridge running/unavailable pill        |
| `provider-card-{id}`     | Subscription provider card             |
| `provider-key-{id}`      | Direct API-key card (e.g. `anthropic`) |
| `providers-model-count`  | Reachable/hidden model count line      |
| `reset-hidden-models`    | Un-hide all models                     |
| `hide-model-{id}`        | Hide one model row                     |

Overlays and decisions:

| `data-testid`                         | Element                                        |
| ------------------------------------- | ---------------------------------------------- |
| `confirm-accept`                      | In-app ConfirmModal primary action             |
| `confirm-cancel`                      | In-app ConfirmModal cancel                     |
| `onboarding-step-{id}`                | Stepper pill: welcome/providers/doctor/project |
| `onboarding-back` / `onboarding-next` | Step footer buttons                            |
| `onboarding-provider-{id}`            | Onboarding provider row                        |
| `update-dismiss`                      | Update banner ✕                                |

`app-view` attributes (read via `dataset`, no snapshot):

| Attribute            | When set        | Values                                                            |
| -------------------- | --------------- | ----------------------------------------------------------------- |
| `data-view`          | always          | `runs` `run-detail` `inspector` `design` `prs` `smith` `settings` |
| `data-open-run`      | run detail only | the full `run_*` id                                               |
| `data-design-tab`    | Design only     | `pipelines` `agents` `envelopes`                                  |
| `data-settings-pane` | Settings only   | `models` `project` `app`                                          |

### Other driving notes

- Refs renumber on every snapshot; always re-snapshot after navigating. Prefer
  `data-view` over a snapshot when you only need to confirm arrival.
- There is exactly one CDP target (no webviews); `tab` shows one page.
- `click "text=..."` selectors are unreliable and slow; use `eval` with
  `data-testid` or `press` for all interaction.
- The UI is the dark Factory theme; screenshots are mostly black with
  light text. That is correct, not a rendering failure.
- Escape ladder: an open dialog (⌘K palette / confirm /
  Dry run / Prompt preview) closes first; otherwise a focused
  field blurs; otherwise Run detail goes back to Runs.
- Tab strips (Design / Agents / Settings) are roving-tabindex tablists:
  focus the selected tab and use ArrowLeft/ArrowRight (wrap), Home/End;
  selection follows focus. Prefer the `settings-tab-*` / `tab-*` testids.
- Two kinds of confirm exist. The **in-app ConfirmModal** (`confirm-accept` /
  `confirm-cancel`) backs kill run, merge/discard worktree, deletes — drive it
  by testid. A **native `window.confirm`** (PR merge on the PRs screen)
  renders outside the DOM; CDP cannot see or answer it. Avoid actions that
  trigger the native one unless a human is present.
- **Do not `agent-browser wait --text` across a long-running refresh.** The
  CLI has been SIGKILL'd mid-wait while the app stayed up. Poll with `eval`
  instead (`[data-testid="prs-refresh"]` has `data-loading="true"` while gh
  is in flight). If a command is SIGKILL'd, `connect` again — do not relaunch.
- Keep `eval` scripts tiny. Combining screenshot + multi-statement eval in one
  shell call is how the CLI has been killed; split them.

## Navigation model

No URL routing; one window, view state in React. The left sidebar is always
present (except during Onboarding):

| Sidebar button              | View                           | CDP shortcut            |
| --------------------------- | ------------------------------ | ----------------------- |
| `button "Runs ⌘1"`          | Runs list + run composer       | `press Meta+1`          |
| `button "Inspector ⌘2"`     | Live trace viewer              | `press Meta+2`          |
| `button "Design ⌘3"`        | Pipeline/agent/envelope editor | `press Meta+3`          |
| `button "Pull Requests ⌘4"` | PR list                        | `press Meta+4`          |
| `button "Smith"`            | In-app Smith chat              | none — eval `nav-smith` |
| `button "Settings ⌘,"`      | Settings panes                 | `press "Meta+,"`        |

Design has three sub-tabs, each with its own shortcut:
`press 'Meta+Shift+1'` (Pipelines), `'Meta+Shift+2'` (Agents),
`'Meta+Shift+3'` (Envelopes — the tab labelled **Reports**).

⌘K (`press Meta+k`) opens the Settings search palette from any view — a
`[role=dialog]` you can drive by keyboard (`fill` its input, ArrowUp/Down,
Enter). A dialog being open suppresses ⌘K, so close overlays first.

The sidebar also carries:

- the project dropdown (`data-testid="project-selector"`) with an
  Add/Create split option inside it — **do not trigger Add Project in
  automation**: it opens a native folder picker CDP cannot drive (if stuck,
  `press Escape` won't help; you must dismiss it manually or kill the app);
  the Create-New half opens the in-app `NewProjectWizard`, which _is_ drivable;
- the Activity list while runs exist: one row per live + recent run of the
  currently selected project (hidden when the rail is collapsed or there are
  no rows), `data-testid="sidebar-run-{runId}"`. Click pins Inspector and does
  not change the project picker.

**Smith (`nav-smith`) is safe to open** — it is a native chat view
(`data-view="smith"`), not a terminal handoff. What costs tokens is _sending_
messages (`smith-send` / `smith-bubble-send`): they run real agent turns on the
bundled pi runtime. Opening the screen, reading the transcript
(`smith-transcript`), and answering the inline proposal card are all free.
Entity writes always gate on `smith-proposal-card` regardless of how the chat
was driven.

## Screens

### Runs (home, default view)

- Heading "Runs", `checkbox "Show archived"` (`runs-archived`), companion
  phone pill (`companion-pill`, `data-running`).
- Composer: `data-testid="run-request"` textarea (⌘↵ submits — do not type a
  request and press Enter blindly), pipeline dropdown (`run-pipeline`),
  `run-start` button (disabled while the textarea is empty).
- Base-ref bar (`data-testid="base-sync"`, `data-state` is `checking` /
  `syncing` / `current` / `behind` / `ahead` / `diverged` / `error`):
  fetches the remote base on mount. When behind, `base-sync-update`
  fast-forwards local `main`; otherwise `base-sync-check` re-fetches.
  Hidden when the repo has no remote. Does not block Start except while
  an update is in flight.
- One button per past run (`data-testid="run-row-{runId}"`); the visible
  label packs status, pipeline, age, prompt excerpt, `run_*` id, duration,
  tokens. Open it with eval on that testid, not by matching the packed label.

**Warning:** filling the composer and clicking "Start run" (or ⌘↵) executes a
real pipeline on real models and spends real tokens. Never start a run unless
explicitly asked.

### Run detail

Open via `run-row-{runId}`. `data-view` becomes `run-detail` and
`data-open-run` is the full id. Contains:

- `data-testid="run-back"` (← Runs), `run-open-inspector` (deep-link this run
  into the Inspector), and `run-kill` on live runs only.
- Outcome banner for finished runs: status headline, and when the worktree
  still exists, action buttons — `outcome-resume`, `outcome-fix-merge`,
  `outcome-open-pr` (opens an inline form: `pr-title`, `pr-body`,
  `pr-create`), `outcome-merge`, `outcome-discard`. Merge/discard raise the
  in-app confirm (`confirm-accept` answers it). A merged run shows a
  `merged` chip instead.
- Phase waterfall: one lane per phase, `phase-lane-{phaseId}` with
  `data-phase-name`. Click to select; labels like `planner ×2`.
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
- Footer: `inspector-collapse-all` collapses every visible tool call;
  `inspector-lanes` (a range input) sets lanes per viewport (1–6).
- One lane per phase in a horizontal row; scroll horizontally for the rest.

### Design (Pipelines / Agents / Envelopes)

Three sub-tabs under one view, switched via `Meta+Shift+1/2/3` or
`data-testid="tab-pipelines"`, `tab-agents`, `tab-envelopes` (labelled
**Reports**). A header badge shows whether entities are Global or
project-scoped.

**Pipelines** (`tab-pipelines`):

- Pipeline picker: `pipeline-selector` (current pipeline + phase count),
  `pipeline-option-{id}` per pipeline, `pipeline-new` to create one.
- Canvas: one card per phase (`pipeline-phase-{name}`), add buttons
  `pipeline-add-agent` / `-command`; the phase editor opens
  in a right-hand sheet.
- `pipeline-dry-run` shows the exact SYSTEM/USER prompt each agent phase
  would receive. Nothing is sent; safe to click. Close with `Esc`.
- `pipeline-settings` opens acceptance/validation settings.
- Edits save automatically; validation status bottom-left.

**Agents** (`tab-agents`):

- Agent tabs: `agent-tab-{name}` (e.g. `agent-tab-builder`);
  `agent-new` to create one.
- Header actions: `agent-preview` (rendered SYSTEM/USER prompt overlay,
  safe, close with Esc), `agent-duplicate`, `agent-delete` (custom agents),
  `agent-reset` (edited builtins).
- Identity: mark picker (`agent-mark-picker`), `aria-label="Agent name"`
  (renames commit on blur/Enter), `aria-label="Agent purpose"`, accent
  swatches.
- Execution: "Inherit model and reasoning" checkbox, model picker,
  reasoning-effort radio group, report-kind dropdown ("Manage reports…"
  cross-links to the Envelopes tab).
- Prompts: `aria-label="System prompt"` and
  `aria-label="User prompt template"` textareas. Tools & write boundary:
  tool-surface dropdown plus path boundary editor.

Renaming a shipped agent copies it under the new name (pipelines keep
working). Edits autosave after ~350 ms when valid; errors block the save.

**Reports** (`tab-envelopes`):

- Library rail: customs as `envelope-item-{name}`, built-ins as
  `envelope-builtin-{kind}` (inspect-only JSON preview).
- `envelope-new` starts a blank custom report; starter templates appear when
  the library is empty. Field editor + live JSON preview; Delete goes through
  the in-app confirm and reports where the envelope is still used.

### Smith

Native chat with Foundry's entity-smith, on a dedicated screen
(`nav-smith` → `data-view="smith"`) plus a launcher docked at the right end of
the titlebar band on every other screen (`smith-bubble`; hidden while the
screen is open), whose popover hangs below it. One persistent conversation per
project.

- Screen: composer `smith-input` (Enter sends, Shift+Enter newline),
  `smith-send` / `smith-cancel` while running, `smith-model` picker,
  `smith-new-chat` (wipes the conversation), transcript in
  `smith-transcript`.
- Launcher popover: `smith-bubble-input/-send/-cancel`, `smith-bubble-expand`
  opens the full screen (carrying context about where you were),
  `smith-bubble-close`.
- Entity writes arrive as an inline `smith-proposal-card` at the transcript
  tail showing create/overwrite plus the full definition; answer with
  `smith-proposal-approve` / `smith-proposal-reject`. Approving saves the
  entity and deep-links Design to its editor.
- Sending any message runs real agent turns on the configured model — same
  warning as starting a run: do not send unless explicitly asked. Reading is
  free.

### Settings

Three panes on a left rail (`settings-tab-{id}`, mirrored by
`data-settings-pane`): `models` (Models & Providers), `project`, `app`.

- Models & Providers: Bridge status pill (`bridge-status`), subscription
  provider cards (`provider-card-{id}`) with Connect/Disconnect (connect
  opens the system browser — fine; sign-in completes back in the app),
  direct API-key cards (`provider-key-{id}`), model catalog with
  hide buttons (`hide-model-{id}`, `reset-hidden-models`,
  count line `providers-model-count`). Agent defaults (model, reasoning,
  helper model, Smith model, PR writer) and Advanced limits sit below on
  the same pane.
- Project: name, path + `Reveal in Finder`, readiness note, repository
  checks + re-check, base ref, merge policy, base-ref sync bar (`base-sync`
  — same control as Runs), project commands, worktree setup script,
  protected paths. **Do not click `Remove project`** (in-app confirm).
- App: environment checks + re-check, notification toggles, software-update
  controls, companion phone pairing (QR), Retention (`Apply retention now`,
  `Compact trace databases` — both confirm first) and leftover worktrees
  with destructive `Remove` buttons; build info and `Relaunch Foundry` /
  `Quit Foundry` (never click those two in automation).
- Search: rail input `settings-search`, or ⌘K from anywhere for the
  palette (`settings-palette`) whose entries can jump panes or flip toggles
  in place.

Deep-linking: Runs surfaces problems as "Open Settings" links that land on a
specific pane.

### Onboarding

Shown instead of the whole shell when settings have `onboarded: false`
(always on a fresh `--user-data-dir`). Stepper pills
`onboarding-step-{id}`: `welcome` → `providers` → `doctor` → `project`;
footer buttons are `onboarding-back` / `onboarding-next` on every step.

- Welcome: intro, Begin/Continue.
- Providers: connect a model provider — OAuth rows (`onboarding-provider-{id}`)
  open the system browser and complete in-app, or paste an API key. The model
  catalog is `data-testid="onboarding-models"`.
- Ready (doctor): per-provider/per-CLI checks, `Re-check environment`,
  Continue.
- Project: pick from detected repositories, or `Choose a repository…`
  (**native folder picker — automation dead end**) and `Enter Foundry`
  (disabled until a repo is chosen). To test the main UI without picking a
  repo, use the real state instead, or pre-seed the temp dir's
  `settings.json` with `"onboarded": true`.

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
- **Buttons do nothing**: an overlay (⌘K palette, Dry run, Prompt preview,
  confirm modal) may be capturing input — `agent-browser press Escape`.
  A native dialog (PR-merge confirm, folder picker) is open? CDP can neither
  see nor dismiss it.
- **electron binary missing** (`electron/dist` not installed):
  `node node_modules/electron/install.js`.
