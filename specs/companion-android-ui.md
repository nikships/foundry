# Companion Android UI and Information Architecture (FOU-82)

Visual and structural source of truth for FOU-84–FOU-91. The companion is a
remote **operator surface** for a paired Foundry desktop: pair, watch, start,
inspect, open the PR. It is not a second factory. Anything not written here is
out of scope for the companion.

Desktop references translated (not cloned): `RunsScreen`, `RunDetailScreen`
(+ `Waterfall`, `PhaseDrawer`, `OutcomeBanner`), `InspectorScreen`
(+ `TranscriptLane`), and the `tokens-base.css` / `tokens-factory.css` design
tokens.

Low-fidelity frames for the six screens live alongside this spec in the PR for
FOU-82 (also posted on the Linear ticket). Fidelity is rough on purpose; the
information architecture is not.

---

## 1. Information architecture

### 1.1 Screen map

```
Pair (only screen while unpaired)
 └─ pairing succeeds →

Home / Runs (root, the only root)
 ├─ [Start a run] → New Run (full-screen, dismissible)
 │                    └─ started → Run (operator), New Run popped
 ├─ tap any run row → Run (operator)
 │                      └─ [Inspector] → Inspector (one phase at a time)
 └─ connection pill (top bar) → Connection sheet (bottom sheet, over anything)
```

### 1.2 Navigation: stack, not tabs

A single back-stack (one activity, Compose `NavHost`). **No bottom tab bar.**

Rationale: there are only two peer destinations (list, run) plus one composer
and one sheet. Tabs would either invent destinations to fill slots (a settings
maze) or ship half-empty. Everything is at most two taps from Home, and the
system back gesture always walks toward Home.

- **Home / Runs** is the root. Back from Home exits the app.
- **New Run** pushes over Home. Back/X dismisses; a draft request survives
  process death (saved-state) but is discarded on explicit dismiss.
- **Run (operator)** pushes over Home. Reached from a live run and from
  history the same way: tap the row. There is no separate "live" screen —
  the same screen renders live and settled states.
- **Inspector** pushes over Run. It is only reachable through a run (from the
  Run screen's Inspector action), never from Home directly; the run row is the
  operator view's front door, and the Inspector is the depth behind it.
- **Connection sheet** is a modal bottom sheet available from the top app bar
  on Home, Run, and Inspector. It is not a stack entry; back closes it.
- **Engineer interrupt** is a high-priority modal sheet that can appear over
  any screen while paired (see 3.7). It is not a destination.

Deep links (from notifications): `foundry://run/<runId>` opens Run (operator)
with Home synthesized beneath it so back behaves normally.

### 1.3 Operator view vs. Inspector

Two views of one run, both first-class, deliberately different jobs:

|                     | Run (operator)                                                                           | Inspector                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Question it answers | "How is the run doing? What do I do next?"                                               | "What is the agent actually doing right now?"                |
| Unit                | the whole run                                                                            | one phase at a time                                          |
| Content             | request, status, duration, tokens, phase waterfall, selected-phase summary, outcome card | full live transcript of a single phase, tool calls collapsed |
| Actions             | Kill (live), Open PR (settled), answer interrupt                                         | follow the tail, expand a tool call, jump phases             |

Switching, from a **live run**: Home pins the live run at the top → tap it →
Run (operator) → top-bar `Inspector` action → Inspector opens **on the
currently running phase**, tailing. From **history**: same path; Inspector
opens on the first failed phase if any, otherwise the last phase. Back from
Inspector always returns to the same Run screen. Selecting a phase in the
operator waterfall and then opening the Inspector opens _that_ phase.

### 1.4 Connection model (UI contract)

The desktop is the source of truth; the phone renders desktop state and sends
commands (start, kill, interrupt answer, PR actions). Every screen below
defines behavior for these connection states:

- **Unpaired** — no stored pairing. Only the Pair screen exists.
- **Connected** — live socket/poll to the paired desktop.
- **Reconnecting** — pairing stored, transport lost (desktop asleep, app
  quit, phone off Wi-Fi). Non-blocking amber banner under the top bar on
  every screen: _"Reconnecting to ⟨desktop name⟩…"_, with cached data still
  shown and greyed timestamps. Auto-retry with backoff; the banner offers
  `Retry now`.
- **Offline (gave up)** — same banner after sustained failure, copy shifts to
  _"Can't reach ⟨desktop name⟩. Is Foundry running on the same Wi-Fi?"_ plus
  `Retry` and `Connection…` (opens the sheet, which owns Unpair). Mutating
  actions (Start, Kill, interrupt answers, PR actions) are disabled while not
  connected — the phone never queues writes.

Unpair (from the Connection sheet, confirmed) wipes the token and cache and
resets the stack to Pair.

---

## 2. Visual system

### 2.1 Palette (from `tokens-factory.css`, verbatim)

Flat industrial blacks, hairline borders, one orange. No gradients, glows, or
elevation shadows; sheets separate with `surface-raised` + a hairline. Dark
only — the desktop has no light theme, so the companion forces dark and
ignores the system light setting.

| Token         | Value         | Use                                                                          |
| ------------- | ------------- | ---------------------------------------------------------------------------- |
| `bg-base`     | `#020202`     | screen background                                                            |
| `bg-panel`    | `#0A0A0A`     | cards, list rows                                                             |
| `bg-raised`   | `#101010`     | sheets, chips, buttons                                                       |
| `bg-input`    | `#050505`     | text fields                                                                  |
| `line`        | `#FFFFFF` 9%  | hairlines (1dp)                                                              |
| `line-strong` | `#FFFFFF` 18% | interactive borders                                                          |
| `text`        | `#EEEEEE`     | primary text                                                                 |
| `text-dim`    | `#8C8C8C`     | secondary text                                                               |
| `text-faint`  | `#FFFFFF` 32% | tertiary/meta text                                                           |
| `accent`      | `#EE6018`     | Factory orange: running state, primary emphasis, live tail caret. Sparingly. |

### 2.2 Status color mapping (must match desktop semantics)

Run status (`RunStatus`):

| Status     | Color                    | Token source                         |
| ---------- | ------------------------ | ------------------------------------ |
| `running`  | orange `#EE6018`         | `--status-running: var(--accent)`    |
| `accepted` | green `#34D399`          | `--status-accepted: var(--green)`    |
| `rejected` | amber `#F5A623`          | `--status-rejected: var(--amber)`    |
| `failed`   | red `#EF4444`            | `--status-failed: var(--red)`        |
| `killed`   | faint grey `#FFFFFF` 32% | `--status-killed: var(--text-faint)` |

Phase status (`PhaseStatus`): `queued` faint grey, `running` orange, `success`
green, `fail` red, `skipped` faint grey — same tokens as the desktop
(`--status-queued`…`--status-skipped`).

Status is always rendered as the desktop's `StatusBadge`: uppercase mono
label + leading dot, tinted text on a 14% tint of the same color. `running`
pulses its dot; nothing else animates.

### 2.3 Type scale

Geist and Geist Mono (both OFL, already vendored in the repo) mapped from
desktop px to sp:

| Role                                        | Face                                             | Size       | Desktop source                     |
| ------------------------------------------- | ------------------------------------------------ | ---------- | ---------------------------------- |
| Screen title                                | Geist 600                                        | 22sp       | `--text-xl`                        |
| Request text (run header)                   | Geist 400                                        | 16sp / 1.5 | `--text-base`                      |
| Body, list primary                          | Geist 400                                        | 14sp / 1.5 | `--text-sm`                        |
| Meta (duration, tokens, branch, timestamps) | Geist Mono 400, tabular                          | 12sp       | `--text-xs`, `.mono`               |
| Labels, buttons, badges                     | Geist Mono 500–600, UPPERCASE, +0.08em           | 11sp       | `--label-size`, `--label-tracking` |
| Eyebrow (numbered section header)           | Geist Mono 600, UPPERCASE, +0.16em, orange index | 10sp       | `.eyebrow`                         |
| Transcript text                             | Geist Mono 400                                   | 13sp / 1.5 | `TranscriptLane`                   |

Never below 10sp. Respect the OS font-scale setting; layouts are written to
survive 1.3×.

### 2.4 Density and shape

- Spacing on the desktop 4dp grid: 4/8/12/16/24/32 (`--s1…--s8`).
- Near-square corners: 4dp cards and buttons, 6dp sheets (`--r`, `--r-lg`).
  No pill buttons; `999` radius is reserved for true circles (status dots).
- List rows min 64dp tall; touch targets ≥ 48×48dp even where the glyph is
  smaller.
- Motion: quick and mechanical, 120–150ms standard-easing fades/slides only
  (`--fast`/`--normal`). Honor "remove animations" accessibility setting.
  The only persistent animation is the running-status pulse.

---

## 3. Screens

Every screen states: purpose, primary action, empty state, error/offline
state.

### 3.1 Pair

**Purpose:** get from install to paired in one motion. No account, no forms.

Layout: full-bleed camera viewfinder with a square scan reticle, one line of
instruction above — _"Scan the QR code in Foundry → Settings → Companion"_ —
and the Foundry wordmark. Nothing else.

- **Primary action:** scanning is the action; there is no button to press.
  The screen requests camera permission on entry.
- **Empty state ("Foundry is waiting"):** camera permission denied or no
  camera. The viewfinder is replaced by a static card: _"Foundry is waiting
  on your Mac. Allow camera access to scan its pairing code."_ with
  `Open app settings`. There is deliberately no manual code entry in v1; the
  QR is the only pairing path (epic: "Pairing is QR-only").
- **Error / offline state:** a scanned code that is expired, malformed, or
  unreachable (wrong network) shows an inline red strip under the reticle —
  _"That code didn't work. Foundry shows a fresh one in Settings →
  Companion."_ / _"Found the code, but can't reach the desktop — is this
  phone on the same Wi-Fi?"_ — and keeps scanning. No dead-end dialogs.
- **Success:** brief confirmation ("Paired with ⟨desktop name⟩"), then
  replace the stack with Home.

### 3.2 Home / Runs

**Purpose:** answer "is anything running, and what happened lately" at a
glance, and be the launch pad for a new run.

Layout, top to bottom:

- **Top app bar:** `Runs` eyebrow-style title; right side is the
  **connection pill** — desktop name + green/amber dot — which opens the
  Connection sheet. If more than one project is paired-visible, the focused
  project name renders under the title as a subtitle (read-only here;
  switching focus lives in the Connection sheet).
- **Live run card (pinned):** present only while a run is live. A raised
  card: `running` badge, pipeline name, request (2-line ellipsis), elapsed
  time ticking, a slim horizontal phase strip (one segment per phase, colored
  by phase status — a miniature of the waterfall, not interactive). Tap →
  Run (operator).
- **History list:** most recent first. Row = status badge + pipeline name +
  relative time, request (2-line ellipsis), meta line in mono (duration ·
  tokens · branch tail). Tap → Run (operator). No swipe actions; archive
  stays a desktop concern.
- **Primary action:** a **Start run** extended FAB (orange, bottom-right),
  visible in every list state. Opens New Run.
- **Empty state:** first pair, no runs yet: _"Nothing has run yet. Describe
  a change and pick a pipeline — every run is isolated in its own worktree
  on your Mac."_ + `Start a run` button. (FAB remains too.)
- **Error / offline state:** reconnecting/offline banner per 1.4; cached
  rows stay visible with faint timestamps and the FAB disabled with the
  reason as helper text (_"Reconnect to start a run"_). A list fetch error
  while connected shows an inline row-strip with `Retry`.

### 3.3 New Run

**Purpose:** compose exactly one thing: the request. Everything else is a
picker.

Full-screen (not a sheet — the keyboard owns half the screen), `X` to
dismiss. Content:

1. **Request** — multiline field, autofocused. Placeholder: _"What should
   the factory build? Be specific: the request is the whole brief."_
2. **Pipeline** — selector rows (radio behavior): pipeline name, its
   one-line description, and its **phase ribbon** (ordered chips of phase
   names with `→` connectors and `↩` on feedback edges, colored by phase
   kind — the desktop `PipelineRibbon` reflowed to wrap on narrow widths).
   The last-used pipeline is preselected.
3. **Project** — a chip row shown **only when more than one project is
   paired**; otherwise the single project renders as a static caption line.
4. **Start run** — full-width primary button pinned above the keyboard.
   Disabled until the request is non-empty, with the reason as helper text
   (mirrors desktop `startDisabledReason`: "Describe what to build" / "Fix
   pipeline errors first" / "Reconnect to start a run").

Deliberately absent: model choice, roster, envelopes, project commands,
readiness — the desktop preflights and owns all of it.

- **Primary action:** `Start run`. On tap: button shows "Starting…", the
  desktop validates; success replaces this screen with Run (operator).
- **Empty state:** no pipelines exist on the desktop (edge case):
  _"This project has no pipelines yet. Add one in Foundry on your Mac."_
  Start disabled.
- **Error / offline state:** desktop-side preflight/validation issues render
  as an inline issue list under the composer (level-tagged, exactly the
  desktop's `ValidationIssue` messages — the phone does not rewrite them).
  Connection lost while composing: banner appears, Start disables, the draft
  is kept.

### 3.4 Run (operator)

**Purpose:** the state of one run and the operator's verbs on it. One screen
for live and settled.

Layout, top to bottom:

- **Top app bar:** back (→ Home), `Run · ⟨pipeline⟩ · ⟨shortId⟩`, right-side
  `Inspector` action (icon + label). While live, `Kill` lives here as a red
  text action with a confirmation dialog (_"Kill this run? In-flight agent
  turns stop; the worktree branch is kept."_ — desktop copy verbatim).
- **Header block:** status badge + pipeline name, the full request
  (selectable, expandable past 4 lines), meta row in mono: elapsed/total
  duration (ticking while live) · total tokens · branch name (read-only on
  the phone).
- **Outcome card** (settled runs only, directly under the header — the phone
  translation of `OutcomeBanner`): status-tinted card with headline
  (Accepted / Not accepted / Failed / Killed), one-sentence explanation
  (desktop `outcome_detail` verbatim), and the PR affordance — see 3.4.1.
- **Phase waterfall:** vertical list, one lane per phase: kind dot/avatar,
  phase name, `×n` attempt marker, right-aligned duration, and a
  time-proportional bar in the phase's status color with tool/gate/interrupt
  tick marks. Lanes are compact (~40dp); the proportional bar reads relative
  effort, the vertical order reads sequence. Tapping a lane selects it.
- **Selected-phase summary** (bottom card, the phone's `PhaseDrawer`):
  phase name + status + duration + tokens + model, then the phase's headline
  facts: gate results (pass/fail with the gate name), envelope verdict/summary
  if one landed, last error message on failure. One `View transcript` button →
  Inspector opened on this phase. Default selection mirrors the desktop:
  running phase, else last failed, else first.

- **Primary action:** live → `Kill` is the only mutating action (top bar).
  Settled → the outcome card's PR button is primary.
- **Empty state:** run just started, no phase has begun: waterfall shows all
  lanes queued (faint) with _"Waiting for the first phase…"_ under the
  header.
- **Error / offline state:** reconnect banner per 1.4; while disconnected
  `Kill` and PR actions disable, data freezes with faint timestamps, and the
  elapsed timer stops rather than lying. A failed kill/PR command shows an
  inline red strip under the top bar with the desktop's error text.

#### 3.4.1 How a finished run presents its PR

Completion is a destination:

- Run **has a PR** (`prUrl` set): outcome card shows **`Open PR #N ↗`** as a
  primary-styled button → opens the phone browser (Custom Tab). This is the
  one-tap happy path, also the notification's tap target.
- Run **accepted/rejected without a PR** but with a live worktree: the card
  shows **`Create PR…`** which asks the desktop to push the branch and open a
  PR (desktop-drafted title/body; the phone offers no editor — confirm sheet
  shows the draft title read-only). Success swaps the button for
  `Open PR #N ↗`. If the desktop reports the GitHub CLI unavailable, the
  button is disabled with the desktop's `gh` detail line as helper text.
- Run **failed/killed**, or worktree already merged/discarded: no PR verb;
  the card links `Issue #N ↗` when the run filed one, else shows only the
  explanation. Merged runs show the desktop's `merged` badge.

Merge/discard of the worktree is **never** offered on the phone.

### 3.5 Inspector

**Purpose:** the live transcript, one phase at a time. Designed for a phone:
a single readable column, not six squeezed desktop lanes.

Layout:

- **Phase chip row** (horizontally scrollable, under the top bar): one chip
  per phase — status dot + phase name (+ `×n`). The selected chip is filled;
  the running phase's dot pulses. The row auto-scrolls to keep the selection
  visible. Horizontal swipe anywhere on the transcript pages between phases
  (chips and pager are the same selection).
- **Transcript** (the phone's `TranscriptLane`): a single vertical mono
  column of the phase's events in order. Agent text renders as prose blocks;
  **tool calls render collapsed by default** — a one-line row
  (`⚙ tool-name · duration · ✓/✕`) that expands in place to args + output,
  individually. Gate pass/fail, corrections, interrupts, and errors are
  colored one-liners (same glyph set as the desktop: `⚙ → ⛨ ↻ ☝ ✕`).
  A `Collapse all tool calls` text action sits at the top of the column.
- **Live tail:** while the selected phase is running, the column follows the
  tail with an orange caret; any upward scroll pauses following and shows a
  `↓ Live` jump-back chip. Switching to a settled phase lands at the top.
- **Top app bar:** back (→ Run), `Inspector · ⟨phase name⟩`, run status
  badge.

- **Primary action:** reading. The only affordances are phase switching,
  expand/collapse, and the jump-to-live chip.
- **Empty state:** selected phase is queued: _"This phase hasn't started
  yet."_ with the phase's position in the pipeline (_"runs after ⟨prev⟩"_).
- **Error / offline state:** reconnect banner per 1.4; the transcript keeps
  the cached tail and stops appending, and the live caret stops pulsing.
  A phase that ended in error shows the error entry inline in the transcript
  (it is data, not a dialog).

Not on the phone: envelope/gate/prompt JSON tabs, raw-files reveal, lane
count sliders. The Inspector is one phase, one column.

### 3.6 Connection sheet

**Purpose:** the answers to "what am I connected to" and the three controls
that legitimately live on the phone. It is a bottom sheet, not a Settings
app.

Contents, top to bottom:

1. **Desktop identity:** desktop name + connection status line
   (_"Connected · 192.168.x.x"_ / _"Reconnecting…"_ / _"Unreachable"_), with
   paired-since date in faint mono.
2. **Project in focus:** the project the list and composer follow. When the
   desktop exposes more than one paired project, this is a selector row;
   otherwise read-only.
3. **Notifications:** a single toggle — _"Notify when a run settles"_ —
   covering accepted/rejected/failed/killed and engineer-waiting alerts.
   Android channel-level splitting is left to the OS settings; the sheet
   holds exactly one switch.
4. **Unpair:** red text button, confirmation dialog (_"Unpair from
   ⟨desktop⟩? The phone forgets this desktop; nothing on the Mac is
   deleted."_). On confirm → wipe token + cache → Pair screen.
5. Fine print (faint mono): app version, desktop app version, protocol
   version.

- **Primary action:** none — it is informational; Unpair is the destructive
  exception.
- **Empty state:** n/a (the sheet cannot open while unpaired).
- **Error / offline state:** the status line _is_ the error surface; while
  unreachable, the project selector and notification toggle stay usable
  (local), Unpair stays usable (local wipe).

### 3.7 Engineer-waiting (interrupt), cross-cutting

Only a pipeline that declares an engineer phase raises this; a run never
stops to ask permission (desktop `InterruptSheet` contract). On the phone:

- A high-priority notification: _"⟨pipeline⟩ is waiting on you"_ (fires even
  with the settle toggle off — it blocks a run; it is not chatter).
- In-app: the affected run row/card on Home shows an amber `waiting` chip;
  the Run screen pins an amber strip above the header: _"An engineer phase
  is waiting for your answer."_ + `Answer…`.
- `Answer…` opens a modal sheet: the interrupt question, optional notes
  field, `Approve` (primary) and `Reject`. Dismissing the sheet does **not**
  answer — the strip persists (on the desktop Escape rejects; a phone swipe
  is too cheap a gesture to mean "reject").
- Offline: the strip shows but `Answer…` is disabled with _"Reconnect to
  answer"_.

---

## 4. Intentionally absent

Absent on purpose, so FOU-84–FOU-91 do not accrete them:

- **Pipeline editor / roster / envelope editor** — read-only pipeline
  ribbons only.
- **Worktree merge & discard, fix-merge-with-agent, open-in-Finder/terminal,
  raw files** — the phone links to GitHub; git surgery is a desk job.
- **Providers, Bridge, model pickers, API keys** — never rendered, not even
  read-only.
- **Readiness doctor, project commands, detection/setup flows** — desktop
  preflight errors surface as text in New Run, nothing more.
- **Smith, Design, Pull Requests board, archive management** — desktop
  surfaces.
- **Accounts, cloud, WAN access** — pairing is LAN-only by design.
- **iOS, tablets, landscape layouts** — phone portrait only for this epic.
- **Light theme** — the desktop is dark-only; the companion matches.

## 5. Implementation notes for FOU-84–FOU-91

- One activity, Compose navigation, routes: `pair`, `home`, `new-run`,
  `run/{runId}`, `run/{runId}/inspector?phase={phaseId}`; Connection sheet
  and interrupt sheet are overlays, not routes.
- All strings quoted in this spec are the contract copy; where the desktop
  already has copy (kill confirm, outcome explanations, validation issues,
  empty states), reuse it verbatim rather than rewording.
- Colors/type/spacing come from a single Kotlin token file mirroring
  `tokens-base.css` + `tokens-factory.css` (FOU-84); no ad-hoc hex values in
  screens.
- Status → color mapping in §2.2 is normative for badges, bars, chips, dots,
  and notification accents alike.
